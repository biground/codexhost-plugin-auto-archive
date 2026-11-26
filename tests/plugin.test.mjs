import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activate,
  DEFAULT_SETTINGS as BACKEND_DEFAULT_SETTINGS,
  evaluateThread,
  isRetryableCatalogError,
  normalizeSettings,
  readAllActiveThreads,
  readAllArchivedThreads,
  resolveThreadProject,
} from "../backend/index.mjs";
import {
  consumeNavigationIntent,
  DEFAULT_SETTINGS as SHARED_DEFAULT_SETTINGS,
  publishNavigationIntent,
  subscribeNavigationIntent,
} from "../shared/common.mjs";
import { parseSessionIdFromRowKey } from "../web/index.mjs";
import { DESKTOP_PAGE_ID, mount as mountWidget, openPluginPage, resolveWidgetClickTarget } from "../widget/index.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");
const CODEXHOST_CONTRACTS = path.resolve(
  PLUGIN_ROOT,
  "..",
  "agy-background-wake",
  "packages",
  "shared-contracts",
  "dist",
  "host-extensions.js",
);
const CODEXHOST_PKG_FILES = path.resolve(
  PLUGIN_ROOT,
  "..",
  "agy-background-wake",
  "packages",
  "harness-plugin-files",
  "dist",
  "host-extension-package.js",
);

test("manifest.json passes CodexHost official v2 schema and package validation", async () => {
  const { parseHostExtensionManifest } = await import(`file:///${CODEXHOST_CONTRACTS.replaceAll("\\", "/")}`);
  const { readLocalHostPackage, indexHostPackage, readHostManifest, validateHostPackageEntries } =
    await import(`file:///${CODEXHOST_PKG_FILES.replaceAll("\\", "/")}`);

  const rawManifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, "manifest.json"), "utf8"));
  const parsed = parseHostExtensionManifest(rawManifest);
  assert.equal(parsed.state, "valid", parsed.state === "valid" ? "" : parsed.error);

  // Stage only packaged files (mirroring ZIP contents) and run official package validator
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "aag-pkg-"));
  try {
    const manifest = parsed.manifest;
    const filesToCopy = [
      "manifest.json",
      "README.md",
      "LICENSE",
      manifest.icon,
      ...(manifest.screenshots ?? []),
      manifest.page.entry,
      manifest.page.style,
      manifest.widget.entry,
      manifest.widget.style,
      manifest.desktop.script,
      manifest.desktop.style,
      manifest.web.entry,
      manifest.web.style,
      manifest.backend.entry,
      "shared/common.mjs",
    ];
    for (const rel of filesToCopy) {
      const target = path.join(stageDir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(PLUGIN_ROOT, rel)));
    }
    const pkgFiles = await readLocalHostPackage(stageDir);
    const { digest } = indexHostPackage(pkgFiles);
    assert.match(digest, /^[a-f0-9]{64}$/u);
    const read = (resource) => {
      const buf = pkgFiles.get(resource);
      assert.ok(buf, `Missing resource in staged package: ${resource}`);
      return buf;
    };
    const loadedManifest = await readHostManifest(read);
    assert.equal(loadedManifest.id, "auto-archive-guard");
    const artwork = await validateHostPackageEntries(loadedManifest, read);
    assert.equal(artwork.icon.mime, "image/png");
    assert.equal(artwork.screenshots.length, 1);
    assert.equal(artwork.screenshots[0].mime, "image/png");
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
});

