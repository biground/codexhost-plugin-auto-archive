import {
  broadcastProtectedChange,
  createMessages,
  normalizeProtectedIds,
  shieldSvg,
  subscribeProtectedChange,
} from "../shared/common.mjs";

const MENU_ITEM_ATTR = "data-cx-aag-menuitem";
const BADGE_ATTR = "data-cx-aag-badge";
const TOAST_ATTR = "data-cx-aag-toast";
const SESSION_ROW_SELECTOR = '[role="treeitem"][data-row-key]';

export function parseSessionIdFromRowKey(rowKey) {
  if (typeof rowKey !== "string" || !rowKey) return null;
  if (rowKey.startsWith("session:")) {
    return rowKey.slice("session:".length) || null;
  }
  if (rowKey.startsWith("recent:")) {
    return rowKey.slice("recent:".length) || null;
  }
  if (rowKey.startsWith("linked:")) {
    const lastColon = rowKey.lastIndexOf(":");
    if (lastColon > "linked:".length) {
      return rowKey.slice(lastColon + 1) || null;
    }
  }
  return null;
}

function getDocumentLocale(doc) {
  const lang = doc.documentElement?.lang || navigator.language || "en";
  return lang;
}

function extractRowTitle(row) {
  const explicit = row.getAttribute("aria-label");
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 180);
  const text = (row.textContent || "").replace(/\s+/gu, " ").trim();
  return text.slice(0, 180);
}

function findExpandedSessionRow(doc) {
  const expandedTriggers = doc.querySelectorAll(
    `${SESSION_ROW_SELECTOR} button[aria-haspopup="menu"][aria-expanded="true"]`,
  );
  for (const trigger of expandedTriggers) {
    const row = trigger.closest(SESSION_ROW_SELECTOR);
    if (!row) continue;
    const threadId = parseSessionIdFromRowKey(row.getAttribute("data-row-key") || "");
    if (threadId) return { row, threadId };
  }
  return null;
}

function hasExpandedWorkspaceRow(doc) {
  return Boolean(
    doc.querySelector(
      '[role="treeitem"][data-row-key^="workspace:"] button[aria-haspopup="menu"][aria-expanded="true"]',
    ),
  );
}

function isLikelySessionMenu(menu, hasConfirmedTrigger) {
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  if (items.length === 0) return false;
  if (hasConfirmedTrigger) return true;
  const combined = items.map((el) => el.textContent || "").join("\n");
  return /归档|取消归档|置顶|重命名|archive|unarchive|pin|rename|fork/iu.test(combined);
}

