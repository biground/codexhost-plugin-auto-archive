import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activate, evaluateThread, normalizeSettings } from "../backend/index.mjs";
import { parseSessionIdFromRowKey } from "../web/index.mjs";

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