test("evaluateThread handles expiration, protection, running, and pinned guards", () => {
  const nowMs = Date.UTC(2026, 10, 24, 12, 0, 0);
  const settings = normalizeSettings({ retentionDays: 14, skipPinned: true });
  const base = {
    nowMs,
    settings,
    protectedSet: new Set(["t-protected"]),
    pinnedSet: new Set(["t-pinned"]),
    treeNodes: { "t-running": { status: "running", archived: false } },
    ownershipMap: new Map(),
  };

  const oldSec = Math.floor((nowMs - 20 * 86400_000) / 1000);
  const freshSec = Math.floor((nowMs - 3 * 86400_000) / 1000);

  const expired = evaluateThread({ id: "t-expired", name: "Old", updatedAt: oldSec }, base);
  assert.equal(expired.eligible, true);
  assert.equal(expired.skipReason, null);

  const kept = evaluateThread({ id: "t-protected", name: "Protected", updatedAt: oldSec }, base);
  assert.equal(kept.eligible, false);
  assert.equal(kept.skipReason, "protected");

  const pinned = evaluateThread({ id: "t-pinned", name: "Pinned", updatedAt: oldSec }, base);
  assert.equal(pinned.eligible, false);
  assert.equal(pinned.skipReason, "pinned");

  const running = evaluateThread({ id: "t-running", name: "Running", updatedAt: oldSec }, base);
  assert.equal(running.eligible, false);
  assert.equal(running.skipReason, "running");

  const fresh = evaluateThread({ id: "t-fresh", name: "Fresh", updatedAt: freshSec }, base);
  assert.equal(fresh.eligible, false);
  assert.equal(fresh.skipReason, "fresh");
});

