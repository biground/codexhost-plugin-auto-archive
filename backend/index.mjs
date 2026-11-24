import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_CATALOG_PAGES = 100;
const MAX_ARCHIVED_RETURN = 2000;
const MAX_HISTORY_ITEMS = 200;
const INITIAL_SWEEP_DELAY_MS = 120_000;
const CATALOG_TTL_MS = 45_000;
const ARCHIVED_TTL_MS = 90_000;
const RPC_TIMEOUT_MS = 25_000;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  retentionDays: 3,
  dateField: "updatedAt",
  checkIntervalMinutes: 1440,
  graceMinutes: 30,
  skipPinned: true,
  showWidget: true,
});

export function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const enabled = typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled;
  const rawDays = Number(source.retentionDays);
  const retentionDays = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(3650, Math.round(rawDays)))
    : DEFAULT_SETTINGS.retentionDays;
  const dateField = source.dateField === "createdAt" ? "createdAt" : "updatedAt";
  const rawInterval = Number(source.checkIntervalMinutes);
  const checkIntervalMinutes = Number.isFinite(rawInterval)
    ? Math.max(5, Math.min(10080, Math.round(rawInterval)))
    : DEFAULT_SETTINGS.checkIntervalMinutes;
  const rawGrace = Number(source.graceMinutes);
  const graceMinutes = Number.isFinite(rawGrace)
    ? Math.max(0, Math.min(10080, Math.round(rawGrace)))
    : DEFAULT_SETTINGS.graceMinutes;
  const skipPinned =
    typeof source.skipPinned === "boolean" ? source.skipPinned : DEFAULT_SETTINGS.skipPinned;
  const showWidget =
    typeof source.showWidget === "boolean" ? source.showWidget : DEFAULT_SETTINGS.showWidget;
  return {
    enabled,
    retentionDays,
    dateField,
    checkIntervalMinutes,
    graceMinutes,
    skipPinned,
    showWidget,
  };
}

export function normalizeProtectedStore(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = new Set();
  if (Array.isArray(source.threadIds)) {
    for (const id of source.threadIds) {
      if (typeof id === "string" && id.trim()) ids.add(id.trim());
    }
  }
  const meta = {};
  if (source.meta && typeof source.meta === "object" && !Array.isArray(source.meta)) {
    for (const id of ids) {
      const item = source.meta[id];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        meta[id] = {
          title: typeof item.title === "string" ? item.title.slice(0, 200) : "",
          addedAt:
            typeof item.addedAt === "number" && Number.isFinite(item.addedAt)
              ? item.addedAt
              : Date.now(),
        };
      }
    }
  }
  return { threadIds: [...ids], meta };
}

export function normalizePendingStore(raw) {
  const result = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result;
  for (const [id, entry] of Object.entries(raw)) {
    if (typeof id !== "string" || !id.trim()) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const detectedAt = Number(entry.detectedAt);
    const dueAt = Number(entry.dueAt);
    if (!Number.isFinite(detectedAt) || !Number.isFinite(dueAt)) continue;
    result[id.trim()] = {
      threadId: id.trim(),
      detectedAt,
      dueAt,
      title: typeof entry.title === "string" ? entry.title.slice(0, 200) : "",
    };
  }
  return result;
}

export function normalizeTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric > 1e12 ? Math.trunc(numeric) : Math.trunc(numeric * 1000);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function normalizeFsPath(p) {
  if (typeof p !== "string" || !p.trim()) return "";
  let normalized = p.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (/^[A-Za-z]:/u.test(normalized)) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

export function resolveThreadProject(thread, workspace) {
  if (!workspace || !Array.isArray(workspace.projects) || workspace.projects.length === 0) {
    return { projectId: null, projectName: "" };
  }
  const projectsById = new Map();
  for (const project of workspace.projects) {
    if (project && typeof project.id === "string") {
      projectsById.set(project.id, project);
    }
  }
  const id = typeof thread?.id === "string" ? thread.id : typeof thread?.threadId === "string" ? thread.threadId : "";
  const assignedId =
    (id && workspace.assignments && workspace.assignments[id]) ||
    (typeof thread?.projectId === "string" ? thread.projectId : null);
  if (assignedId && projectsById.has(assignedId)) {
    const project = projectsById.get(assignedId);
    return { projectId: project.id, projectName: project.name || project.id };
  }

  const projectlessSet = workspace.projectlessSet;
  if (id && projectlessSet?.has(id)) {
    return { projectId: null, projectName: "" };
  }

  const cwd = normalizeFsPath(thread?.cwd || "");
  if (!cwd) return { projectId: null, projectName: "" };

  let bestProject = null;
  let bestLen = -1;
  for (const project of workspace.projects) {
    const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
    for (const root of roots) {
      const normRoot = normalizeFsPath(root);
      if (!normRoot) continue;
      if (cwd === normRoot || cwd.startsWith(`${normRoot}/`)) {
        if (normRoot.length > bestLen) {
          bestLen = normRoot.length;
          bestProject = project;
        }
      }
    }
  }
  if (bestProject) {
    return { projectId: bestProject.id, projectName: bestProject.name || bestProject.id };
  }
  return { projectId: null, projectName: "" };
}

export function isThreadBusy(thread, treeNode) {
  const treeStatus = treeNode?.status;
  if (treeStatus === "running" || treeStatus === "waiting") return true;
  const status = thread?.status;
  if (typeof status === "string") {
    return ["running", "active", "waiting", "in_progress", "inProgress", "streaming"].includes(status);
  }
  if (status && typeof status === "object") {
    const type = typeof status.type === "string" ? status.type : "";
    if (["running", "active", "waiting", "in_progress", "inProgress", "streaming"].includes(type)) {
      return true;
    }
    if (Array.isArray(status.activeFlags) && status.activeFlags.length > 0) {
      return true;
    }
  }
  return false;
}

export function extractThreadTitle(thread) {
  const candidates = [thread?.name, thread?.title, thread?.preview];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim().replace(/\s+/gu, " ").slice(0, 160);
    }
  }
  return typeof thread?.id === "string" ? thread.id : "Untitled Session";
}

