import {
  broadcastProtectedChange,
  createMessages,
  formatDaysAgo,
  normalizeProtectedIds,
  normalizeSettings,
  shieldSvg,
  subscribeProtectedChange,
} from "../shared/common.mjs";

const COLLAPSED_KEY = "cx.auto-archive-guard.widget.expanded";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function mount(root, api) {
  let locale = api.locale || "en";
  let expanded = false;
  try {
    expanded = localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    expanded = false;
  }

  let settings = normalizeSettings(await api.storage.get().catch(() => ({})));
  let protectedThreadIds = [];
  let stats = { totalActive: 0, expiredCount: 0, protectedActiveCount: 0, expiringPreview: [] };
  let busy = false;
  let notice = "";
  let noticeTimer = null;
  let pollTimer = null;

  function setNotice(text) {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    notice = text;
    render();
    noticeTimer = setTimeout(() => {
      noticeTimer = null;
      notice = "";
      render();
    }, 3000);
  }

  async function syncState() {
    if (api.signal.aborted) return;
    try {
      const result = await api.backend.invoke("getState");
      if (api.signal.aborted) return;
      if (result && typeof result === "object") {
        settings = normalizeSettings(result.settings);
        protectedThreadIds = normalizeProtectedIds(result.protectedThreadIds);
        stats = result.stats ?? stats;
      }
      render();
    } catch {
      // Keep last known widget state if backend is momentarily unavailable.
    }
  }

  async function toggleEnabled() {
    if (busy) return;
    busy = true;
    render();
    try {
      const next = { ...settings, enabled: !settings.enabled };
      const result = await api.backend.invoke("updateSettings", next);
      if (result?.settings) settings = normalizeSettings(result.settings);
      else settings = normalizeSettings(next);
      await syncState();
    } finally {
      busy = false;
      if (!api.signal.aborted) render();
    }
  }

  async function quickSweep() {
    if (busy) return;
    busy = true;
    render();
    const msg = createMessages(locale);
    try {
      await api.backend.invoke("runSweep", { dryRun: false, async: true });
      setNotice(locale.toLowerCase().startsWith("zh") ? "已开始后台归档超期会话…" : "Archiving expired sessions…");
      setTimeout(() => void syncState(), 2000);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      if (!api.signal.aborted) render();
    }
  }

  async function protectThread(threadId, title) {
    if (busy) return;
    busy = true;
    render();
    try {
      const result = await api.backend.invoke("toggleProtect", {
        threadId,
        protected: true,
        title,
      });
      if (result && Array.isArray(result.protectedThreadIds)) {
        protectedThreadIds = normalizeProtectedIds(result.protectedThreadIds);
        broadcastProtectedChange(protectedThreadIds);
      }
      await syncState();
    } finally {
      busy = false;
      if (!api.signal.aborted) render();
    }
  }

  function render() {
    if (api.signal.aborted) return;
    if (!settings.showWidget) {
      root.replaceChildren();
      return;
    }
    const msg = createMessages(locale);
    const preview = Array.isArray(stats.expiringPreview) ? stats.expiringPreview.slice(0, 4) : [];

    root.innerHTML = `
      <div class="aag-widget-layer">
        <div class="aag-widget-shell ${expanded ? "is-expanded" : ""}">
          ${
            expanded
              ? `<div class="aag-widget-panel">
                  <div class="aag-widget-head">
                    <span class="aag-widget-title">${shieldSvg(true)} ${escapeHtml(msg.widgetTitle)}</span>
                    <button type="button" class="aag-w-icon-btn" data-w-toggle aria-label="${escapeHtml(msg.widgetClose)}">✕</button>
                  </div>
                  <div class="aag-widget-summary">
                    <span>${escapeHtml(settings.enabled ? msg.widgetRunning(settings.retentionDays) : msg.widgetPaused)}</span>
                    <span>·</span>
                    <span>${escapeHtml(msg.widgetProtectedShort(protectedThreadIds.length))}</span>
                    <span>·</span>
                    <span class="${stats.expiredCount > 0 ? "is-due" : ""}">${escapeHtml(msg.widgetExpiringShort(stats.expiredCount))}</span>
                  </div>
                  ${notice ? `<div class="aag-widget-notice">${escapeHtml(notice)}</div>` : ""}
                  <div class="aag-widget-preview">
                    ${
                      preview.length === 0
                        ? `<div class="aag-widget-empty">${escapeHtml(msg.widgetNoExpiring)}</div>`
                        : preview
                            .map(
                              (item) => `
                          <div class="aag-widget-item">
                            <div class="aag-widget-item-text">
                              <div class="aag-widget-item-title">${escapeHtml(item.title)}</div>
                              <div class="aag-widget-item-age">${escapeHtml(formatDaysAgo(item.daysInactive, locale))}</div>
                            </div>
                            <button
                              type="button"
                              class="aag-w-keep-btn"
                              data-w-protect="${escapeHtml(item.id)}"
                              data-w-title="${escapeHtml(item.title)}"
                              title="${escapeHtml(msg.protectAction)}"
                            >${shieldSvg(false)}</button>
                          </div>
                        `,
                            )
                            .join("")
                    }
                  </div>
                  <div class="aag-widget-actions">
                    <button type="button" class="aag-w-btn" data-w-enabled ${busy ? "disabled" : ""}>
                      ${escapeHtml(settings.enabled ? msg.widgetPaused : msg.autoEnabled)}
                    </button>
                    <button type="button" class="aag-w-btn is-accent" data-w-sweep ${busy || stats.expiredCount === 0 ? "disabled" : ""}>
                      ${escapeHtml(msg.runNow)}
                    </button>
                  </div>
                </div>`
              : `<button type="button" class="aag-widget-pill" data-w-toggle title="${escapeHtml(msg.widgetOpen)}">
                  <span class="aag-pill-icon ${settings.enabled ? "is-on" : ""}">${shieldSvg(true)}</span>
                  <span class="aag-pill-text">${escapeHtml(settings.enabled ? msg.widgetRunning(settings.retentionDays) : msg.widgetPaused)}</span>
                  ${stats.expiredCount > 0 ? `<span class="aag-pill-badge is-due">${stats.expiredCount}</span>` : ""}
                </button>`
          }
        </div>
      </div>
    `;

    root.querySelector("[data-w-toggle]")?.addEventListener("click", () => {
      expanded = !expanded;
      try {
        localStorage.setItem(COLLAPSED_KEY, expanded ? "1" : "0");
      } catch {
        // Ignore storage errors in restricted contexts.
      }
      render();
      if (expanded) void syncState();
    });

    root.querySelector("[data-w-enabled]")?.addEventListener("click", () => {
      void toggleEnabled();
    });

    root.querySelector("[data-w-sweep]")?.addEventListener("click", () => {
      void quickSweep();
    });

    root.querySelectorAll("[data-w-protect]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-w-protect");
        const title = btn.getAttribute("data-w-title") || "";
        if (id) void protectThread(id, title);
      });
    });
  }

  const stopLocale = api.onLocaleChange((nextLocale) => {
    locale = nextLocale;
    render();
  });

  const stopStorage = api.storage.onChange((nextSettings) => {
    settings = normalizeSettings(nextSettings);
    render();
    void syncState();
  });

  const stopBroadcast = subscribeProtectedChange((ids) => {
    protectedThreadIds = ids;
    render();
    void syncState();
  }, api.signal);

  render();
  void syncState();
  pollTimer = setInterval(() => {
    if (!document.hidden) void syncState();
  }, 120_000);

  return () => {
    stopLocale();
    stopStorage();
    stopBroadcast();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    root.replaceChildren();
  };
}