test("backend archives only unprotected expired threads via local Host HTTP RPC and supports restore + protect", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aag-host-"));
  const clientHostsDir = path.join(tempRoot, "client-hosts");
  const extensionDataDir = path.join(tempRoot, "host-extension-data", "auto-archive-guard");
  await mkdir(clientHostsDir, { recursive: true });
  await mkdir(extensionDataDir, { recursive: true });

  const nowMs = Date.UTC(2026, 10, 24, 12, 0, 0);
  const oldSec = Math.floor((nowMs - 45 * 86400_000) / 1000);
  const freshSec = Math.floor((nowMs - 2 * 86400_000) / 1000);

  const archivedCalls = [];
  const unarchivedCalls = [];
  const token = "test-secret-token";

  const threads = [
    { id: "thr-old-1", name: "Old Session 1", updatedAt: oldSec, status: { type: "idle" } },
    { id: "thr-old-guarded", name: "Guarded Session", updatedAt: oldSec, status: { type: "idle" } },
    { id: "thr-old-running", name: "Running Session", updatedAt: oldSec, status: { type: "active" } },
    { id: "thr-old-pinned", name: "Pinned Session", updatedAt: oldSec, isPinned: true, status: { type: "idle" } },
    { id: "thr-fresh", name: "Fresh Session", updatedAt: freshSec, status: { type: "idle" } },
  ];

  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: -32001, message: "Unauthorized" } }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result = {};
      if (body.method === "codexhost/thread/catalog/read") {
        const active = threads.filter((t) => !archivedCalls.includes(t.id));
        result = {
          threads: active,
          ownership: active.map((t) => ({ threadId: t.id, owner: "external", harnessId: "antigravity" })),
          archivedThreadIds: archivedCalls,
          officialCursor: { live: null },
        };
      } else if (body.method === "codexhost/thread/pins/list") {
        result = { threadIds: ["thr-old-pinned"] };
      } else if (body.method === "codexhost/thread/tree/snapshot") {
        result = { nodes: {} };
      } else if (body.method === "thread/archive") {
        archivedCalls.push(body.params.threadId);
        result = { archived: true };
      } else if (body.method === "thread/unarchive") {
        unarchivedCalls.push(body.params.threadId);
        const idx = archivedCalls.indexOf(body.params.threadId);
        if (idx >= 0) archivedCalls.splice(idx, 1);
        result = { unarchived: true };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await writeFile(
    path.join(clientHostsDir, `host-${process.pid}-11111111-2222-4333-8444-555555555555.json`),
    JSON.stringify({
      version: 1,
      owner: "service",
      pid: process.pid,
      port,
      token,
      startedAt: nowMs,
      epoch: "11111111-2222-4333-8444-555555555555",
    }),
  );

  let storedSettings = {
    enabled: true,
    retentionDays: 3,
    dateField: "updatedAt",
    checkIntervalMinutes: 1440,
    graceMinutes: 30,
    skipPinned: true,
    showWidget: true,
  };
  let currentNow = nowMs;
  const handlers = new Map();
  const dispose = await activate(
    {
      extensionId: "auto-archive-guard",
      extensionDir: PLUGIN_ROOT,
      dataDir: extensionDataDir,
      readSettings: async () => structuredClone(storedSettings),
      writeSettings: async (values) => {
        storedSettings = structuredClone(values);
        return structuredClone(storedSettings);
      },
      handle: (method, fn) => handlers.set(method, fn),
    },
    { autoSchedule: false, now: () => currentNow },
  );

  try {
    // 1. Auto scan with 30m grace delay queues expired threads without archiving immediately
    const firstAuto = await handlers.get("runSweep")({ dryRun: false, trigger: "auto" });
    assert.equal(firstAuto.archivedCount, 0);
    assert.equal(firstAuto.queuedCount, 2);
    assert.deepEqual(archivedCalls, []);

    // 2. User protects thr-old-guarded during the 30-minute grace window
    const toggleRes = await handlers.get("toggleProtect")({
      threadId: "thr-old-guarded",
      protected: true,
      title: "Guarded Session",
    });
    assert.equal(toggleRes.protected, true);
    assert.deepEqual(toggleRes.protectedThreadIds, ["thr-old-guarded"]);

    // 3. Before 30m elapses (at +15m), still nothing archived
    currentNow = nowMs + 15 * 60_000;
    const midAuto = await handlers.get("runSweep")({ dryRun: false, trigger: "auto" });
    assert.equal(midAuto.archivedCount, 0);
    assert.deepEqual(archivedCalls, []);

    // 4. Dry run sees only thr-old-1
    const dryRes = await handlers.get("runSweep")({ dryRun: true });
    assert.equal(dryRes.eligibleCount, 1);
    assert.equal(dryRes.candidates[0].id, "thr-old-1");
    assert.deepEqual(archivedCalls, []);

    // 5. After 31 minutes, auto sweep archives only unprotected thr-old-1
    currentNow = nowMs + 31 * 60_000;
    const dueAuto = await handlers.get("runSweep")({ dryRun: false, trigger: "auto" });
    assert.equal(dueAuto.archivedCount, 1);
    assert.deepEqual(archivedCalls, ["thr-old-1"]);

    // 6. History recorded thr-old-1
    const state = await handlers.get("getState")();
    assert.equal(state.hostConnected, true);
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].threadId, "thr-old-1");

    // 7. Restore and protect thr-old-1
    const restoreRes = await handlers.get("unarchiveThread")({
      threadId: "thr-old-1",
      title: "Old Session 1",
      protect: true,
    });
    assert.equal(restoreRes.restored, true);
    assert.deepEqual(unarchivedCalls, ["thr-old-1"]);
    assert.ok(restoreRes.protectedThreadIds.includes("thr-old-1"));

    // 8. Next sweep archives nothing now
    const sweepAgain = await handlers.get("runSweep")({ dryRun: false, trigger: "manual" });
    assert.equal(sweepAgain.archivedCount, 0);
  } finally {
    await dispose();
    server.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("parseSessionIdFromRowKey accurately extracts Web session IDs and ignores non-session rows", () => {
  assert.equal(parseSessionIdFromRowKey("session:abc-123"), "abc-123");
  assert.equal(parseSessionIdFromRowKey("recent:def-456"), "def-456");
  assert.equal(parseSessionIdFromRowKey("linked:C:\\work\\proj:ghi-789"), "ghi-789");
  assert.equal(parseSessionIdFromRowKey("workspace:ws-1"), null);
  assert.equal(parseSessionIdFromRowKey("section:pinned"), null);
  assert.equal(parseSessionIdFromRowKey("overflow:flat"), null);
  assert.equal(parseSessionIdFromRowKey(""), null);
});

test("resolveThreadProject matches explicit assignments, longest rootPath prefix, and respects projectless", () => {
  const workspace = {
    projects: [
      { id: "p-root", name: "Workspace", rootPaths: ["C:\\work"] },
      { id: "p-sub", name: "CodexHost", rootPaths: ["C:\\work\\codex-host"] },
    ],
    assignments: { "t-assigned": "p-root" },
    projectlessSet: new Set(["t-projectless"]),
  };

  assert.deepEqual(
    resolveThreadProject({ id: "t-assigned", cwd: "C:\\work\\codex-host" }, workspace),
    { projectId: "p-root", projectName: "Workspace" },
  );
  assert.deepEqual(
    resolveThreadProject({ id: "t-sub", cwd: "c:\\work\\codex-host\\packages" }, workspace),
    { projectId: "p-sub", projectName: "CodexHost" },
  );
  assert.deepEqual(
    resolveThreadProject({ id: "t-projectless", cwd: "C:\\work\\codex-host" }, workspace),
    { projectId: null, projectName: "" },
  );
  assert.deepEqual(
    resolveThreadProject({ id: "t-unknown", cwd: "D:\\other" }, workspace),
    { projectId: null, projectName: "" },
  );
});

test("showWidget defaults to false across manifest, shared defaults, and backend defaults", async () => {
  const rawManifest = JSON.parse(await readFile(path.join(PLUGIN_ROOT, "manifest.json"), "utf8"));
  const showWidgetSchema = rawManifest.settingsSchema.find((item) => item.key === "showWidget");
  assert.ok(showWidgetSchema);
  assert.equal(showWidgetSchema.default, false);
  assert.equal(SHARED_DEFAULT_SETTINGS.showWidget, false);
  assert.equal(BACKEND_DEFAULT_SETTINGS.showWidget, false);
  assert.equal(normalizeSettings({}).showWidget, false);
  assert.equal(normalizeSettings({ showWidget: true }).showWidget, true);
});

test("resolveWidgetClickTarget routes to expiring when pending/expired exists and home otherwise", () => {
  assert.equal(resolveWidgetClickTarget({ expiredCount: 3, pendingCount: 0 }), "expiring");
  assert.equal(resolveWidgetClickTarget({ expiredCount: 0, pendingCount: 2 }), "expiring");
  assert.equal(resolveWidgetClickTarget({ expiredCount: 2, pendingCount: 1 }), "expiring");
  assert.equal(resolveWidgetClickTarget({ expiredCount: 0, pendingCount: 0 }), "home");
  assert.equal(resolveWidgetClickTarget(null), "home");
});

test("navigation intent publishes, consumes once, expires stale entries, and notifies subscribers", () => {
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  const listeners = new Map();
  const win = {
    sessionStorage: storage,
    CustomEvent: class FakeCustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.(event);
    },
  };

  // Cold-open path: publish then consume once
  publishNavigationIntent("expiring", { win, storage, now: 10_000, BroadcastChannel: null });
  assert.equal(consumeNavigationIntent({ win, storage, now: 12_000 }), "expiring");
  assert.equal(consumeNavigationIntent({ win, storage, now: 12_000 }), null);

  // Stale intent expires
  publishNavigationIntent("home", { win, storage, now: 10_000, BroadcastChannel: null });
  assert.equal(consumeNavigationIntent({ win, storage, now: 30_000, maxAgeMs: 15_000 }), null);

  // Live subscriber receives event immediately and clears stored intent
  const received = [];
  const ac = new AbortController();
  subscribeNavigationIntent((view) => received.push(view), ac.signal, {
    win,
    storage,
    BroadcastChannel: null,
  });
  publishNavigationIntent("expiring", { win, storage, now: 50_000, BroadcastChannel: null });
  publishNavigationIntent("home", { win, storage, now: 51_000, BroadcastChannel: null });
  assert.deepEqual(received, ["expiring", "home"]);
  assert.equal(consumeNavigationIntent({ win, storage, now: 51_500 }), null);
  ac.abort();
});

