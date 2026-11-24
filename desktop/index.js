define({
  activate(api) {
    const doc = document;
    const MENU_ITEM_ATTR = "data-cx-aag-desktop-menuitem";
    const BADGE_ATTR = "data-cx-aag-desktop-badge";

    let protectedSet = new Set();
    const rowByElement = new Map();
    const badgeByRow = new Map();
    const injectedMenuItems = new Set();
    let lastTrigger = { threadId: null, title: "", at: 0 };
    let pollTimer = null;

    function isZh() {
      const lang = (doc.documentElement && doc.documentElement.lang) || navigator.language || "en";
      return String(lang).toLowerCase().startsWith("zh");
    }

    function shieldSvg(filled) {
      if (filled) {
        return '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.25 2.5 3.4v4.15c0 3.35 2.32 6.13 5.5 7.2 3.18-1.07 5.5-3.85 5.5-7.2V3.4L8 1.25Zm2.72 5.47-3.25 3.3a.65.65 0 0 1-.93 0L5.2 8.67a.65.65 0 1 1 .93-.91l.88.9 2.78-2.83a.65.65 0 1 1 .93.9Z"/></svg>';
      }
      return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 2.75 3.8v3.75c0 3.05 2.13 5.58 5.25 6.65 3.12-1.07 5.25-3.6 5.25-6.65V3.8L8 1.75Z"/><path d="M5.75 8.15 7.3 9.7l3-3.05"/></svg>';
    }

    function applyProtectedIds(list) {
      protectedSet = new Set(
        (Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && id.trim()),
      );
      syncBadges();
      syncMenus();
    }

    async function refreshProtected() {
      if (api.signal.aborted) return;
      try {
        const result = await api.backend.invoke("getProtected");
        if (result && typeof result === "object" && Array.isArray(result.protectedThreadIds)) {
          applyProtectedIds(result.protectedThreadIds);
        }
      } catch (_err) {
        // Ignore transient backend unavailability during startup.
      }
    }

    function extractTitle(element) {
      const titleNode = element.querySelector("[data-thread-title]");
      if (titleNode && titleNode.textContent) return titleNode.textContent.trim().slice(0, 180);
      return (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
    }

    async function toggleProtect(threadId, title) {
      const nextProtected = !protectedSet.has(threadId);
      if (nextProtected) protectedSet.add(threadId);
      else protectedSet.delete(threadId);
      syncBadges();
      syncMenus();

      try {
        const result = await api.backend.invoke("toggleProtect", {
          threadId,
          protected: nextProtected,
          title,
        });
        if (result && typeof result === "object" && Array.isArray(result.protectedThreadIds)) {
          applyProtectedIds(result.protectedThreadIds);
          try {
            window.dispatchEvent(
              new CustomEvent("cx-aag-protected-changed", {
                detail: { protectedThreadIds: result.protectedThreadIds },
              }),
            );
          } catch (_err) {
            // Ignore.
          }
          return;
        }
      } catch (_err) {
        if (nextProtected) protectedSet.delete(threadId);
        else protectedSet.add(threadId);
        syncBadges();
        syncMenus();
      }
    }

    function syncBadges() {
      if (api.signal.aborted) return;
      const tip = isZh() ? "已常驻防止自动归档" : "Protected from Auto-Archive";
      for (const [element, info] of rowByElement.entries()) {
        if (!element.isConnected || !info.threadId) {
          const old = badgeByRow.get(element);
          if (old) {
            old.remove();
            badgeByRow.delete(element);
          }
          continue;
        }
        const isProtected = protectedSet.has(info.threadId);
        if (isProtected) {
          api.dom.mark(element, "protected");
          let badge = badgeByRow.get(element);
          if (!badge || !badge.isConnected) {
            badge = doc.createElement("span");
            badge.className = "cx-aag-desktop-badge";
            badge.setAttribute(BADGE_ATTR, info.threadId);
            badge.title = tip;
            badge.setAttribute("aria-label", tip);
            badge.innerHTML = shieldSvg(true);
            const anchor = element.querySelector("[data-thread-title]") || element;
            const parent = anchor.parentElement || element;
            api.dom.mount(badge, parent, "append");
            badgeByRow.set(element, badge);
          }
        } else {
          try {
            api.dom.unmark(element, "protected");
          } catch (_err) {
            // Ignore during teardown.
          }
          const badge = badgeByRow.get(element);
          if (badge) {
            badge.remove();
            badgeByRow.delete(element);
          }
        }
      }
    }

    function findActiveDesktopRow() {
      for (const [element, info] of rowByElement.entries()) {
        if (!element.isConnected || !info.threadId) continue;
        if (
          element.querySelector(
            'button[aria-haspopup="menu"][aria-expanded="true"], [data-state="open"][aria-haspopup="menu"]',
          )
        ) {
          return info;
        }
      }
      if (lastTrigger.threadId && Date.now() - lastTrigger.at <= 2500) {
        return lastTrigger;
      }
      return null;
    }

    function isLikelySessionMenu(menu, confirmed) {
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      if (items.length === 0) return false;
      if (confirmed) return true;
      const text = items.map((el) => el.textContent || "").join("\n");
      return /归档|取消归档|置顶|重命名|archive|unarchive|pin|rename|fork/i.test(text);
    }

    function buildDesktopMenuItem(menu, threadId, title) {
      const zh = isZh();
      const isProtected = protectedSet.has(threadId);
      const nativeItem = menu.querySelector('[role="menuitem"]:not([data-cx-aag-desktop-menuitem])');

      const wrap = doc.createElement("div");
      wrap.setAttribute(MENU_ITEM_ATTR, threadId);
      wrap.className = "cx-aag-desktop-menu-wrap";

      const sep = doc.createElement("div");
      sep.className = "cx-aag-desktop-menu-sep";
      sep.setAttribute("role", "separator");

      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.setAttribute("aria-checked", String(isProtected));
      item.setAttribute(MENU_ITEM_ATTR, threadId);
      item.className = [
        nativeItem ? nativeItem.className : "",
        "cx-aag-desktop-menuitem",
        isProtected ? "is-protected" : "",
      ]
        .filter(Boolean)
        .join(" ");

      const icon = doc.createElement("span");
      icon.className = "cx-aag-desktop-icon";
      icon.innerHTML = shieldSvg(isProtected);

      const label = doc.createElement("span");
      label.className = "cx-aag-desktop-label";
      label.textContent = isProtected
        ? zh
          ? "已防止自动归档"
          : "Protected from Auto-Archive"
        : zh
          ? "防止自动归档"
          : "Keep from Auto-Archive";

      const badge = doc.createElement("span");
      badge.className = "cx-aag-desktop-pill";
      badge.textContent = isProtected ? "ON" : "OFF";

      item.append(icon, label, badge);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleProtect(threadId, title);
        doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });

      wrap.append(sep, item);
      return wrap;
    }

    function syncMenus() {
      if (api.signal.aborted) return;
      const menus = doc.querySelectorAll('[role="menu"]');
      for (const menu of menus) {
        if (menu.closest('[role="menu"]') !== menu) continue;
        let confirmed = false;
        let info = null;
        for (const [element, rowInfo] of rowByElement.entries()) {
          if (
            element.isConnected &&
            rowInfo.threadId &&
            element.querySelector(
              'button[aria-haspopup="menu"][aria-expanded="true"], [data-state="open"][aria-haspopup="menu"]',
            )
          ) {
            info = rowInfo;
            confirmed = true;
            break;
          }
        }
        if (!info) info = findActiveDesktopRow();
        if (!info || !info.threadId) continue;
        if (!isLikelySessionMenu(menu, confirmed)) continue;

        const existing = menu.querySelector(`[${MENU_ITEM_ATTR}]`);
        if (existing) {
          const btn = existing.querySelector("button");
          if (
            existing.getAttribute(MENU_ITEM_ATTR) === info.threadId &&
            btn &&
            btn.getAttribute("aria-checked") === String(protectedSet.has(info.threadId))
          ) {
            continue;
          }
          existing.remove();
          injectedMenuItems.delete(existing);
        }

        const entry = buildDesktopMenuItem(menu, info.threadId, info.title);
        const archiveBtn = Array.from(menu.querySelectorAll('[role="menuitem"]')).find((el) =>
          /归档|取消归档|archive|unarchive/i.test(el.textContent || ""),
        );
        if (archiveBtn && archiveBtn.parentElement === menu) {
          api.dom.mount(entry, archiveBtn, "before");
        } else {
          api.dom.mount(entry, menu, "append");
        }
        injectedMenuItems.add(entry);
      }

      for (const node of Array.from(injectedMenuItems)) {
        if (!node.isConnected) injectedMenuItems.delete(node);
      }
    }

    function onInteraction(event) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      for (const [element, info] of rowByElement.entries()) {
        if (element.contains(target) && info.threadId) {
          lastTrigger = {
            threadId: info.threadId,
            title: extractTitle(element),
            at: Date.now(),
          };
          return;
        }
      }
    }

    doc.addEventListener("pointerdown", onInteraction, { capture: true, signal: api.signal });
    doc.addEventListener("contextmenu", onInteraction, { capture: true, signal: api.signal });
    doc.addEventListener("keydown", onInteraction, { capture: true, signal: api.signal });

    const stopRows = api.sidebar.observeRows((rows) => {
      const nextElements = new Set();
      for (const row of rows) {
        if (!row.isLocal || !row.threadId) continue;
        nextElements.add(row.element);
        rowByElement.set(row.element, {
          threadId: row.threadId,
          title: extractTitle(row.element),
        });
      }
      for (const element of Array.from(rowByElement.keys())) {
        if (!nextElements.has(element)) {
          rowByElement.delete(element);
          const badge = badgeByRow.get(element);
          if (badge) {
            badge.remove();
            badgeByRow.delete(element);
          }
        }
      }
      syncBadges();
    });

    const observer = new MutationObserver(() => {
      syncMenus();
    });
    observer.observe(doc.body || doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "data-state"],
    });

    const onProtectedEvent = (event) => {
      if (event && event.detail && Array.isArray(event.detail.protectedThreadIds)) {
        applyProtectedIds(event.detail.protectedThreadIds);
      }
    };
    const onFocus = () => {
      void refreshProtected();
    };
    window.addEventListener("cx-aag-protected-changed", onProtectedEvent, { signal: api.signal });
    window.addEventListener("focus", onFocus, { signal: api.signal });

    void refreshProtected();
    pollTimer = setInterval(() => {
      if (!doc.hidden) void refreshProtected();
    }, 30_000);

    api.track(() => {
      observer.disconnect();
      stopRows();
      if (pollTimer !== null) clearInterval(pollTimer);
      for (const item of injectedMenuItems) item.remove();
      injectedMenuItems.clear();
      for (const badge of badgeByRow.values()) badge.remove();
      badgeByRow.clear();
      rowByElement.clear();
    });
  },
});