function compactThreadRow(thread) {
  return {
    id: thread.id,
    name: typeof thread.name === "string" ? thread.name.slice(0, 180) : null,
    title: typeof thread.title === "string" ? thread.title.slice(0, 180) : null,
    preview: typeof thread.preview === "string" ? thread.preview.slice(0, 180) : null,
    cwd: typeof thread.cwd === "string" ? thread.cwd.slice(0, 260) : "",
    projectId: typeof thread.projectId === "string" ? thread.projectId : null,
    modelProvider: typeof thread.modelProvider === "string" ? thread.modelProvider : null,
    createdAt: thread.createdAt ?? null,
    updatedAt: thread.updatedAt ?? null,
    recencyAt: thread.recencyAt ?? null,
    status: thread.status ?? null,
    isPinned: Boolean(thread.isPinned),
  };
}

export function evaluateThread(thread, options) {
  const {
    nowMs,
    settings,
    protectedSet,
    pinnedSet,
    treeNodes,
    ownershipMap,
    pendingMap = {},
    workspace = null,
  } = options;
  const id = typeof thread?.id === "string" ? thread.id : "";
  const updatedAtMs =
    normalizeTimestampMs(thread?.updatedAt) ??
    normalizeTimestampMs(thread?.recencyAt) ??
    normalizeTimestampMs(thread?.createdAt);
  const createdAtMs = normalizeTimestampMs(thread?.createdAt) ?? updatedAtMs;
  const referenceMs = settings.dateField === "createdAt" ? createdAtMs : updatedAtMs;
  const ageMs = referenceMs !== null ? Math.max(0, nowMs - referenceMs) : null;
  const daysInactive = ageMs !== null ? Math.round((ageMs / DAY_MS) * 10) / 10 : null;
  const thresholdMs = settings.retentionDays * DAY_MS;
  const isProtected = protectedSet.has(id);
  const isPinned = Boolean(thread?.isPinned) || pinnedSet.has(id);
  const treeNode = treeNodes?.[id];
  const isRunning = isThreadBusy(thread, treeNode);
  const isExpired = ageMs !== null && ageMs >= thresholdMs;
  const ownership = ownershipMap.get(id);
  const harnessId =
    ownership?.owner === "external"
      ? ownership.harnessId
      : ownership?.owner === "codex"
        ? "codex"
        : typeof thread?.modelProvider === "string"
          ? thread.modelProvider
          : "codex";

  let skipReason = null;
  if (!isExpired) skipReason = "fresh";
  else if (isProtected) skipReason = "protected";
  else if (isRunning) skipReason = "running";
  else if (settings.skipPinned && isPinned) skipReason = "pinned";

  const eligible = Boolean(id) && isExpired && skipReason === null;
  const pending = eligible ? pendingMap[id] ?? null : null;
  const project = resolveThreadProject(thread, workspace);

  return {
    id,
    title: extractThreadTitle(thread),
    cwd: typeof thread?.cwd === "string" ? thread.cwd : "",
    projectId: project.projectId,
    projectName: project.projectName,
    harnessId,
    createdAtMs,
    updatedAtMs,
    referenceMs,
    daysInactive,
    isProtected,
    isPinned,
    isRunning,
    isExpired,
    eligible,
    skipReason,
    pendingDetectedAt: pending ? pending.detectedAt : null,
    pendingDueAt: pending ? pending.dueAt : null,
  };
}

export async function discoverHostDescriptor(clientHostsDir) {
  const entries = await readdir(clientHostsDir).catch(() => []);
  const candidates = [];
  for (const name of entries) {
    if (!/^host-\d+(?:-[0-9a-f-]+)?\.json$/u.test(name)) continue;
    try {
      const handle = await open(
        path.join(clientHostsDir, name),
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 4096) continue;
        const parsed = JSON.parse(await handle.readFile("utf8"));
        if (
          !parsed ||
          typeof parsed !== "object" ||
          typeof parsed.pid !== "number" ||
          typeof parsed.port !== "number" ||
          typeof parsed.token !== "string"
        ) {
          continue;
        }
        process.kill(parsed.pid, 0);
        candidates.push(parsed);
      } finally {
        await handle.close();
      }
    } catch {
      // Ignore stale or unreadable descriptors.
    }
  }
  candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return candidates[0] ?? null;
}