test("openPluginPage handles Desktop (active, direct, deferred) and Web (active, tab, sidebar)", async () => {
  // Desktop: already active on plugin page
  {
    const calls = [];
    const res = openPluginPage({
      hostTarget: "desktop",
      win: {
        __codexhostSettingsShellV1: {
          open: true,
          activePageId: DESKTOP_PAGE_ID,
          openSettings: (...args) => {
            calls.push(args);
            return true;
          },
        },
      },
    });
    assert.equal(res.opened, true);
    assert.equal(res.mode, "desktop-active");
    assert.equal(calls.length, 0);
  }

  // Desktop: direct open succeeds
  {
    const openedPages = [];
    const res = openPluginPage({
      hostTarget: "desktop",
      win: {
        __codexhostSettingsShellV1: {
          open: false,
          activePageId: "general",
          openSettings: (_opener, pageId) => {
            openedPages.push(pageId);
            return pageId === DESKTOP_PAGE_ID;
          },
        },
      },
    });
    assert.equal(res.opened, true);
    assert.equal(res.mode, "desktop-direct");
    assert.deepEqual(openedPages, [DESKTOP_PAGE_ID]);
  }

  // Desktop: cold start falls back to desktop-extensions then navigates once synced
  {
    const openedPages = [];
    const navigated = [];
    let ready = false;
    const ac = new AbortController();
    const res = openPluginPage({
      hostTarget: "desktop",
      signal: ac.signal,
      pollIntervalMs: 10,
      maxAttempts: 10,
      win: {
        __codexhostSettingsShellV1: {
          open: false,
          activePageId: "general",
          openSettings: (_opener, pageId) => {
            openedPages.push(pageId);
            if (pageId === "desktop-extensions") {
              setTimeout(() => {
                ready = true;
              }, 15);
              return true;
            }
            return false;
          },
          navigateToPage: (pageId) => {
            navigated.push(pageId);
            return ready && pageId === DESKTOP_PAGE_ID;
          },
        },
      },
    });
    assert.equal(res.opened, true);
    assert.equal(res.mode, "desktop-deferred");
    assert.deepEqual(openedPages, [DESKTOP_PAGE_ID, "desktop-extensions"]);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(navigated.includes(DESKTOP_PAGE_ID));
    ac.abort();
  }

  // Web: already active page
  {
    const res = openPluginPage({
      hostTarget: "web",
      win: {},
      doc: {
        querySelector: (sel) => (sel === '[data-host-extension-page="auto-archive-guard"]' ? {} : null),
      },
    });
    assert.equal(res.opened, true);
    assert.equal(res.mode, "web-active");
  }

  // Web: clicks sidebar Plugins button then selects plugin tab when rendered
  {
    let sidebarClicked = false;
    let tabClicked = false;
    let tabMounted = false;
    const ac = new AbortController();
    const tabBtn = { click: () => { tabClicked = true; } };
    const sidebarBtn = {
      click: () => {
        sidebarClicked = true;
        setTimeout(() => {
          tabMounted = true;
        }, 15);
      },
    };
    const res = openPluginPage({
      hostTarget: "web",
      win: {},
      signal: ac.signal,
      pollIntervalMs: 10,
      maxAttempts: 10,
      doc: {
        querySelector: (sel) => {
          if (sel.includes("-page-auto-archive-guard")) return tabMounted ? tabBtn : null;
          if (sel.includes('aria-label="插件"')) return sidebarBtn;
          return null;
        },
        querySelectorAll: () => [],
      },
    });
    assert.equal(res.opened, true);
    assert.equal(res.mode, "web-sidebar");
    assert.equal(sidebarClicked, true);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(tabClicked, true);
    ac.abort();
  }
});

