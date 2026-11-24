import {
  broadcastProtectedChange,
  createMessages,
  formatDaysAgo,
  formatTimestamp,
  normalizeProtectedIds,
  normalizeSettings,
  shieldSvg,
  subscribeProtectedChange,
} from "../shared/common.mjs";

const RETENTION_PRESETS = [7, 14, 30, 60, 90];

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
  let state = {
    settings: normalizeSettings(await api.storage.get().catch(() => ({}))),
    protectedThreadIds: [],
    hostConnected: false,
    hostError: null,
    lastRunAt: null,
    nextRunAt: null,
    stats: { totalActive: 0, expiredCount: 0, protectedActiveCount: 0 },
    threads: [],
    history: [],
    loading: true,
    saving: false,
    sweeping: false,
    activeTab: "sessions",
    filter: "all",
    search: "",
    banner: null,
    bannerTone: "info",
    confirmPendingCount: null,
  };

  let bannerTimer = null;
  let refreshTimer = null;

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

  async function refreshAll(silent = false) {
    if (api.signal.aborted) return;
    if (!silent) {
      state.loading = true;
      render();
    }
    try {
      const [backendState, threadList] = await Promise.all([
        api.backend.invoke("getState"),
        api.backend.invoke("listThreads").catch(() => null),
      ]);
      if (api.signal.aborted) return;
      if (backendState && typeof backendState === "object") {
        state.settings = normalizeSettings(backendState.settings);
        state.protectedThreadIds = normalizeProtectedIds(backendState.protectedThreadIds);
        state.hostConnected = Boolean(backendState.hostConnected);
        state.hostError = backendState.hostError ?? null;
        state.lastRunAt = backendState.lastRunAt ?? null;
        state.nextRunAt = backendState.nextRunAt ?? null;
        state.stats = backendState.stats ?? state.stats;
        state.history = Array.isArray(backendState.history) ? backendState.history : [];
      }
      if (threadList && Array.isArray(threadList.threads)) {
        state.threads = threadList.threads;
        state.stats = {
          totalActive: threadList.threads.length,
          expiredCount: threadList.threads.filter((item) => item.eligible).length,
          protectedActiveCount: threadList.threads.filter((item) => item.isProtected).length,
        };
      }
    } catch (error) {
      state.hostConnected = false;
      state.hostError = error instanceof Error ? error.message : String(error);
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
      const result = await api.backend.invoke("runSweep", { dryRun });
      if (dryRun) {
        showBanner(msg.dryRunResult(result?.eligibleCount ?? 0), "info");
      } else {
        showBanner(msg.sweepDone(result?.archivedCount ?? 0, result?.failedCount ?? 0), "success");
      }
      await refreshAll(true);
    } catch (error) {
      showBanner(error instanceof Error ? error.message : String(error), "danger");
    } finally {
      state.sweeping = false;
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
        (item.cwd || "").toLowerCase().includes(query) ||
        (item.id || "").toLowerCase().includes(query) ||
        (item.harnessId || "").toLowerCase().includes(query)
      );
    });
  }

  function render() {
    if (api.signal.aborted) return;
    const msg = createMessages(locale);
    const s = state.settings;
    const visibleThreads = filteredThreads();

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
          state.hostError
            ? `<div class="aag-banner is-danger" role="alert">${escapeHtml(state.hostError)}</div>`
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
          <div class="aag-stat-card ${state.stats.expiredCount > 0 ? "is-warn" : ""}">
            <div class="aag-stat-label">${escapeHtml(msg.statExpiring)}</div>
            <div class="aag-stat-value">${state.stats.expiredCount}</div>
          </div>
          <div class="aag-stat-card">
            <div class="aag-stat-label">${escapeHtml(msg.statArchived)}</div>
            <div class="aag-stat-value">${state.history.length}</div>
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
              <input id="aag-interval" type="number" min="5" max="1440" step="5" data-field="checkIntervalMinutes" value="${s.checkIntervalMinutes}" />
            </div>
          </div>

          <div class="aag-actions-bar">
            <div class="aag-schedule-meta">
              <span>${escapeHtml(msg.lastScan)}: <strong>${escapeHtml(formatTimestamp(state.lastRunAt, locale))}</strong></span>
              <span>·</span>
              <span>${escapeHtml(msg.nextScan)}: <strong>${escapeHtml(s.enabled ? formatTimestamp(state.nextRunAt, locale) : msg.widgetPaused)}</strong></span>
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
                ${escapeHtml(msg.tabHistory)} (${state.history.length})
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
                : state.history.length > 0
                  ? `<button type="button" class="aag-btn" data-action="clearHistory">${escapeHtml(msg.clearHistory)}</button>`
                  : ""
            }
          </div>

          ${
            state.activeTab === "sessions"
              ? renderSessionRows(visibleThreads, msg)
              : renderHistoryRows(state.history, msg)
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
          if (item.eligible) {
            tags.push(`<span class="aag-tag is-expired">${escapeHtml(msg.badgeExpired)}</span>`);
          }
          return `
            <div class="aag-row ${item.eligible ? "is-expired-row" : ""} ${item.isProtected ? "is-protected-row" : ""}">
              <div class="aag-row-info">
                <div class="aag-row-title-line">
                  <span class="aag-row-title">${escapeHtml(item.title)}</span>
                  <span class="aag-harness-tag">${escapeHtml(item.harnessId || "codex")}</span>
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

  function renderHistoryRows(items, msg) {
    if (items.length === 0) {
      return `<div class="aag-empty">${escapeHtml(msg.noHistory)}</div>`;
    }
    return `<div class="aag-rows">
      ${items
        .map(
          (item) => `
        <div class="aag-row">
          <div class="aag-row-info">
            <div class="aag-row-title-line">
              <span class="aag-row-title">${escapeHtml(item.title || item.threadId)}</span>
              <span class="aag-harness-tag">${escapeHtml(item.harnessId || "codex")}</span>
              <span class="aag-tag">${escapeHtml(item.trigger === "auto" ? msg.triggerAuto : msg.triggerManual)}</span>
            </div>
            <div class="aag-row-meta">
              <span>${escapeHtml(formatTimestamp(item.archivedAt, locale))}</span>
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
    return {
      enabled,
      skipPinned,
      showWidget,
      retentionDays,
      dateField,
      checkIntervalMinutes,
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

    root.querySelector('[data-action="save"]')?.addEventListener("click", () => {
      void saveRules(readFormValues());
    });

    root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
      void refreshAll(false);
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
        state.activeTab = btn.getAttribute("data-tab") || "sessions";
        render();
      });
    });

    root.querySelectorAll("[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filter = btn.getAttribute("data-filter") || "all";
        render();
      });
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

  render();
  await refreshAll(false);
  refreshTimer = setInterval(() => {
    if (!document.hidden) void refreshAll(true);
  }, 60_000);

  return () => {
    stopLocale();
    stopStorage();
    stopBroadcast();
    if (bannerTimer !== null) clearTimeout(bannerTimer);
    if (refreshTimer !== null) clearInterval(refreshTimer);
    root.replaceChildren();
  };
}