export function createHostRpcClient(clientHostsDir, fetchImpl = globalThis.fetch) {
  async function request(method, params = {}) {
    const descriptor = await discoverHostDescriptor(clientHostsDir);
    if (!descriptor) {
      throw new Error("Shared CodexHost client channel is unavailable");
    }
    const response = await fetchImpl(`http://127.0.0.1:${descriptor.port}/v1/rpc`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const payload = await response.json();
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error?.message ?? `Host RPC failed (${response.status})`);
    }
    return payload?.result;
  }

  async function isOnline() {
    return (await discoverHostDescriptor(clientHostsDir)) !== null;
  }

  return { request, isOnline };
}

export async function readWorkspaceMetadata(rpc, threadIds = []) {
  try {
    const result = await rpc.request("codexhost/workspace/read", { threadIds });
    const projects = Array.isArray(result?.projects)
      ? result.projects
          .filter((p) => p && typeof p.id === "string")
          .map((p) => ({
            id: p.id,
            name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id,
            rootPaths: Array.isArray(p.rootPaths)
              ? p.rootPaths.filter((r) => typeof r === "string")
              : [],
          }))
      : [];
    const assignments =
      result?.assignments && typeof result.assignments === "object" && !Array.isArray(result.assignments)
        ? result.assignments
        : {};
    const projectless = Array.isArray(result?.projectless)
      ? result.projectless.filter((id) => typeof id === "string")
      : [];
    return {
      projects,
      assignments,
      projectless,
      projectlessSet: new Set(projectless),
    };
  } catch {
    return {
      projects: [],
      assignments: {},
      projectless: [],
      projectlessSet: new Set(),
    };
  }
}

export async function readAllActiveThreads(rpc, options = {}) {
  const { onPage, isAborted } = options;
  const byId = new Map();
  const ownershipMap = new Map();

  const [pinsResult, treeResult] = await Promise.all([
    rpc.request("codexhost/thread/pins/list", {}).catch(() => null),
    rpc.request("codexhost/thread/tree/snapshot", {}).catch(() => null),
  ]);
  const pinnedSet = new Set(
    Array.isArray(pinsResult?.threadIds)
      ? pinsResult.threadIds.filter((id) => typeof id === "string")
      : [],
  );
  const treeNodes =
    treeResult?.nodes && typeof treeResult.nodes === "object" ? treeResult.nodes : {};

  let cursor = undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    if (isAborted?.()) break;
    const params = cursor
      ? { includeArchived: false, officialCursor: { live: cursor } }
      : { includeArchived: false };
    const result = await rpc.request("codexhost/thread/catalog/read", params);
    const threads = Array.isArray(result?.threads) ? result.threads : [];
    const ownerships = Array.isArray(result?.ownership) ? result.ownership : [];
    const archivedSet = new Set(
      Array.isArray(result?.archivedThreadIds) ? result.archivedThreadIds : [],
    );
    for (const owner of ownerships) {
      if (owner && typeof owner.threadId === "string") {
        ownershipMap.set(owner.threadId, owner);
      }
    }
    for (const thread of threads) {
      if (!thread || typeof thread.id !== "string" || archivedSet.has(thread.id)) continue;
      if (!byId.has(thread.id)) {
        byId.set(thread.id, compactThreadRow(thread));
      }
    }
    onPage?.({
      threads: [...byId.values()],
      ownershipMap: new Map(ownershipMap),
      pinnedSet,
      treeNodes,
    });
    const nextCursor = result?.officialCursor?.live ?? null;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return {
    threads: [...byId.values()],
    ownershipMap,
    pinnedSet,
    treeNodes,
  };
}