test("widget stays hidden by default and only renders & navigates when showWidget is enabled", async () => {
  const storageMap = new Map();
  const winEvents = [];
  const fakeWindow = {
    sessionStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
    },
    CustomEvent: class FakeCustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    },
    dispatchEvent: (ev) => winEvents.push(ev),
    addEventListener: () => {},
    removeEventListener: () => {},
    __codexhostSettingsShellV1: {
      open: false,
      activePageId: "general",
      opened: [],
      openSettings(_opener, pageId) {
        this.opened.push(pageId);
        return true;
      },
    },
  };

  let clickHandler = null;
  let renderedHtml = "";
  let replacedCount = 0;
  const fakeRoot = {
    ownerDocument: { defaultView: fakeWindow },
    replaceChildren() {
      renderedHtml = "";
      clickHandler = null;
      replacedCount += 1;
    },
    set innerHTML(val) {
      renderedHtml = val;
    },
    get innerHTML() {
      return renderedHtml;
    },
    querySelector(sel) {
      if (sel === "[data-w-open]" && renderedHtml.includes("data-w-open")) {
        return {
          addEventListener(type, fn) {
            if (type === "click") clickHandler = fn;
          },
        };
      }
      return null;
    },
  };

  let backendCalls = 0;
  let expiredCount = 2;
  let storageListener = null;
  const ac = new AbortController();
  const cleanup = await mountWidget(fakeRoot, {
    locale: "zh-CN",
    hostTarget: "desktop",
    signal: ac.signal,
    onLocaleChange: () => () => {},
    storage: {
      get: async () => ({}),
      onChange: (fn) => {
        storageListener = fn;
        return () => {};
      },
    },
    backend: {
      invoke: async () => {
        backendCalls += 1;
        return {
          settings: { showWidget: true, enabled: true, retentionDays: 3 },
          stats: { totalActive: 5, expiredCount, pendingCount: 0, protectedActiveCount: 1 },
        };
      },
    },
  });

  try {
    // Default showWidget: false -> nothing rendered, no backend polling
    assert.equal(renderedHtml, "");
    assert.ok(replacedCount >= 1);
    assert.equal(backendCalls, 0);

    // Enabling showWidget renders the pill and syncs backend state
    storageListener({ showWidget: true, enabled: true, retentionDays: 3 });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(renderedHtml.includes("aag-widget-pill"));
    assert.ok(renderedHtml.includes("aag-pill-badge"));
    assert.ok(typeof clickHandler === "function");

    // Clicking when expiredCount > 0 routes to "expiring" and opens plugin page
    clickHandler();
    assert.equal(consumeNavigationIntent({ win: fakeWindow }), "expiring");
    assert.equal(fakeWindow.__codexhostSettingsShellV1.opened.at(-1), DESKTOP_PAGE_ID);

    // When expiredCount becomes 0, clicking routes to "home"
    expiredCount = 0;
    storageListener({ showWidget: true, enabled: true, retentionDays: 3 });
    // Trigger syncState via protected change isn't needed; re-enable toggle forces sync
    storageListener({ showWidget: false });
    assert.equal(renderedHtml, "");
    storageListener({ showWidget: true, enabled: true, retentionDays: 3 });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!renderedHtml.includes("aag-pill-badge"));
    clickHandler();
    assert.equal(consumeNavigationIntent({ win: fakeWindow }), "home");
  } finally {
    ac.abort();
    cleanup();
  }
});

