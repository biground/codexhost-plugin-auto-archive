import {
  broadcastProtectedChange,
  broadcastSettingsChange,
  consumeNavigationIntent,
  createMessages,
  formatCountdown,
  formatDaysAgo,
  formatTimestamp,
  normalizeProtectedIds,
  normalizeSettings,
  shieldSvg,
  subscribeNavigationIntent,
  subscribeProtectedChange,
} from "../shared/common.mjs";

const RETENTION_PRESETS = [3, 7, 14, 30, 60, 90];
const GRACE_PRESETS = [0, 15, 30, 60, 120];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function mount(root, api) {
  let locale = api.locale || "en";
  const initialIntent = consumeNavigationIntent({ win: root.ownerDocument?.defaultView });
  let pendingScrollTarget =
    initialIntent === "expiring" ? "list" : initialIntent === "home" ? "top" : null;
  let state = {
    settings: normalizeSettings(await api.storage.get().catch(() => ({}))),
    protectedThreadIds: [],
    hostConnected: false,
    hostError: null,
    lastRunAt: null,
    nextRunAt: null,
    nextPendingDueAt: null,
    nowMs: Date.now(),
    projects: [],
    stats: { totalActive: 0, expiredCount: 0, pendingCount: 0, protectedActiveCount: 0, archivedCount: 0 },
    threads: [],
    archived: [],
    history: [],
    loading: true,
    refreshing: false,
    archivedRefreshing: false,
    saving: false,
    sweeping: false,
    sweepProgress: null,
    activeTab: "sessions",
    filter: initialIntent === "expiring" ? "expiring" : "all",
    archivedFilter: "all",
    search: "",
    archivedSearch: "",
    expandedProjects: new Set(),
    banner: null,
    bannerTone: "info",
    confirmPendingCount: null,
  };

  function scrollToTarget(target) {
    if (!target || api.signal.aborted) return;
    const node =
      target === "list"
        ? root.querySelector(".aag-list-card")
        : root.querySelector(".aag-page");
    node?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function applyNavigationIntent(view, shouldRefresh = true) {
    if (view === "expiring") {
      state.activeTab = "sessions";
      state.filter = "expiring";
      state.search = "";
      render();
      scrollToTarget("list");
      if (shouldRefresh) void refreshAll(true);
    } else if (view === "home") {
      state.activeTab = "sessions";
      state.filter = "all";
      state.search = "";
      render();
      scrollToTarget("top");
      if (shouldRefresh) void refreshAll(true);
    }
  }

  let bannerTimer = null;
  let refreshTimer = null;
  let fastPollTimer = null;

  function scheduleFastPoll(active) {
    if (fastPollTimer !== null) {
      clearTimeout(fastPollTimer);
      fastPollTimer = null;
    }
    if (active && !api.signal.aborted) {
      fastPollTimer = setTimeout(() => {
        fastPollTimer = null;
        void refreshAll(true, false);
      }, 1500);
    }
  }

  function showBanner(text, tone = "info") {
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    state.banner = text;
    state.bannerTone = tone;
    render();
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      state.banner = null;
      render();
    }, 4500);
  }

  async function refreshAll(silent = false, forceRefresh = false) {
    if (api.signal.aborted) return;
    if (!silent) {
      state.loading = true;
      render();
    }
    const wasSweeping = state.sweeping;
    try {
      const includeArchived = state.activeTab === "history" || forceRefresh;
      const [backendState, threadList, archivedList] = await Promise.all([
        api.backend.invoke("getState", forceRefresh ? { refresh: true } : undefined),
        api.backend.invoke("listThreads", forceRefresh ? { refresh: true } : undefined).catch(() => null),
        includeArchived
          ? api.backend.invoke("listArchived", forceRefresh ? { refresh: true } : undefined).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (api.signal.aborted) return;
      if (backendState && typeof backendState === "object") {
        state.settings = normalizeSettings(backendState.settings);
        state.protectedThreadIds = normalizeProtectedIds(backendState.protectedThreadIds);
        if (Array.isArray(backendState.projects)) state.projects = backendState.projects;
        state.hostConnected = Boolean(backendState.hostConnected);
        state.hostError = backendState.hostError ?? null;
        state.refreshing = Boolean(backendState.refreshing);
        state.archivedRefreshing = Boolean(backendState.archivedRefreshing);
        state.sweeping = Boolean(backendState.sweeping);
        state.sweepProgress = backendState.sweepProgress ?? null;
        state.lastRunAt = backendState.lastRunAt ?? null;
        state.nextRunAt = backendState.nextRunAt ?? null;
        state.nextPendingDueAt = backendState.nextPendingDueAt ?? null;
        state.nowMs = backendState.nowMs ?? Date.now();
        state.stats = backendState.stats ?? state.stats;
        state.history = Array.isArray(backendState.history) ? backendState.history : [];
        if (wasSweeping && !state.sweeping && backendState.lastSummary) {
          const msg = createMessages(locale);
          showBanner(
            msg.sweepDone(
              backendState.lastSummary.archivedCount ?? 0,
              backendState.lastSummary.failedCount ?? 0,
            ),
            "success",
          );
        }
      }
      if (threadList && Array.isArray(threadList.threads)) {
        state.threads = threadList.threads;
        if (Array.isArray(threadList.projects) && threadList.projects.length > 0) {
          state.projects = threadList.projects;
        }
        state.nowMs = threadList.nowMs ?? Date.now();
        state.refreshing = state.refreshing || Boolean(threadList.refreshing);
        state.stats = {
          ...state.stats,
          totalActive: threadList.threads.length,
          expiredCount: threadList.threads.filter((item) => item.eligible).length,
          pendingCount: threadList.threads.filter((item) => item.pendingDueAt !== null).length,
          protectedActiveCount: threadList.threads.filter((item) => item.isProtected).length,
        };
      }
      if (archivedList && Array.isArray(archivedList.archived)) {
        state.archived = archivedList.archived;
        if (Array.isArray(archivedList.projects) && archivedList.projects.length > 0) {
          state.projects = archivedList.projects;
        }
        state.archivedRefreshing = Boolean(archivedList.refreshing);
        state.stats = {
          ...state.stats,
          archivedCount: archivedList.archived.length,
        };
      }
      scheduleFastPoll(state.refreshing || state.archivedRefreshing || state.sweeping);
    } catch (error) {
      state.hostConnected = false;
      state.hostError = error instanceof Error ? error.message : String(error);
      scheduleFastPoll(false);
    } finally {
      state.loading = false;
      if (!api.signal.aborted) render();
    }
  }

  async function saveRules(patch) {
    if (state.saving || api.signal.aborted) return;
    state.saving = true;
    render();
    try {
      const next = normalizeSettings({ ...state.settings, ...patch });
      const result = await api.backend.invoke("updateSettings", next);
      if (result && typeof result === "object" && result.settings) {
        state.settings = normalizeSettings(result.settings);
        state.nextRunAt = result.nextRunAt ?? state.nextRunAt;
      } else {
        state.settings = next;
      }
      broadcastSettingsChange(state.settings);
      const msg = createMessages(locale);
      showBanner(msg.saved, "success");
      await refreshAll(true);
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      state.saving = false;
      if (!api.signal.aborted) render();
    }
  }

  async function handleToggleProtect(threadId, title) {
    try {
      const result = await api.backend.invoke("toggleProtect", { threadId, title });
      if (result && typeof result === "object" && Array.isArray(result.protectedThreadIds)) {
        state.protectedThreadIds = normalizeProtectedIds(result.protectedThreadIds);
        broadcastProtectedChange(state.protectedThreadIds);
      }
      await refreshAll(true);
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error), "danger");
    }
  }

  async function handleRunSweep(dryRun) {
    if (state.sweeping || api.signal.aborted) return;
    state.sweeping = true;
    state.confirmPendingCount = null;
    render();
    const msg = createMessages(locale);
    try {
      if (dryRun) {
        const result = await api.backend.invoke("runSweep", { dryRun: true, async: true });
        state.sweeping = false;
        showBanner(msg.dryRunResult(result?.eligibleCount ?? 0), "info");
        await refreshAll(true, false);
      } else {
        await api.backend.invoke("runSweep", { dryRun: false, async: true });
        scheduleFastPoll(true);
        await refreshAll(true, false);
      }
    } catch (error) {
      state.sweeping = false;
      showBanner(error instanceof Error ? error.message : String(error), "danger");
      if (!api.signal.aborted) render();
    }
  }

  async function handleUnarchive(threadId, title, protect) {
    const msg = createMessages(locale);
    try {
      const res = await api.backend.invoke("unarchiveThread", { threadId, title, protect });
      if (res && Array.isArray(res.protectedThreadIds)) {
        state.protectedThreadIds = normalizeProtectedIds(res.protectedThreadIds);
        broadcastProtectedChange(state.protectedThreadIds);
      }
      showBanner(protect ? msg.restoredProtectedToast : msg.restoredToast, "success");
      await refreshAll(true);
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error), "danger");
    }
  }

  async function handleClearHistory() {
    try {
      await api.backend.invoke("clearHistory");
      state.history = [];
      render();
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error), "danger");
    }
  }

  function filteredThreads() {
    const query = state.search.trim().toLowerCase();
    return state.threads.filter((item) => {
      if (state.filter === "expiring" && !item.eligible) return false;
      if (state.filter === "protected" && !item.isProtected) return false;
      if (!query) return true;
      return (
        (item.title || "").toLowerCase().includes(query) ||
        (item.projectName || "").toLowerCase().includes(query) ||
        (item.cwd || "").toLowerCase().includes(query) ||
        (item.id || "").toLowerCase().includes(query) ||
        (item.harnessId || "").toLowerCase().includes(query)
      );
    });
  }

  function filteredArchived() {
    const query = state.archivedSearch.trim().toLowerCase();
    return state.archived.filter((item) => {
      if (state.archivedFilter === "plugin" && !item.isPluginArchived) return false;
      if (!query) return true;
      return (
        (item.title || "").toLowerCase().includes(query) ||
        (item.projectName || "").toLowerCase().includes(query) ||
        (item.cwd || "").toLowerCase().includes(query) ||
        (item.threadId || "").toLowerCase().includes(query) ||
        (item.harnessId || "").toLowerCase().includes(query)
      );
    });
  }

  function groupArchivedByProject(items, msg) {
    const UNGROUPED_KEY = "__ungrouped__";
    const orderMap = new Map();
    state.projects.forEach((p, idx) => orderMap.set(p.id, idx));

    const groups = new Map();
    for (const item of items) {
      const key = item.projectId || UNGROUPED_KEY;
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: item.projectId ? item.projectName || item.projectId : msg.ungroupedProject,
          isUngrouped: !item.projectId,
          order: item.projectId ? (orderMap.get(item.projectId) ?? 10_000) : 99_999,
          items: [],
        };
        groups.set(key, group);
      }
      group.items.push(item);
    }

    return [...groups.values()].sort((a, b) => {
      if (a.isUngrouped !== b.isUngrouped) return a.isUngrouped ? 1 : -1;
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });
  }

  function render() {
    if (api.signal.aborted) return;
    const msg = createMessages(locale);
    const s = state.settings;
    const visibleThreads = filteredThreads();
    const visibleArchived = filteredArchived();
    const archivedGroups = groupArchivedByProject(visibleArchived, msg);
    const archivedTotal = state.archived.length || state.stats.archivedCount || state.history.length;

    root.innerHTML = `
      <div class="aag-page">
        <header class="aag-header">
          <div class="aag-header-main">
            <div class="aag-title-row">
              <span class="aag-logo">${shieldSvg(true)}</span>
              <div>
                <h1 class="aag-title">${escapeHtml(msg.title)}</h1>
                <p class="aag-subtitle">${escapeHtml(msg.subtitle)}</p>
              </div>
            </div>
            <div class="aag-status-pill ${state.hostConnected ? "is-online" : "is-offline"}">
              <span class="aag-dot"></span>
              <span>${escapeHtml(state.hostConnected ? msg.hostOnline : msg.hostOffline)}</span>
            </div>
          </div>
          <p class="aag-tip">${escapeHtml(msg.menuTip)}</p>
        </header>

        ${
          state.banner
            ? `<div class="aag-banner is-${escapeHtml(state.bannerTone)}" role="status">${escapeHtml(state.banner)}</div>`
            : ""
        }
        ${
          state.hostError && state.hostError !== state.banner
            ? `<div class="aag-banner is-danger" role="alert">${escapeHtml(state.hostError)}</div>`
            : ""
        }
        ${
          state.sweepProgress
            ? `<div class="aag-banner is-info" role="status">${escapeHtml(
                locale.toLowerCase().startsWith("zh")
                  ? `正在归档超期会话：${state.sweepProgress.processed} / ${state.sweepProgress.total}（成功 ${state.sweepProgress.archivedCount}）…`
                  : `Archiving expired sessions: ${state.sweepProgress.processed} / ${state.sweepProgress.total} (${state.sweepProgress.archivedCount} archived)…`,
              )}</div>`
            : state.activeTab === "history" && state.archivedRefreshing
              ? `<div class="aag-banner is-info" role="status">${escapeHtml(msg.syncArchivedHint)} (${state.archived.length})</div>`
              : state.refreshing && state.threads.length === 0
                ? `<div class="aag-banner is-info" role="status">${escapeHtml(msg.syncActiveHint)}</div>`
                : ""
        }

        <section class="aag-stats">
          <div class="aag-stat-card">
            <div class="aag-stat-label">${escapeHtml(msg.statTotal)}</div>
            <div class="aag-stat-value">${state.stats.totalActive}</div>
          </div>
          <div class="aag-stat-card is-accent">
            <div class="aag-stat-label">${escapeHtml(msg.statProtected)}</div>
            <div class="aag-stat-value">${state.protectedThreadIds.length}</div>
          </div>
          <div class="aag-stat-card is-clickable ${state.stats.expiredCount > 0 ? "is-warn" : ""}" data-jump-expiring role="button" tabindex="0">
            <div class="aag-stat-label">${escapeHtml(msg.statExpiring)}</div>
            <div class="aag-stat-value">${state.stats.expiredCount}</div>
          </div>
          <div class="aag-stat-card">
            <div class="aag-stat-label">${escapeHtml(msg.statArchived)}</div>
            <div class="aag-stat-value">${archivedTotal}</div>
          </div>
        </section>

        <section class="aag-card aag-rules-card">
          <div class="aag-rules-grid">
            <label class="aag-toggle-field">
              <input type="checkbox" data-field="enabled" ${s.enabled ? "checked" : ""} />
              <span>${escapeHtml(msg.autoEnabled)}</span>
            </label>

            <label class="aag-toggle-field">
              <input type="checkbox" data-field="skipPinned" ${s.skipPinned ? "checked" : ""} />
              <span>${escapeHtml(msg.skipPinned)}</span>
            </label>

            <label class="aag-toggle-field">
              <input type="checkbox" data-field="showWidget" ${s.showWidget ? "checked" : ""} />
              <span>${escapeHtml(msg.showWidget)}</span>
            </label>
          </div>

          <div class="aag-inputs-grid">
            <div class="aag-field">
              <label for="aag-days">${escapeHtml(msg.retentionDays)}</label>
              <div class="aag-days-row">
                <input id="aag-days" type="number" min="1" max="3650" step="1" data-field="retentionDays" value="${s.retentionDays}" />
                <div class="aag-presets">
                  ${RETENTION_PRESETS.map(
                    (d) =>
                      `<button type="button" class="aag-chip ${s.retentionDays === d ? "is-active" : ""}" data-preset-days="${d}">${d}${escapeHtml(msg.daysUnit)}</button>`,
                  ).join("")}
                </div>
              </div>
            </div>

            <div class="aag-field">
              <label for="aag-date-field">${escapeHtml(msg.dateField)}</label>
              <select id="aag-date-field" data-field="dateField">
                <option value="updatedAt" ${s.dateField === "updatedAt" ? "selected" : ""}>${escapeHtml(msg.dateUpdated)}</option>
                <option value="createdAt" ${s.dateField === "createdAt" ? "selected" : ""}>${escapeHtml(msg.dateCreated)}</option>
              </select>
            </div>

            <div class="aag-field">
              <label for="aag-interval">${escapeHtml(msg.scanInterval)}</label>
              <input id="aag-interval" type="number" min="5" max="10080" step="5" data-field="checkIntervalMinutes" value="${s.checkIntervalMinutes}" />
            </div>

            <div class="aag-field">
              <label for="aag-grace">${escapeHtml(msg.graceMinutes)} <span class="aag-label-hint">(${escapeHtml(msg.graceZeroHint)})</span></label>
              <div class="aag-days-row">
                <input id="aag-grace" type="number" min="0" max="10080" step="5" data-field="graceMinutes" value="${s.graceMinutes}" />
                <div class="aag-presets">
                  ${GRACE_PRESETS.map(
                    (m) =>
                      `<button type="button" class="aag-chip ${s.graceMinutes === m ? "is-active" : ""}" data-preset-grace="${m}">${m}${escapeHtml(msg.minsUnit)}</button>`,
                  ).join("")}
                </div>
              </div>
            </div>
          </div>

          <div class="aag-actions-bar">
            <div class="aag-schedule-meta">
              <span>${escapeHtml(msg.lastScan)}: <strong>${escapeHtml(formatTimestamp(state.lastRunAt, locale))}</strong></span>
              <span>·</span>
              <span>${escapeHtml(msg.nextScan)}: <strong>${escapeHtml(s.enabled ? formatTimestamp(state.nextRunAt, locale) : msg.widgetPaused)}</strong></span>
              ${
                state.nextPendingDueAt
                  ? `<span>·</span><span>${escapeHtml(msg.nextDue)}: <strong>${escapeHtml(formatCountdown(state.nextPendingDueAt, state.nowMs, locale))}</strong></span>`
                  : ""
              }
            </div>
            <div class="aag-btn-group">
              <button type="button" class="aag-btn" data-action="refresh" ${state.loading ? "disabled" : ""}>${escapeHtml(msg.refresh)}</button>
              <button type="button" class="aag-btn" data-action="dryRun" ${state.sweeping ? "disabled" : ""}>${escapeHtml(msg.dryRun)}</button>
              <button type="button" class="aag-btn is-danger" data-action="askRunNow" ${state.sweeping || state.stats.expiredCount === 0 ? "disabled" : ""}>${escapeHtml(msg.runNow)}${state.stats.expiredCount > 0 ? ` (${state.stats.expiredCount})` : ""}</button>
              <button type="button" class="aag-btn is-primary" data-action="save" ${state.saving ? "disabled" : ""}>${escapeHtml(state.saving ? msg.saving : msg.saveSettings)}</button>
            </div>
          </div>

          ${
            state.confirmPendingCount !== null
              ? `<div class="aag-confirm-box">
                  <span>${escapeHtml(msg.confirmArchive(state.confirmPendingCount))}</span>
                  <div class="aag-btn-group">
                    <button type="button" class="aag-btn" data-action="cancelRunNow">Cancel</button>
                    <button type="button" class="aag-btn is-danger" data-action="confirmRunNow">${escapeHtml(msg.runNow)}</button>
                  </div>
                </div>`
              : ""
          }
        </section>

        <section class="aag-card aag-list-card">
          <div class="aag-tabs-bar">
            <div class="aag-tabs">
              <button type="button" class="aag-tab ${state.activeTab === "sessions" ? "is-active" : ""}" data-tab="sessions">
                ${escapeHtml(msg.tabSessions)} (${state.threads.length})
              </button>
              <button type="button" class="aag-tab ${state.activeTab === "history" ? "is-active" : ""}" data-tab="history">
                ${escapeHtml(msg.tabHistory)} (${archivedTotal})
              </button>
            </div>

            ${
              state.activeTab === "sessions"
                ? `<div class="aag-filter-tools">
                    <div class="aag-filter-pills">
                      <button type="button" class="aag-chip ${state.filter === "all" ? "is-active" : ""}" data-filter="all">${escapeHtml(msg.filterAll)}</button>
                      <button type="button" class="aag-chip ${state.filter === "expiring" ? "is-active" : ""}" data-filter="expiring">${escapeHtml(msg.filterExpiring)} (${state.stats.expiredCount})</button>
                      <button type="button" class="aag-chip ${state.filter === "protected" ? "is-active" : ""}" data-filter="protected">${escapeHtml(msg.filterProtected)} (${state.stats.protectedActiveCount})</button>
                    </div>
                    <input type="search" class="aag-search" data-search value="${escapeHtml(state.search)}" placeholder="${escapeHtml(msg.searchPlaceholder)}" />
                  </div>`
                : `<div class="aag-filter-tools">
                    <div class="aag-filter-pills">
                      <button type="button" class="aag-chip ${state.archivedFilter === "all" ? "is-active" : ""}" data-archived-filter="all">${escapeHtml(msg.filterArchivedAll)} (${state.archived.length})</button>
                      <button type="button" class="aag-chip ${state.archivedFilter === "plugin" ? "is-active" : ""}" data-archived-filter="plugin">${escapeHtml(msg.filterArchivedPlugin)} (${state.history.length})</button>
                    </div>
                    <input type="search" class="aag-search" data-archived-search value="${escapeHtml(state.archivedSearch)}" placeholder="${escapeHtml(msg.searchArchivedPlaceholder)}" />
                    ${
                      archivedGroups.length > 0
                        ? `<button type="button" class="aag-btn" data-action="expandAll">${escapeHtml(msg.expandAll)}</button>
                           <button type="button" class="aag-btn" data-action="collapseAll">${escapeHtml(msg.collapseAll)}</button>`
                        : ""
                    }
                    ${
                      state.history.length > 0
                        ? `<button type="button" class="aag-btn" data-action="clearHistory">${escapeHtml(msg.clearHistory)}</button>`
                        : ""
                    }
                  </div>`
            }
          </div>

          ${
            state.activeTab === "sessions"
              ? renderSessionRows(visibleThreads, msg)
              : renderArchivedGroups(archivedGroups, msg)
          }
        </section>
      </div>
    `;

    bindEvents();
  }

  function renderSessionRows(items, msg) {
    if (items.length === 0) {
      return `<div class="aag-empty">${escapeHtml(msg.noSessions)}</div>`;
    }
    return `<div class="aag-rows">
      ${items
        .map((item) => {
          const tags = [];
          if (item.isProtected) {
            tags.push(`<span class="aag-tag is-protected">${shieldSvg(true)} ${escapeHtml(msg.keepProtected)}</span>`);
          }
          if (item.isRunning) {
            tags.push(`<span class="aag-tag is-running">${escapeHtml(msg.badgeRunning)}</span>`);
          }
          if (item.isPinned) {
            tags.push(`<span class="aag-tag">${escapeHtml(msg.badgePinned)}</span>`);
          }
          if (item.pendingDueAt !== null) {
            tags.push(
              `<span class="aag-tag is-expired">${escapeHtml(formatCountdown(item.pendingDueAt, state.nowMs, locale))}</span>`,
            );
          } else if (item.eligible) {
            tags.push(`<span class="aag-tag is-expired">${escapeHtml(msg.badgeExpired)}</span>`);
          }
          return `
            <div class="aag-row ${item.eligible ? "is-expired-row" : ""} ${item.isProtected ? "is-protected-row" : ""}">
              <div class="aag-row-info">
                <div class="aag-row-title-line">
                  <span class="aag-row-title">${escapeHtml(item.title)}</span>
                  <span class="aag-harness-tag">${escapeHtml(item.harnessId || "codex")}</span>
                  ${item.projectName ? `<span class="aag-tag aag-project-tag">${escapeHtml(item.projectName)}</span>` : ""}
                  ${tags.join("")}
                </div>
                <div class="aag-row-meta">
                  <span>${escapeHtml(formatDaysAgo(item.daysInactive, locale))}</span>
                  <span>·</span>
                  <span>${escapeHtml(formatTimestamp(item.referenceMs, locale))}</span>
                  ${item.cwd ? `<span>·</span><span class="aag-cwd">${escapeHtml(item.cwd)}</span>` : ""}
                </div>
              </div>
              <button
                type="button"
                class="aag-protect-btn ${item.isProtected ? "is-active" : ""}"
                data-toggle-protect="${escapeHtml(item.id)}"
                data-title="${escapeHtml(item.title)}"
              >
                ${shieldSvg(item.isProtected)}
                <span>${escapeHtml(item.isProtected ? msg.unprotectAction : msg.protectAction)}</span>
              </button>
            </div>
          `;
        })
        .join("")}
    </div>`;
  }

  function renderArchivedGroups(groups, msg) {
    if (groups.length === 0) {
      return `<div class="aag-empty">${escapeHtml(msg.noHistory)}</div>`;
    }
    const searching = state.archivedSearch.trim().length > 0;
    return `<div class="aag-groups">
      ${groups
        .map((group) => {
          const collapsed = !searching && !state.expandedProjects.has(group.key);
          return `
            <div class="aag-group ${collapsed ? "is-collapsed" : ""}">
              <button type="button" class="aag-group-header" data-toggle-group="${escapeHtml(group.key)}" aria-expanded="${String(!collapsed)}">
                <span class="aag-chevron">${collapsed ? "▸" : "▾"}</span>
                <span class="aag-group-icon">${group.isUngrouped ? "🗂️" : "📁"}</span>
                <span class="aag-group-name">${escapeHtml(group.name)}</span>
                <span class="aag-group-count">${group.items.length}</span>
              </button>
              ${
                collapsed
                  ? ""
                  : `<div class="aag-group-body">
                      ${group.items
                        .map(
                          (item) => `
                        <div class="aag-row">
                          <div class="aag-row-info">
                            <div class="aag-row-title-line">
                              <span class="aag-row-title">${escapeHtml(item.title || item.threadId)}</span>
                              <span class="aag-harness-tag">${escapeHtml(item.harnessId || "codex")}</span>
                              ${
                                item.isPluginArchived
                                  ? `<span class="aag-tag is-protected">${escapeHtml(item.trigger === "auto" ? msg.triggerAuto : msg.triggerManual)}</span>`
                                  : ""
                              }
                            </div>
                            <div class="aag-row-meta">
                              <span>${escapeHtml(formatTimestamp(item.archivedAt ?? item.updatedAtMs, locale))}</span>
                              ${item.daysInactive != null ? `<span>·</span><span>${escapeHtml(formatDaysAgo(item.daysInactive, locale))}</span>` : ""}
                              ${item.cwd ? `<span>·</span><span class="aag-cwd">${escapeHtml(item.cwd)}</span>` : ""}
                            </div>
                          </div>
                          <div class="aag-btn-group">
                            <button type="button" class="aag-btn" data-restore="${escapeHtml(item.threadId)}" data-title="${escapeHtml(item.title || "")}">${escapeHtml(msg.restore)}</button>
                            <button type="button" class="aag-btn is-primary" data-restore-protect="${escapeHtml(item.threadId)}" data-title="${escapeHtml(item.title || "")}">${escapeHtml(msg.restoreAndProtect)}</button>
                          </div>
                        </div>
                      `,
                        )
                        .join("")}
                    </div>`
              }
            </div>
          `;
        })
        .join("")}
    </div>`;
  }

  function readFormValues() {
    const enabled = root.querySelector('[data-field="enabled"]')?.checked ?? state.settings.enabled;
    const skipPinned =
      root.querySelector('[data-field="skipPinned"]')?.checked ?? state.settings.skipPinned;
    const showWidget =
      root.querySelector('[data-field="showWidget"]')?.checked ?? state.settings.showWidget;
    const retentionDays = Number(
      root.querySelector('[data-field="retentionDays"]')?.value ?? state.settings.retentionDays,
    );
    const dateField =
      root.querySelector('[data-field="dateField"]')?.value ?? state.settings.dateField;
    const checkIntervalMinutes = Number(
      root.querySelector('[data-field="checkIntervalMinutes"]')?.value ??
        state.settings.checkIntervalMinutes,
    );
    const graceMinutes = Number(
      root.querySelector('[data-field="graceMinutes"]')?.value ?? state.settings.graceMinutes,
    );
    return {
      enabled,
      skipPinned,
      showWidget,
      retentionDays,
      dateField,
      checkIntervalMinutes,
      graceMinutes,
    };
  }

  function bindEvents() {
    root.querySelectorAll("[data-preset-days]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const days = Number(btn.getAttribute("data-preset-days"));
        const input = root.querySelector('[data-field="retentionDays"]');
        if (input) input.value = String(days);
        void saveRules({ ...readFormValues(), retentionDays: days });
      });
    });

    root.querySelectorAll("[data-preset-grace]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mins = Number(btn.getAttribute("data-preset-grace"));
        const input = root.querySelector('[data-field="graceMinutes"]');
        if (input) input.value = String(mins);
        void saveRules({ ...readFormValues(), graceMinutes: mins });
      });
    });

    root.querySelector('[data-action="save"]')?.addEventListener("click", () => {
      void saveRules(readFormValues());
    });

    root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
      void refreshAll(false, true);
    });

    root.querySelector('[data-action="dryRun"]')?.addEventListener("click", () => {
      void handleRunSweep(true);
    });

    root.querySelector('[data-action="askRunNow"]')?.addEventListener("click", () => {
      const msg = createMessages(locale);
      if (state.stats.expiredCount <= 0) {
        showBanner(msg.noExpiredToArchive, "info");
        return;
      }
      state.confirmPendingCount = state.stats.expiredCount;
      render();
    });

    root.querySelector('[data-action="cancelRunNow"]')?.addEventListener("click", () => {
      state.confirmPendingCount = null;
      render();
    });

    root.querySelector('[data-action="confirmRunNow"]')?.addEventListener("click", () => {
      void handleRunSweep(false);
    });

    root.querySelector('[data-action="clearHistory"]')?.addEventListener("click", () => {
      void handleClearHistory();
    });

    root.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextTab = btn.getAttribute("data-tab") || "sessions";
        state.activeTab = nextTab;
        render();
        if (nextTab === "history" && state.archived.length === 0) {
          void refreshAll(true, false);
        }
      });
    });

    root.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.getAttribute("data-filter") || "all";
        render();
      });
    });

    root.querySelectorAll("[data-archived-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.archivedFilter = btn.getAttribute("data-archived-filter") || "all";
        render();
      });
    });

    root.querySelectorAll("[data-toggle-group]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-toggle-group");
        if (!key) return;
        if (state.expandedProjects.has(key)) state.expandedProjects.delete(key);
        else state.expandedProjects.add(key);
        render();
      });
    });

    root.querySelector('[data-action="expandAll"]')?.addEventListener("click", () => {
      const msg = createMessages(locale);
      const groups = groupArchivedByProject(filteredArchived(), msg);
      state.expandedProjects = new Set(groups.map((g) => g.key));
      render();
    });

    root.querySelector('[data-action="collapseAll"]')?.addEventListener("click", () => {
      state.expandedProjects.clear();
      render();
    });

    const searchInput = root.querySelector("[data-search]");
    if (searchInput) {
      searchInput.addEventListener("input", (event) => {
        state.search = event.target.value || "";
        const pos = event.target.selectionStart ?? state.search.length;
        render();
        const nextInput = root.querySelector("[data-search]");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(pos, pos);
        }
      });
    }

    const archivedSearchInput = root.querySelector("[data-archived-search]");
    if (archivedSearchInput) {
      archivedSearchInput.addEventListener("input", (event) => {
        state.archivedSearch = event.target.value || "";
        const pos = event.target.selectionStart ?? state.archivedSearch.length;
        render();
        const nextInput = root.querySelector("[data-archived-search]");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(pos, pos);
        }
      });
    }

    root.querySelectorAll("[data-toggle-protect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-toggle-protect");
        const title = btn.getAttribute("data-title") || "";
        if (id) void handleToggleProtect(id, title);
      });
    });

    root.querySelectorAll("[data-restore]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-restore");
        const title = btn.getAttribute("data-title") || "";
        if (id) void handleUnarchive(id, title, false);
      });
    });

    root.querySelectorAll("[data-restore-protect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-restore-protect");
        const title = btn.getAttribute("data-title") || "";
        if (id) void handleUnarchive(id, title, true);
      });
    });

    const expiringCard = root.querySelector("[data-jump-expiring]");
    if (expiringCard) {
      const jump = () => applyNavigationIntent("expiring", false);
      expiringCard.addEventListener("click", jump);
      expiringCard.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          jump();
        }
      });
    }
  }

  const stopLocale = api.onLocaleChange((nextLocale) => {
    locale = nextLocale;
    render();
  });

  const stopStorage = api.storage.onChange((nextSettings) => {
    state.settings = normalizeSettings(nextSettings);
    void refreshAll(true);
  });

  const stopBroadcast = subscribeProtectedChange((ids) => {
    state.protectedThreadIds = ids;
    void refreshAll(true);
  }, api.signal);

  const stopNavigation = subscribeNavigationIntent(
    (view) => {
      pendingScrollTarget = null;
      applyNavigationIntent(view, true);
    },
    api.signal,
    { win: root.ownerDocument?.defaultView },
  );

  render();
  if (pendingScrollTarget) {
    scrollToTarget(pendingScrollTarget);
  }
  await refreshAll(false);
  if (pendingScrollTarget) {
    const target = pendingScrollTarget;
    pendingScrollTarget = null;
    scrollToTarget(target);
  }
  refreshTimer = setInterval(() => {
    if (!document.hidden) void refreshAll(true);
  }, 60_000);

  return () => {
    stopLocale();
    stopStorage();
    stopBroadcast();
    stopNavigation();
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    if (refreshTimer !== null) clearInterval(refreshTimer);
    if (fastPollTimer !== null) clearTimeout(fastPollTimer);
    root.replaceChildren();
  };
}
