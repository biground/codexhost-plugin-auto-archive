import {
  createMessages,
  normalizeSettings,
  publishNavigationIntent,
  shieldSvg,
  subscribeProtectedChange,
  subscribeSettingsChange,
} from "../shared/common.mjs";

export const EXTENSION_ID = "auto-archive-guard";
export const DESKTOP_PAGE_ID = `plugin-${EXTENSION_ID}`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function resolveWidgetClickTarget(stats) {
  const expiredCount = Number(stats?.expiredCount ?? 0);
  const pendingCount = Number(stats?.pendingCount ?? 0);
  return expiredCount > 0 || pendingCount > 0 ? "expiring" : "home";
}

function findWebPluginTab(doc, extensionId = EXTENSION_ID) {
  const selector = `[data-plugins-section] [role="tab"][id$="-page-${extensionId}"]`;
  return doc?.querySelector?.(selector) ?? null;
}

function findWebPluginsSidebarButton(doc) {
  if (!doc?.querySelector) return null;
  const direct = doc.querySelector(
    'nav button[aria-label="插件"], nav button[aria-label="Plugins"]',
  );
  if (direct) return direct;
  const candidates = doc.querySelectorAll?.("nav button, button[aria-label]") ?? [];
  for (const btn of candidates) {
    const label = (btn.getAttribute?.("aria-label") || btn.textContent || "").trim();
    if (/^(插件|plugins)$/iu.test(label)) {
      return btn;
    }
  }
  return null;
}

export function openPluginPage({
  doc = typeof document !== "undefined" ? document : null,
  win = typeof window !== "undefined" ? window : null,
  hostTarget = "web",
  signal,
  pollIntervalMs = 80,
  maxAttempts = 40,
} = {}) {
  let retryTimer = null;
  const stopRetry = () => {
    if (retryTimer !== null) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  };
  signal?.addEventListener?.("abort", stopRetry, { once: true });

  const shell = win?.__codexhostSettingsShellV1;
  if (hostTarget === "desktop" || shell) {
    if (shell) {
      if (shell.open && shell.activePageId === DESKTOP_PAGE_ID) {
        return { opened: true, mode: "desktop-active", cancel: stopRetry };
      }
      if (shell.openSettings?.(undefined, DESKTOP_PAGE_ID)) {
        return { opened: true, mode: "desktop-direct", cancel: stopRetry };
      }
      if (shell.openSettings?.(undefined, "desktop-extensions") || shell.openSettings?.()) {
        let attempts = 0;
        retryTimer = setInterval(() => {
          attempts += 1;
          if (signal?.aborted) {
            stopRetry();
            return;
          }
          if (shell.navigateToPage?.(DESKTOP_PAGE_ID) || attempts >= maxAttempts) {
            stopRetry();
          }
        }, pollIntervalMs);
        return { opened: true, mode: "desktop-deferred", cancel: stopRetry };
      }
    }
    const triggerBtn = doc?.querySelector?.("[data-codexhost-settings-trigger] button");
    if (triggerBtn) {
      triggerBtn.click();
      return { opened: true, mode: "desktop-trigger", cancel: stopRetry };
    }
    return { opened: false, mode: "desktop-unavailable", cancel: stopRetry };
  }

  if (doc?.querySelector?.(`[data-host-extension-page="${EXTENSION_ID}"]`)) {
    return { opened: true, mode: "web-active", cancel: stopRetry };
  }

  const existingTab = findWebPluginTab(doc);
  if (existingTab) {
    existingTab.click();
    return { opened: true, mode: "web-tab", cancel: stopRetry };
  }

  const sidebarBtn = findWebPluginsSidebarButton(doc);
  if (sidebarBtn) {
    sidebarBtn.click();
    let attempts = 0;
    const trySelectTab = () => {
      if (signal?.aborted) {
        stopRetry();
        return true;
      }
      if (doc?.querySelector?.(`[data-host-extension-page="${EXTENSION_ID}"]`)) {
        stopRetry();
        return true;
      }
      const tab = findWebPluginTab(doc);
      if (tab) {
        tab.click();
        stopRetry();
        return true;
      }
      return false;
    };
    if (!trySelectTab()) {
      retryTimer = setInterval(() => {
        attempts += 1;
        if (trySelectTab() || attempts >= maxAttempts) {
          stopRetry();
        }
      }, pollIntervalMs);
    }
    return { opened: true, mode: "web-sidebar", cancel: stopRetry };
  }

  return { opened: false, mode: "web-unavailable", cancel: stopRetry };
}