test("catalog pagination retries transient page-0 timeout and gracefully stops on deeper-page timeouts", async () => {
  const timeoutErr = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(isRetryableCatalogError(timeoutErr), true);
  assert.equal(isRetryableCatalogError(new Error("Thread catalog aggregation failed")), true);
  assert.equal(isRetryableCatalogError(new Error("Unauthorized")), false);

  // Page 0 fails once with TimeoutError then succeeds; page 1 times out -> graceful partial result
  let page0Calls = 0;
  let page1Calls = 0;
  const activeRes = await readAllActiveThreads(
    {
      request: async (method, params) => {
        if (method === "codexhost/thread/pins/list") return { threadIds: [] };
        if (method === "codexhost/thread/tree/snapshot") return { nodes: {} };
        if (method === "codexhost/thread/catalog/read") {
          if (!params?.officialCursor?.live) {
            page0Calls += 1;
            if (page0Calls === 1) throw timeoutErr;
            return {
              threads: [{ id: "t-1", name: "Recent", updatedAt: 1_700_000_000 }],
              ownership: [{ threadId: "t-1", owner: "codex" }],
              archivedThreadIds: [],
              officialCursor: { live: "cursor-page-1" },
            };
          }
          page1Calls += 1;
          throw timeoutErr;
        }
        return {};
      },
    },
    { retryDelayMs: 5 },
  );
  assert.equal(page0Calls, 2);
  assert.equal(page1Calls, 1);
  assert.equal(activeRes.truncated, true);
  assert.equal(activeRes.threads.length, 1);
  assert.equal(activeRes.threads[0].id, "t-1");

  // Archived catalog also gracefully stops on page > 0 timeout
  let archPage1Calls = 0;
  const archivedRes = await readAllArchivedThreads(
    {
      request: async (_method, params) => {
        if (!params?.officialCursor?.archived) {
          return {
            threads: [{ id: "a-1", name: "Old Archived", updatedAt: 1_600_000_000 }],
            ownership: [{ threadId: "a-1", owner: "codex" }],
            archivedThreadIds: ["a-1"],
            officialCursor: { live: null, archived: "arch-cursor-1" },
          };
        }
        archPage1Calls += 1;
        throw new Error("Thread catalog aggregation failed");
      },
    },
    { retryDelayMs: 5 },
  );
  assert.equal(archPage1Calls, 1);
  assert.equal(archivedRes.truncated, true);
  assert.equal(archivedRes.threads.length, 1);
  assert.equal(archivedRes.threads[0].id, "a-1");
});