export async function readAllArchivedThreads(rpc, options = {}) {
  const { onPage, isAborted } = options;
  const byId = new Map();
  const ownershipMap = new Map();

  let archivedCursor = undefined;
  for (let page = 0; page < MAX_CATALOG_PAGES; page++) {
    if (isAborted?.()) break;
    // Pass live: null so Host skips live native pages and walks only the archived branch.
    const params =
      archivedCursor === undefined
        ? { includeArchived: true, officialCursor: { live: null } }
        : { includeArchived: true, officialCursor: { live: null, archived: archivedCursor } };
    const result = await rpc.request("codexhost/thread/catalog/read", params);
    const threads = Array.isArray(result?.threads) ? result.threads : [];
    const ownerships = Array.isArray(result?.ownership) ? result.ownership : [];
    const archivedSet = new Set(
      Array.isArray(result?.archivedThreadIds) ? result.archivedThreadIds : [],
    );
    for (const owner of ownerships) {
      if (owner && typeof owner.threadId === "string") {
        ownershipMap.set(owner.threadId, owner);
      }
    }
    for (const thread of threads) {
      if (!thread || typeof thread.id !== "string" || !archivedSet.has(thread.id)) continue;
      if (!byId.has(thread.id)) {
        byId.set(thread.id, compactThreadRow(thread));
      }
    }
    onPage?.({
      threads: [...byId.values()],
      ownershipMap: new Map(ownershipMap),
    });
    const nextCursor = result?.officialCursor?.archived ?? null;
    if (!nextCursor || nextCursor === archivedCursor) break;
    archivedCursor = nextCursor;
  }

  return {
    threads: [...byId.values()],
    ownershipMap,
  };
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

export async function activate(ctx, options = {}) {
  const codexHostDataDir = options.codexHostDataDir ?? path.resolve(ctx.dataDir, "..", "..");
  const clientHostsDir = path.join(codexHostDataDir, "client-hosts");
  const rpc = options.rpc ?? createHostRpcClient(clientHostsDir, options.fetchImpl);
  const nowFn = options.now ?? (() => Date.now());
  const protectedPath = path.join(ctx.dataDir, "protected-threads.json");
  const pendingPath = path.join(ctx.dataDir, "pending-archives.json");
  const historyPath = path.join(ctx.dataDir, "archive-history.json");

  let disposed = false;
  let sweeping = false;
  let sweepProgress = null;
  let scanTimer = null;
  let pendingTimer = null;
  let nextRunAt = null;
  let nextPendingDueAt = null;
  let lastRunAt = null;
  let lastSummary = null;
  let protectedStore = normalizeProtectedStore(await readJsonFile(protectedPath, null));
  let pendingArchives = normalizePendingStore(await readJsonFile(pendingPath, null));
  let history = await readJsonFile(historyPath, []);
  if (!Array.isArray(history)) history = [];
  history = history.slice(0, MAX_HISTORY_ITEMS);

  let workspaceCache = {
    projects: [],
    assignments: {},
    projectless: [],
    projectlessSet: new Set(),
  };

  let catalogCache = {
    threads: [],
    ownershipMap: new Map(),
    pinnedSet: new Set(),
    treeNodes: {},
    updatedAt: 0,
    hostConnected: false,
    error: null,
  };
  let catalogRefreshPromise = null;

  let archivedCache = {
    threads: [],
    ownershipMap: new Map(),
    updatedAt: 0,
    error: null,
  };
  let archivedRefreshPromise = null;

  async function loadSettings() {
    const raw = await ctx.readSettings();
    return normalizeSettings(raw);
  }

  async function saveProtectedStore(nextStore) {
    protectedStore = normalizeProtectedStore(nextStore);
    await writeJsonFileAtomic(protectedPath, protectedStore);
    return protectedStore;
  }

  async function savePendingArchives() {
    await writeJsonFileAtomic(pendingPath, pendingArchives).catch(() => undefined);
  }

  async function syncWorkspaceSnapshot() {
    const allIds = new Set();
    for (const t of catalogCache.threads) allIds.add(t.id);
    for (const t of archivedCache.threads) allIds.add(t.id);
    for (const h of history) {
      if (typeof h?.threadId === "string") allIds.add(h.threadId);
    }
    const ws = await readWorkspaceMetadata(rpc, [...allIds]);
    if (!disposed && (ws.projects.length > 0 || workspaceCache.projects.length === 0)) {
      workspaceCache = ws;
    }
  }

  function earliestPendingDueAt() {
    let earliest = null;
    for (const entry of Object.values(pendingArchives)) {
      if (earliest === null || entry.dueAt < earliest) {
        earliest = entry.dueAt;
      }
    }
    return earliest;
  }

  function clearPendingTimer() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function schedulePendingFlush(settings) {
    clearPendingTimer();
    const earliest = earliestPendingDueAt();
    nextPendingDueAt = settings.enabled ? earliest : null;
    if (disposed || !settings.enabled || earliest === null) {
      return;
    }
    const delayMs = Math.max(1_000, earliest - nowFn());
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (disposed) return;
      void (async () => {
        let latest = settings;
        try {
          latest = await loadSettings();
          if (latest.enabled) {
            await executeSweep({
              dryRun: false,
              trigger: "auto",
              refresh: true,
              respectGrace: true,
            }).catch(() => undefined);
          }
        } catch {
          // Never allow timer callbacks to trigger unhandled rejections.
        } finally {
          if (!disposed) {
            schedulePendingFlush(latest);
          }
        }
      })();
    }, delayMs);
    pendingTimer.unref?.();
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await ctx.writeSettings(next);

    if (next.graceMinutes !== current.graceMinutes) {
      let dirty = false;
      for (const entry of Object.values(pendingArchives)) {
        entry.dueAt = entry.detectedAt + next.graceMinutes * MINUTE_MS;
        dirty = true;
      }
      if (dirty) await savePendingArchives();
    }

    scheduleNext(next);
    schedulePendingFlush(next);
    return next;
  }

  function refreshCatalogInBackground(force = false) {
    if (disposed) return Promise.resolve(catalogCache);
    if (catalogRefreshPromise) return catalogRefreshPromise;
    if (!force && catalogCache.updatedAt > 0 && nowFn() - catalogCache.updatedAt < CATALOG_TTL_MS) {
      return Promise.resolve(catalogCache);
    }
    const task = (async () => {
      try {
        const online = await rpc.isOnline();
        if (!online) {
          catalogCache = { ...catalogCache, hostConnected: false, error: null };
          return catalogCache;
        }
        catalogCache.hostConnected = true;
        catalogCache.error = null;
        if (workspaceCache.projects.length === 0) {
          await syncWorkspaceSnapshot();
        }
        const fresh = await readAllActiveThreads(rpc, {
          isAborted: () => disposed,
          onPage: (partial) => {
            if (disposed) return;
            catalogCache = {
              ...partial,
              updatedAt: nowFn(),
              hostConnected: true,
              error: null,
            };
          },
        });
        if (!disposed) {
          catalogCache = {
            ...fresh,
            updatedAt: nowFn(),
            hostConnected: true,
            error: null,
          };
          await syncWorkspaceSnapshot();
        }
      } catch (error) {
        if (!disposed) {
          catalogCache = {
            ...catalogCache,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        catalogRefreshPromise = null;
      }
      return catalogCache;
    })();
    catalogRefreshPromise = task;
    task.catch(() => undefined);
    return task;
  }

  function refreshArchivedInBackground(force = false) {
    if (disposed) return Promise.resolve(archivedCache);
    if (archivedRefreshPromise) return archivedRefreshPromise;
    if (
      !force &&
      archivedCache.updatedAt > 0 &&
      nowFn() - archivedCache.updatedAt < ARCHIVED_TTL_MS
    ) {
      return Promise.resolve(archivedCache);
    }
    const task = (async () => {
      try {
        const online = await rpc.isOnline();
        if (!online) return archivedCache;
        archivedCache.error = null;
        if (workspaceCache.projects.length === 0) {
          await syncWorkspaceSnapshot();
        }
        const fresh = await readAllArchivedThreads(rpc, {
          isAborted: () => disposed,
          onPage: (partial) => {
            if (disposed) return;
            archivedCache = {
              ...partial,
              updatedAt: nowFn(),
              error: null,
            };
          },
        });
        if (!disposed) {
          archivedCache = {
            ...fresh,
            updatedAt: nowFn(),
            error: null,
          };
          await syncWorkspaceSnapshot();
        }
      } catch (error) {
        if (!disposed) {
          archivedCache = {
            ...archivedCache,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } finally {
        archivedRefreshPromise = null;
      }
      return archivedCache;
    })();
    archivedRefreshPromise = task;
    task.catch(() => undefined);
    return task;
  }

  function evaluateCachedThreads(settings) {
    const protectedSet = new Set(protectedStore.threadIds);
    const nowMs = nowFn();
    return catalogCache.threads
      .map((thread) =>
        evaluateThread(thread, {
          nowMs,
          settings,
          protectedSet,
          pinnedSet: catalogCache.pinnedSet,
          treeNodes: catalogCache.treeNodes,
          ownershipMap: catalogCache.ownershipMap,
          pendingMap: pendingArchives,
          workspace: workspaceCache,
        }),
      )
      .filter((item) => item.id)
      .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  }

  function buildArchivedList() {
    const historyById = new Map();
    for (const h of history) {
      if (h && typeof h.threadId === "string" && !historyById.has(h.threadId)) {
        historyById.set(h.threadId, h);
      }
    }

    const byId = new Map();
    for (const thread of archivedCache.threads) {
      const id = thread.id;
      const hist = historyById.get(id) ?? null;
      const ownership = archivedCache.ownershipMap.get(id);
      const harnessId =
        ownership?.owner === "external"
          ? ownership.harnessId
          : ownership?.owner === "codex"
            ? "codex"
            : hist?.harnessId || thread.modelProvider || "codex";
      const updatedAtMs =
        normalizeTimestampMs(thread.updatedAt) ??
        normalizeTimestampMs(thread.recencyAt) ??
        normalizeTimestampMs(thread.createdAt) ??
        hist?.lastActivityAt ??
        null;
      const project = resolveThreadProject(thread, workspaceCache);
      byId.set(id, {
        threadId: id,
        title: extractThreadTitle(thread),
        cwd: thread.cwd || hist?.cwd || "",
        projectId: project.projectId,
        projectName: project.projectName,
        harnessId,
        updatedAtMs,
        archivedAt: hist?.archivedAt ?? updatedAtMs,
        daysInactive: hist?.daysInactive ?? null,
        trigger: hist?.trigger ?? null,
        isPluginArchived: Boolean(hist),
      });
    }

    // Include plugin-recorded archived items not yet reflected in archivedCache
    for (const hist of history) {
      if (!hist || typeof hist.threadId !== "string" || byId.has(hist.threadId)) continue;
      const project = resolveThreadProject(
        { id: hist.threadId, cwd: hist.cwd || "", projectId: hist.projectId ?? null },
        workspaceCache,
      );
      byId.set(hist.threadId, {
        threadId: hist.threadId,
        title: hist.title || hist.threadId,
        cwd: hist.cwd || "",
        projectId: project.projectId,
        projectName: project.projectName,
        harnessId: hist.harnessId || "codex",
        updatedAtMs: hist.lastActivityAt ?? hist.archivedAt ?? null,
        archivedAt: hist.archivedAt ?? hist.lastActivityAt ?? null,
        daysInactive: hist.daysInactive ?? null,
        trigger: hist.trigger ?? "auto",
        isPluginArchived: true,
      });
    }

    return [...byId.values()]
      .sort((a, b) => (b.archivedAt ?? b.updatedAtMs ?? 0) - (a.archivedAt ?? a.updatedAtMs ?? 0))
      .slice(0, MAX_ARCHIVED_RETURN);
  }

  async function executeSweep({
    dryRun = false,
    trigger = "manual",
    refresh = true,
    respectGrace = trigger === "auto",
  } = {}) {
    if (sweeping) {
      return {
        busy: true,
        dryRun,
        trigger,
        archived: [],
        queued: [],
        failed: [],
        candidates: [],
      };
    }
    sweeping = true;
    try {
      const settings = await loadSettings();
      if (refresh || catalogCache.updatedAt === 0) {
        await refreshCatalogInBackground(true);
      }
      if (!catalogCache.hostConnected) {
        throw new Error(catalogCache.error || "Shared CodexHost client channel is unavailable");
      }
      const items = evaluateCachedThreads(settings);
      const candidates = items.filter((item) => item.eligible);
      const eligibleIds = new Set(candidates.map((item) => item.id));
      const runTime = nowFn();
      const graceMs = settings.graceMinutes * MINUTE_MS;

      let pendingDirty = false;
      for (const id of Object.keys(pendingArchives)) {
        if (!eligibleIds.has(id)) {
          delete pendingArchives[id];
          pendingDirty = true;
        }
      }

      const toArchiveNow = [];
      const newlyQueued = [];

      if (dryRun) {
        // No side effects during dry-run.
      } else if (respectGrace && graceMs > 0) {
        for (const item of candidates) {
          const existing = pendingArchives[item.id];
          if (!existing) {
            const entry = {
              threadId: item.id,
              detectedAt: runTime,
              dueAt: runTime + graceMs,
              title: item.title,
            };
            pendingArchives[item.id] = entry;
            newlyQueued.push(entry);
            pendingDirty = true;
          } else if (runTime >= existing.dueAt) {
            toArchiveNow.push(item);
          }
        }
      } else {
        toArchiveNow.push(...candidates);
      }

      const archived = [];
      const failed = [];
      const archivedIdSet = new Set();

      sweepProgress =
        dryRun || toArchiveNow.length === 0
          ? null
          : {
              trigger,
              startedAt: runTime,
              total: toArchiveNow.length,
              processed: 0,
              archivedCount: 0,
              failedCount: 0,
            };

      if (!dryRun) {
        for (const item of toArchiveNow) {
          if (disposed) break;
          if (protectedStore.threadIds.includes(item.id)) {
            if (pendingArchives[item.id]) {
              delete pendingArchives[item.id];
              pendingDirty = true;
            }
            if (sweepProgress) sweepProgress.processed += 1;
            continue;
          }
          try {
            await rpc.request("thread/archive", { threadId: item.id });
            archivedIdSet.add(item.id);
            if (pendingArchives[item.id]) {
              delete pendingArchives[item.id];
              pendingDirty = true;
            }
            const record = {
              threadId: item.id,
              title: item.title,
              harnessId: item.harnessId,
              cwd: item.cwd,
              projectId: item.projectId,
              archivedAt: nowFn(),
              lastActivityAt: item.updatedAtMs,
              daysInactive: item.daysInactive,
              retentionDays: settings.retentionDays,
              graceMinutes: settings.graceMinutes,
              trigger,
            };
            archived.push(record);
            if (sweepProgress) sweepProgress.archivedCount = archived.length;
          } catch (error) {
            failed.push({
              threadId: item.id,
              title: item.title,
              error: error instanceof Error ? error.message : String(error),
            });
            if (sweepProgress) sweepProgress.failedCount = failed.length;
          }
          if (sweepProgress) sweepProgress.processed += 1;
        }
        if (pendingDirty) {
          await savePendingArchives();
        }
        if (archived.length > 0) {
          catalogCache = {
            ...catalogCache,
            threads: catalogCache.threads.filter((t) => !archivedIdSet.has(t.id)),
            updatedAt: nowFn(),
          };
          history = [...archived, ...history].slice(0, MAX_HISTORY_ITEMS);
          await writeJsonFileAtomic(historyPath, history).catch(() => undefined);
        }
        schedulePendingFlush(settings);
      }

      const summary = {
        ranAt: runTime,
        dryRun,
        trigger,
        scannedCount: items.length,
        protectedCount: items.filter((item) => item.isProtected).length,
        eligibleCount: candidates.length,
        queuedCount: newlyQueued.length,
        pendingCount: Object.keys(pendingArchives).length,
        archivedCount: archived.length,
        failedCount: failed.length,
        error: null,
      };
      if (!dryRun) {
        lastRunAt = runTime;
        lastSummary = summary;
      }
      return {
        ...summary,
        candidates,
        queued: newlyQueued,
        archived,
        failed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!dryRun) {
        lastRunAt = nowFn();
        lastSummary = {
          ranAt: lastRunAt,
          dryRun: false,
          trigger,
          scannedCount: 0,
          protectedCount: 0,
          eligibleCount: 0,
          queuedCount: 0,
          pendingCount: Object.keys(pendingArchives).length,
          archivedCount: 0,
          failedCount: 0,
          error: message,
        };
      }
      throw error;
    } finally {
      sweeping = false;
      sweepProgress = null;
    }
  }

  function clearScheduledTimer() {
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function scheduleNext(settings, delayOverrideMs) {
    clearScheduledTimer();
    if (disposed || !settings.enabled) {
      nextRunAt = null;
      return;
    }
    const delayMs =
      typeof delayOverrideMs === "number"
        ? delayOverrideMs
        : settings.checkIntervalMinutes * MINUTE_MS;
    nextRunAt = nowFn() + delayMs;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (disposed) return;
      void (async () => {
        let latest = settings;
        try {
          latest = await loadSettings();
          if (latest.enabled) {
            await executeSweep({
              dryRun: false,
              trigger: "auto",
              refresh: true,
              respectGrace: true,
            }).catch(() => undefined);
          }
        } catch {
          // Never allow timer callbacks to trigger unhandled rejections.
        } finally {
          if (!disposed) {
            scheduleNext(latest);
            schedulePendingFlush(latest);
          }
        }
      })();
    }, delayMs);
    scanTimer.unref?.();
  }

  const initialSettings = await loadSettings();
  if (options.autoSchedule !== false) {
    scheduleNext(initialSettings, INITIAL_SWEEP_DELAY_MS);
    schedulePendingFlush(initialSettings);
    void refreshCatalogInBackground(true);
  }

  ctx.handle("getProtected", async () => ({
    protectedThreadIds: protectedStore.threadIds,
    protectedMeta: protectedStore.meta,
  }));

  ctx.handle("getState", async (params) => {
    const settings = await loadSettings();
    if (settings.enabled && nextRunAt === null && options.autoSchedule !== false) {
      scheduleNext(settings);
      schedulePendingFlush(settings);
    } else if (!settings.enabled && (nextRunAt !== null || nextPendingDueAt !== null)) {
      scheduleNext(settings);
      schedulePendingFlush(settings);
    }

    const forceRefresh = Boolean(params?.refresh);
    const online = await rpc.isOnline();
    catalogCache.hostConnected = online;
    if (
      online &&
      (forceRefresh || catalogCache.updatedAt === 0 || nowFn() - catalogCache.updatedAt >= CATALOG_TTL_MS)
    ) {
      void refreshCatalogInBackground(forceRefresh);
    }

    const items = evaluateCachedThreads(settings);
    const expiring = items.filter((item) => item.eligible);
    const pendingItems = expiring.filter((item) => item.pendingDueAt !== null);
    const archivedItems = buildArchivedList();
    return {
      pid: process.pid,
      nowMs: nowFn(),
      settings,
      protectedThreadIds: protectedStore.threadIds,
      protectedMeta: protectedStore.meta,
      projects: workspaceCache.projects.map(({ id, name }) => ({ id, name })),
      hostConnected: online,
      hostError: catalogCache.error,
      refreshing: Boolean(catalogRefreshPromise),
      archivedRefreshing: Boolean(archivedRefreshPromise),
      catalogUpdatedAt: catalogCache.updatedAt || null,
      archivedUpdatedAt: archivedCache.updatedAt || null,
      sweeping,
      sweepProgress,
      lastRunAt,
      nextRunAt,
      nextPendingDueAt,
      lastSummary,
      stats: {
        totalActive: items.length,
        expiredCount: expiring.length,
        pendingCount: pendingItems.length,
        protectedActiveCount: items.filter((item) => item.isProtected).length,
        archivedCount: archivedItems.length,
        expiringPreview: expiring.slice(0, 12),
      },
      history,
    };
  });

  ctx.handle("listThreads", async (params) => {
    const settings = await loadSettings();
    const forceRefresh = Boolean(params?.refresh);
    const online = await rpc.isOnline();
    catalogCache.hostConnected = online;
    if (
      online &&
      (forceRefresh || catalogCache.updatedAt === 0 || nowFn() - catalogCache.updatedAt >= CATALOG_TTL_MS)
    ) {
      void refreshCatalogInBackground(forceRefresh);
    }
    const items = evaluateCachedThreads(settings);
    return {
      settings,
      protectedThreadIds: protectedStore.threadIds,
      projects: workspaceCache.projects.map(({ id, name }) => ({ id, name })),
      hostConnected: online,
      hostError: catalogCache.error,
      refreshing: Boolean(catalogRefreshPromise),
      catalogUpdatedAt: catalogCache.updatedAt || null,
      threads: items,
      nowMs: nowFn(),
    };
  });

  ctx.handle("listArchived", async (params) => {
    const forceRefresh = Boolean(params?.refresh);
    const syncWait = Boolean(params?.sync);
    const online = await rpc.isOnline();
    if (
      online &&
      (forceRefresh ||
        archivedCache.updatedAt === 0 ||
        nowFn() - archivedCache.updatedAt >= ARCHIVED_TTL_MS)
    ) {
      const task = refreshArchivedInBackground(forceRefresh);
      if (syncWait) await task;
    }
    const items = buildArchivedList();
    return {
      projects: workspaceCache.projects.map(({ id, name }) => ({ id, name })),
      hostConnected: online,
      archivedError: archivedCache.error,
      refreshing: Boolean(archivedRefreshPromise),
      updatedAt: archivedCache.updatedAt || null,
      archived: items,
      pluginHistoryCount: history.length,
      nowMs: nowFn(),
    };
  });

  ctx.handle("updateSettings", async (params) => {
    const patch = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const settings = await saveSettings(patch);
    return { settings, nextRunAt, nextPendingDueAt };
  });

  ctx.handle("toggleProtect", async (params) => {
    const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId) throw new Error("threadId is required");
    const set = new Set(protectedStore.threadIds);
    const desired =
      typeof params?.protected === "boolean" ? params.protected : !set.has(threadId);
    const meta = { ...protectedStore.meta };
    if (desired) {
      set.add(threadId);
      meta[threadId] = {
        title:
          typeof params?.title === "string" && params.title.trim()
            ? params.title.trim().slice(0, 200)
            : meta[threadId]?.title ?? "",
        addedAt: meta[threadId]?.addedAt ?? nowFn(),
      };
      if (pendingArchives[threadId]) {
        delete pendingArchives[threadId];
        await savePendingArchives();
        schedulePendingFlush(await loadSettings());
      }
    } else {
      set.delete(threadId);
      delete meta[threadId];
    }
    const saved = await saveProtectedStore({ threadIds: [...set], meta });
    return {
      threadId,
      protected: desired,
      protectedThreadIds: saved.threadIds,
      protectedMeta: saved.meta,
    };
  });

  ctx.handle("runSweep", async (params) => {
    const dryRun = Boolean(params?.dryRun);
    const asyncMode = Boolean(params?.async);
    const trigger = params?.trigger === "auto" ? "auto" : "manual";
    const respectGrace =
      typeof params?.respectGrace === "boolean" ? params.respectGrace : trigger === "auto";
    if (dryRun) {
      const settings = await loadSettings();
      if (catalogCache.updatedAt === 0 && !asyncMode) {
        await refreshCatalogInBackground(true);
      } else if (catalogCache.hostConnected) {
        void refreshCatalogInBackground(true);
      }
      const items = evaluateCachedThreads(settings);
      const candidates = items.filter((item) => item.eligible);
      return {
        ranAt: nowFn(),
        dryRun: true,
        trigger,
        scannedCount: items.length,
        protectedCount: items.filter((item) => item.isProtected).length,
        eligibleCount: candidates.length,
        queuedCount: 0,
        pendingCount: Object.keys(pendingArchives).length,
        archivedCount: 0,
        failedCount: 0,
        error: null,
        candidates,
        queued: [],
        archived: [],
        failed: [],
      };
    }
    if (asyncMode) {
      if (sweeping) {
        return { started: false, busy: true, sweepProgress };
      }
      void executeSweep({
        dryRun: false,
        trigger,
        refresh: false,
        respectGrace,
      }).catch(() => undefined);
      return { started: true, busy: false, sweepProgress };
    }
    return executeSweep({ dryRun: false, trigger, refresh: true, respectGrace });
  });

  ctx.handle("unarchiveThread", async (params) => {
    const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId) throw new Error("threadId is required");
    await rpc.request("thread/unarchive", { threadId });
    history = history.filter((item) => item.threadId !== threadId);
    archivedCache = {
      ...archivedCache,
      threads: archivedCache.threads.filter((t) => t.id !== threadId),
    };
    await writeJsonFileAtomic(historyPath, history).catch(() => undefined);
    if (params?.protect) {
      const set = new Set(protectedStore.threadIds);
      set.add(threadId);
      const meta = {
        ...protectedStore.meta,
        [threadId]: {
          title: typeof params?.title === "string" ? params.title.slice(0, 200) : "",
          addedAt: nowFn(),
        },
      };
      await saveProtectedStore({ threadIds: [...set], meta });
    }
    void refreshCatalogInBackground(true);
    return {
      threadId,
      restored: true,
      protected: Boolean(params?.protect),
      protectedThreadIds: protectedStore.threadIds,
      history,
    };
  });

  ctx.handle("clearHistory", async () => {
    history = [];
    await writeJsonFileAtomic(historyPath, history).catch(() => undefined);
    return { cleared: true };
  });

  return () => {
    disposed = true;
    clearScheduledTimer();
    clearPendingTimer();
  };
}
