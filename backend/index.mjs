import { open, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CATALOG_PAGES = 50;
const MAX_HISTORY_ITEMS = 200;
const INITIAL_SWEEP_DELAY_MS = 120_000;
const CATALOG_TTL_MS = 45_000;
const RPC_TIMEOUT_MS = 25_000;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  retentionDays: 30,
  dateField: "updatedAt",
  checkIntervalMinutes: 30,
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
    ? Math.max(5, Math.min(1440, Math.round(rawInterval)))
    : DEFAULT_SETTINGS.checkIntervalMinutes;
  const skipPinned =
    typeof source.skipPinned === "boolean" ? source.skipPinned : DEFAULT_SETTINGS.skipPinned;
  const showWidget =
    typeof source.showWidget === "boolean" ? source.showWidget : DEFAULT_SETTINGS.showWidget;
  return {
    enabled,
    retentionDays,
    dateField,
    checkIntervalMinutes,
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
      return candidate.trim().replace(/\s+/gu, " ").slice(0, 180);
    }
  }
  return typeof thread?.id === "string" ? thread.id : "Untitled Session";
}

export function evaluateThread(thread, options) {
  const { nowMs, settings, protectedSet, pinnedSet, treeNodes, ownershipMap } = options;
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

  return {
    id,
    title: extractThreadTitle(thread),
    cwd: typeof thread?.cwd === "string" ? thread.cwd : "",
    harnessId,
    createdAtMs,
    updatedAtMs,
    referenceMs,
    daysInactive,
    isProtected,
    isPinned,
    isRunning,
    isExpired,
    eligible: Boolean(id) && isExpired && skipReason === null,
    skipReason,
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

export async function readAllActiveThreads(rpc, options = {}) {
  const { onPage, isAborted } = options;
  const byId = new Map();
  const ownershipMap = new Map();

  // Fetch pins & tree snapshot in parallel right away so incremental pages have full guard info.
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
        // Keep only compact metadata fields so memory & IPC stay tiny even with thousands of threads.
        byId.set(thread.id, {
          id: thread.id,
          name: typeof thread.name === "string" ? thread.name : null,
          title: typeof thread.title === "string" ? thread.title : null,
          preview: typeof thread.preview === "string" ? thread.preview.slice(0, 200) : null,
          cwd: typeof thread.cwd === "string" ? thread.cwd : "",
          modelProvider: typeof thread.modelProvider === "string" ? thread.modelProvider : null,
          createdAt: thread.createdAt ?? null,
          updatedAt: thread.updatedAt ?? null,
          recencyAt: thread.recencyAt ?? null,
          status: thread.status ?? null,
          isPinned: Boolean(thread.isPinned),
        });
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
  const historyPath = path.join(ctx.dataDir, "archive-history.json");

  let disposed = false;
  let sweeping = false;
  let sweepProgress = null;
  let timer = null;
  let nextRunAt = null;
  let lastRunAt = null;
  let lastSummary = null;
  let protectedStore = normalizeProtectedStore(await readJsonFile(protectedPath, null));
  let history = await readJsonFile(historyPath, []);
  if (!Array.isArray(history)) history = [];
  history = history.slice(0, MAX_HISTORY_ITEMS);

  // Non-blocking catalog cache so every backend.invoke returns in < 20ms (well under Host's 10s IPC timeout).
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

  async function loadSettings() {
    const raw = await ctx.readSettings();
    return normalizeSettings(raw);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = normalizeSettings({ ...current, ...patch });
    await ctx.writeSettings(next);
    scheduleNext(next);
    return next;
  }

  async function saveProtectedStore(nextStore) {
    protectedStore = normalizeProtectedStore(nextStore);
    await writeJsonFileAtomic(protectedPath, protectedStore);
    return protectedStore;
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
          catalogCache = {
            ...catalogCache,
            hostConnected: false,
            error: null,
          };
          return catalogCache;
        }
        catalogCache.hostConnected = true;
        catalogCache.error = null;
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
    // Prevent unhandled rejection under --unhandled-rejections=strict.
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
        }),
      )
      .filter((item) => item.id)
      .sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
  }

  async function executeSweep({ dryRun = false, trigger = "manual", refresh = true } = {}) {
    if (sweeping) {
      return {
        busy: true,
        dryRun,
        trigger,
        archived: [],
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
      const archived = [];
      const failed = [];
      const archivedIdSet = new Set();
      const runTime = nowFn();

      sweepProgress = dryRun
        ? null
        : {
            trigger,
            startedAt: runTime,
            total: candidates.length,
            processed: 0,
            archivedCount: 0,
            failedCount: 0,
          };

      if (!dryRun) {
        for (const item of candidates) {
          if (disposed) break;
          try {
            await rpc.request("thread/archive", { threadId: item.id });
            archivedIdSet.add(item.id);
            const record = {
              threadId: item.id,
              title: item.title,
              harnessId: item.harnessId,
              cwd: item.cwd,
              archivedAt: nowFn(),
              lastActivityAt: item.updatedAtMs,
              daysInactive: item.daysInactive,
              retentionDays: settings.retentionDays,
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
        if (archived.length > 0) {
          // Immediately remove archived threads from the local catalog cache so UI updates cleanly.
          catalogCache = {
            ...catalogCache,
            threads: catalogCache.threads.filter((t) => !archivedIdSet.has(t.id)),
            updatedAt: nowFn(),
          };
          history = [...archived, ...history].slice(0, MAX_HISTORY_ITEMS);
          await writeJsonFileAtomic(historyPath, history).catch(() => undefined);
        }
      }

      const summary = {
        ranAt: runTime,
        dryRun,
        trigger,
        scannedCount: items.length,
        protectedCount: items.filter((item) => item.isProtected).length,
        eligibleCount: candidates.length,
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
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
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
        : settings.checkIntervalMinutes * 60_000;
    nextRunAt = nowFn() + delayMs;
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      void (async () => {
        let latest = settings;
        try {
          latest = await loadSettings();
          if (latest.enabled) {
            await executeSweep({ dryRun: false, trigger: "auto", refresh: true }).catch(
              () => undefined,
            );
          }
        } catch {
          // Never allow timer callbacks to trigger unhandled rejections.
        } finally {
          if (!disposed) {
            scheduleNext(latest);
          }
        }
      })();
    }, delayMs);
    timer.unref?.();
  }

  const initialSettings = await loadSettings();
  if (options.autoSchedule !== false) {
    scheduleNext(initialSettings, INITIAL_SWEEP_DELAY_MS);
    // Warm up the catalog cache asynchronously right after activation without blocking activate().
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
    } else if (!settings.enabled && nextRunAt !== null) {
      scheduleNext(settings);
    }

    const forceRefresh = Boolean(params?.refresh);
    const online = await rpc.isOnline();
    catalogCache.hostConnected = online;
    if (online && (forceRefresh || catalogCache.updatedAt === 0 || nowFn() - catalogCache.updatedAt >= CATALOG_TTL_MS)) {
      void refreshCatalogInBackground(forceRefresh);
    }

    const items = evaluateCachedThreads(settings);
    const expiring = items.filter((item) => item.eligible);
    return {
      pid: process.pid,
      settings,
      protectedThreadIds: protectedStore.threadIds,
      protectedMeta: protectedStore.meta,
      hostConnected: online,
      hostError: catalogCache.error,
      refreshing: Boolean(catalogRefreshPromise),
      catalogUpdatedAt: catalogCache.updatedAt || null,
      sweeping,
      sweepProgress,
      lastRunAt,
      nextRunAt,
      lastSummary,
      stats: {
        totalActive: items.length,
        expiredCount: expiring.length,
        protectedActiveCount: items.filter((item) => item.isProtected).length,
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
    if (online && (forceRefresh || catalogCache.updatedAt === 0 || nowFn() - catalogCache.updatedAt >= CATALOG_TTL_MS)) {
      void refreshCatalogInBackground(forceRefresh);
    }
    const items = evaluateCachedThreads(settings);
    return {
      settings,
      protectedThreadIds: protectedStore.threadIds,
      hostConnected: online,
      hostError: catalogCache.error,
      refreshing: Boolean(catalogRefreshPromise),
      catalogUpdatedAt: catalogCache.updatedAt || null,
      threads: items,
      nowMs: nowFn(),
    };
  });

  ctx.handle("updateSettings", async (params) => {
    const patch = params && typeof params === "object" && !Array.isArray(params) ? params : {};
    const settings = await saveSettings(patch);
    return { settings, nextRunAt };
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
    if (dryRun) {
      // Fast dry-run directly from cache (or await quick refresh only if cache is empty and synchronous).
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
        trigger: "manual",
        scannedCount: items.length,
        protectedCount: items.filter((item) => item.isProtected).length,
        eligibleCount: candidates.length,
        archivedCount: 0,
        failedCount: 0,
        error: null,
        candidates,
        archived: [],
        failed: [],
      };
    }
    if (asyncMode) {
      if (sweeping) {
        return { started: false, busy: true, sweepProgress };
      }
      void executeSweep({ dryRun: false, trigger: "manual", refresh: false }).catch(
        () => undefined,
      );
      return { started: true, busy: false, sweepProgress };
    }
    return executeSweep({ dryRun: false, trigger: "manual", refresh: true });
  });

  ctx.handle("unarchiveThread", async (params) => {
    const threadId = typeof params?.threadId === "string" ? params.threadId.trim() : "";
    if (!threadId) throw new Error("threadId is required");
    await rpc.request("thread/unarchive", { threadId });
    history = history.filter((item) => item.threadId !== threadId);
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
  };
}