export async function mount(root, api) {
  let locale = api.locale || "en";
  let settings = normalizeSettings(await api.storage.get().catch(() => ({})));
  let stats = { totalActive: 0, expiredCount: 0, pendingCount: 0, protectedActiveCount: 0 };
  let pollTimer = null;
  let cancelNav = null;

  async function syncState() {
    if (api.signal.aborted || !settings.showWidget) return;
    try {
      const result = await api.backend.invoke("getState");
      if (api.signal.aborted) return;
      if (result && typeof result === "object") {
        settings = normalizeSettings(result.settings);
        stats = result.stats ?? stats;
      }
      render();
    } catch {
      // Keep last known widget state if backend is momentarily unavailable.
    }
  }

  function handlePillClick() {
    const target = resolveWidgetClickTarget(stats);
    const win = root.ownerDocument?.defaultView ?? (typeof window !== "undefined" ? window : null);
    publishNavigationIntent(target, { win });
    cancelNav?.();
    const nav = openPluginPage({
      doc: root.ownerDocument,
      win,
      hostTarget: api.hostTarget,
      signal: api.signal,
    });
    cancelNav = nav.cancel;
  }

  function render() {
    if (api.signal.aborted) return;
    if (!settings.showWidget) {
      root.replaceChildren();
      return;
    }
    const msg = createMessages(locale);
    const dueCount = Math.max(Number(stats.expiredCount ?? 0), Number(stats.pendingCount ?? 0));
    const tooltip = dueCount > 0 ? msg.widgetOpenPending(dueCount) : msg.widgetOpenHome;

    root.innerHTML = `
      <div class="aag-widget-layer">
        <div class="aag-widget-shell">
          <button
            type="button"
            class="aag-widget-pill ${dueCount > 0 ? "has-due" : ""}"
            data-w-open
            title="${escapeHtml(tooltip)}"
            aria-label="${escapeHtml(tooltip)}"
          >
            <span class="aag-pill-icon ${settings.enabled ? "is-on" : ""}">${shieldSvg(true)}</span>
            <span class="aag-pill-text">${escapeHtml(settings.enabled ? msg.widgetRunning(settings.retentionDays) : msg.widgetPaused)}</span>
            ${dueCount > 0 ? `<span class="aag-pill-badge is-due">${dueCount}</span>` : ""}
          </button>
        </div>
      </div>
    `;

    root.querySelector("[data-w-open]")?.addEventListener("click", handlePillClick);
  }

  function applySettings(nextSettings) {
    const prevShow = settings.showWidget;
    settings = normalizeSettings(nextSettings);
    render();
    if (settings.showWidget && (!prevShow || stats.totalActive === 0)) {
      void syncState();
    }
  }

  const stopLocale = api.onLocaleChange((nextLocale) => {
    locale = nextLocale;
    render();
  });

  const stopStorage = api.storage.onChange((nextSettings) => {
    applySettings(nextSettings);
  });

  const stopSettingsBroadcast = subscribeSettingsChange((nextSettings) => {
    applySettings(nextSettings);
  }, api.signal);

  const stopBroadcast = subscribeProtectedChange(() => {
    if (settings.showWidget) void syncState();
  }, api.signal);

  const onFocus = () => {
    if (settings.showWidget) void syncState();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("focus", onFocus, { signal: api.signal });
  }

  render();
  if (settings.showWidget) {
    void syncState();
  }
  pollTimer = setInterval(() => {
    if (settings.showWidget && typeof document !== "undefined" && !document.hidden) {
      void syncState();
    }
  }, 120_000);

  return () => {
    stopLocale();
    stopStorage();
    stopSettingsBroadcast();
    stopBroadcast();
    cancelNav?.();
    cancelNav = null;
    if (pollTimer !== null) clearInterval(pollTimer);
    root.replaceChildren();
  };
}