export async function activate(api) {
  const doc = document;
  let protectedSet = new Set();
  let lastTrigger = { threadId: null, title: "", at: 0 };
  const mountedBadges = new Map();
  const mountedMenuItems = new Set();
  let toastMount = null;
  let toastTimer = null;
  let pollTimer = null;

  async function refreshProtected() {
    if (api.signal.aborted) return;
    try {
      const res = await api.backend.invoke("getProtected");
      if (api.signal.aborted) return;
      protectedSet = new Set(normalizeProtectedIds(res?.protectedThreadIds));
      syncRowBadges();
      syncOpenMenus();
    } catch {
      // Backend may still be initializing; keep current cache.
    }
  }

  function showToast(text) {
    if (api.signal.aborted) return;
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!toastMount) {
      toastMount = api.dom.mount("app", "append") ?? api.dom.mount(doc.body, "append") ?? null;
      if (toastMount) {
        toastMount.container.setAttribute(TOAST_ATTR, "1");
        toastMount.container.className = "cx-aag-toast-host";
      }
    }
    if (!toastMount) return;
    toastMount.container.replaceChildren();
    const pill = doc.createElement("div");
    pill.className = "cx-aag-toast";
    pill.textContent = text;
    toastMount.container.append(pill);
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastMount?.container.replaceChildren();
    }, 2200);
  }

  async function toggleProtection(threadId, title) {
    const nextProtected = !protectedSet.has(threadId);
    // Optimistic local state update for snappy UI
    if (nextProtected) protectedSet.add(threadId);
    else protectedSet.delete(threadId);
    syncRowBadges();
    syncOpenMenus();

    try {
      const result = await api.backend.invoke("toggleProtect", {
        threadId,
        protected: nextProtected,
        title,
      });
      if (result && typeof result === "object" && Array.isArray(result.protectedThreadIds)) {
        protectedSet = new Set(normalizeProtectedIds(result.protectedThreadIds));
        broadcastProtectedChange([...protectedSet]);
      }
      const msg = createMessages(getDocumentLocale(doc));
      showToast(nextProtected ? msg.menuProtected : msg.unprotectAction);
    } catch (error) {
      // Revert optimistic update on failure
      if (nextProtected) protectedSet.delete(threadId);
      else protectedSet.add(threadId);
      showToast(error instanceof Error ? error.message : String(error));
    }

    syncRowBadges();
    syncOpenMenus();
  }

  function removeBadgeForRow(row) {
    const record = mountedBadges.get(row);
    if (record) {
      record.dispose();
      mountedBadges.delete(row);
    }
    try {
      api.dom.unmark(row, "protected");
    } catch {
      // Ignore if unloading.
    }
  }

  function syncRowBadges() {
    if (api.signal.aborted) return;
    const rows = doc.querySelectorAll(SESSION_ROW_SELECTOR);
    const seen = new Set();
    const msg = createMessages(getDocumentLocale(doc));

    for (const row of rows) {
      const threadId = parseSessionIdFromRowKey(row.getAttribute("data-row-key") || "");
      if (!threadId) continue;
      seen.add(row);
      const isProtected = protectedSet.has(threadId);
      if (isProtected) {
        api.dom.mark(row, "protected");
        const existing = mountedBadges.get(row);
        if (!existing || !existing.container.isConnected) {
          existing?.dispose();
          const hostTarget =
            row.querySelector('[class*="sessionMain"]') ?? row;
          const mounted = api.dom.mount(hostTarget, "append");
          if (mounted) {
            mounted.container.className = "cx-aag-row-badge-wrap";
            mounted.container.setAttribute(BADGE_ATTR, threadId);
            const badge = doc.createElement("span");
            badge.className = "cx-aag-row-badge";
            badge.title = msg.menuProtected;
            badge.setAttribute("aria-label", msg.menuProtected);
            badge.innerHTML = shieldSvg(true);
            mounted.container.append(badge);
            mountedBadges.set(row, mounted);
          }
        }
      } else if (mountedBadges.has(row)) {
        removeBadgeForRow(row);
      }
    }

    for (const [row] of [...mountedBadges]) {
      if (!seen.has(row) || !row.isConnected) {
        removeBadgeForRow(row);
      }
    }
  }

  function buildMenuItemElement(menu, threadId, title) {
    const msg = createMessages(getDocumentLocale(doc));
    const isProtected = protectedSet.has(threadId);

    const nativeItem = menu.querySelector('button[role="menuitem"]:not([data-cx-aag-menuitem])');
    const nativeWrap = nativeItem?.parentElement;
    const nativeIcon = nativeItem?.querySelector("span");
    const nativeLabel = nativeItem?.querySelectorAll("span")?.[1];

    const wrap = doc.createElement("div");
    wrap.setAttribute(MENU_ITEM_ATTR, threadId);
    wrap.className = [nativeWrap?.className || "", "cx-aag-web-menu-wrap"].filter(Boolean).join(" ");

    const separator = doc.createElement("div");
    separator.className = "cx-aag-web-menu-sep";
    separator.setAttribute("role", "separator");

    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.setAttribute("aria-checked", String(isProtected));
    button.setAttribute(MENU_ITEM_ATTR, threadId);
    button.className = [
      nativeItem?.className || "",
      "cx-aag-web-menuitem",
      isProtected ? "is-protected" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const iconSpan = doc.createElement("span");
    iconSpan.className = [nativeIcon?.className || "", "cx-aag-web-icon"].filter(Boolean).join(" ");
    iconSpan.innerHTML = shieldSvg(isProtected);

    const labelSpan = doc.createElement("span");
    labelSpan.className = [nativeLabel?.className || "", "cx-aag-web-label"]
      .filter(Boolean)
      .join(" ");
    labelSpan.textContent = isProtected ? msg.menuProtected : msg.menuProtect;

    const statusSpan = doc.createElement("span");
    statusSpan.className = "cx-aag-web-pill";
    statusSpan.textContent = isProtected ? "ON" : "OFF";

    button.append(iconSpan, labelSpan, statusSpan);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleProtection(threadId, title);
      // Close the menu gracefully via Escape so focus returns naturally.
      doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    wrap.append(separator, button);
    return wrap;
  }

  function injectIntoMenu(menu) {
    if (api.signal.aborted) return;
    if (menu.closest('[role="menu"]') !== menu) return;
    if (hasExpandedWorkspaceRow(doc)) return;

    const expanded = findExpandedSessionRow(doc);
    let threadId = expanded?.threadId ?? null;
    let title = expanded ? extractRowTitle(expanded.row) : "";
    let confirmedTrigger = Boolean(expanded);

    if (!threadId && Date.now() - lastTrigger.at <= 2500 && lastTrigger.threadId) {
      threadId = lastTrigger.threadId;
      title = lastTrigger.title;
      confirmedTrigger = false;
    }

    if (!threadId) return;
    if (!isLikelySessionMenu(menu, confirmedTrigger)) return;

    const container =
      menu.querySelector(':scope > [role="presentation"]') ?? menu;
    const existing = container.querySelector(`[${MENU_ITEM_ATTR}]`);
    if (existing) {
      if (
        existing.getAttribute(MENU_ITEM_ATTR) === threadId &&
        existing.querySelector("button")?.getAttribute("aria-checked") ===
          String(protectedSet.has(threadId))
      ) {
        return;
      }
      existing.remove();
      mountedMenuItems.delete(existing);
    }

    const itemEl = buildMenuItemElement(menu, threadId, title);
    // Insert right before the native Archive / Unarchive menu item when present.
    const nativeItems = [...container.querySelectorAll('button[role="menuitem"]')];
    const archiveItem = nativeItems.find((btn) =>
      /归档|取消归档|archive|unarchive/iu.test(btn.textContent || ""),
    );
    const anchorWrap = archiveItem?.closest("div");
    if (anchorWrap && anchorWrap.parentElement === container) {
      container.insertBefore(itemEl, anchorWrap);
    } else {
      container.append(itemEl);
    }
    mountedMenuItems.add(itemEl);
  }

  function syncOpenMenus() {
    if (api.signal.aborted) return;
    for (const menu of doc.querySelectorAll('[role="menu"]')) {
      injectIntoMenu(menu);
    }
    for (const node of [...mountedMenuItems]) {
      if (!node.isConnected) mountedMenuItems.delete(node);
    }
  }

  function recordInteraction(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const row = target.closest(SESSION_ROW_SELECTOR);
    if (!row) return;
    const threadId = parseSessionIdFromRowKey(row.getAttribute("data-row-key") || "");
    if (!threadId) return;
    lastTrigger = {
      threadId,
      title: extractRowTitle(row),
      at: Date.now(),
    };
  }

  let scheduled = false;
  function scheduleSync() {
    if (scheduled || api.signal.aborted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      syncRowBadges();
      syncOpenMenus();
    });
  }

  doc.addEventListener("pointerdown", recordInteraction, { capture: true, signal: api.signal });
  doc.addEventListener("contextmenu", recordInteraction, { capture: true, signal: api.signal });
  doc.addEventListener("keydown", recordInteraction, { capture: true, signal: api.signal });

  const observer = new MutationObserver(() => {
    scheduleSync();
  });
  observer.observe(doc.body ?? doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "data-row-key"],
  });

  const stopBroadcast = subscribeProtectedChange((ids) => {
    protectedSet = new Set(ids);
    syncRowBadges();
    syncOpenMenus();
  }, api.signal);

  const onFocus = () => {
    void refreshProtected();
  };
  window.addEventListener("focus", onFocus, { signal: api.signal });

  await refreshProtected();
  syncRowBadges();
  syncOpenMenus();
  pollTimer = setInterval(() => {
    if (!doc.hidden) void refreshProtected();
  }, 30_000);

  return () => {
    observer.disconnect();
    stopBroadcast();
    if (toastTimer !== null) clearTimeout(toastTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    for (const item of mountedMenuItems) item.remove();
    mountedMenuItems.clear();
    for (const [row] of [...mountedBadges]) removeBadgeForRow(row);
    toastMount?.dispose();
    toastMount = null;
  };
}
