export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  retentionDays: 30,
  dateField: "updatedAt",
  checkIntervalMinutes: 30,
  skipPinned: true,
  showWidget: true,
});

export const SYNC_CHANNEL_NAME = "codexhost-auto-archive-guard-sync";

export function isZhLocale(locale) {
  return typeof locale === "string" && locale.toLowerCase().startsWith("zh");
}

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

export function normalizeProtectedIds(list) {
  const set = new Set();
  if (Array.isArray(list)) {
    for (const id of list) {
      if (typeof id === "string" && id.trim()) set.add(id.trim());
    }
  }
  return [...set];
}

export function broadcastProtectedChange(protectedThreadIds) {
  const ids = normalizeProtectedIds(protectedThreadIds);
  try {
    window.dispatchEvent(
      new CustomEvent("cx-aag-protected-changed", { detail: { protectedThreadIds: ids } }),
    );
  } catch {
    // Ignore outside browser environments.
  }
  try {
    if (typeof BroadcastChannel === "function") {
      const ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
      ch.postMessage({ type: "protected", protectedThreadIds: ids });
      ch.close();
    }
  } catch {
    // Ignore when BroadcastChannel is unavailable.
  }
}

export function subscribeProtectedChange(listener, signal) {
  const onCustom = (event) => {
    const ids = event?.detail?.protectedThreadIds;
    if (Array.isArray(ids)) listener(normalizeProtectedIds(ids));
  };
  try {
    window.addEventListener("cx-aag-protected-changed", onCustom, { signal });
  } catch {
    // Ignore outside browser environments.
  }
  let ch = null;
  try {
    if (typeof BroadcastChannel === "function") {
      ch = new BroadcastChannel(SYNC_CHANNEL_NAME);
      ch.onmessage = (event) => {
        const ids = event?.data?.protectedThreadIds;
        if (Array.isArray(ids)) listener(normalizeProtectedIds(ids));
      };
    }
  } catch {
    ch = null;
  }
  const cleanup = () => {
    try {
      window.removeEventListener("cx-aag-protected-changed", onCustom);
    } catch {
      // Ignore.
    }
    ch?.close();
    ch = null;
  };
  signal?.addEventListener?.("abort", cleanup, { once: true });
  return cleanup;
}

export function formatTimestamp(ms, locale) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return isZhLocale(locale) ? "暂无" : "Never";
  }
  try {
    return new Intl.DateTimeFormat(isZhLocale(locale) ? "zh-CN" : "en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

export function formatDaysAgo(days, locale) {
  if (typeof days !== "number" || !Number.isFinite(days)) {
    return isZhLocale(locale) ? "未知" : "Unknown";
  }
  if (days < 1) {
    const hours = Math.max(0, Math.floor(days * 24));
    if (isZhLocale(locale)) return hours <= 0 ? "1 小时内" : `${hours} 小时前`;
    return hours <= 0 ? "< 1h ago" : `${hours}h ago`;
  }
  const whole = Math.floor(days);
  return isZhLocale(locale) ? `${whole} 天前` : `${whole}d ago`;
}

export function createMessages(locale) {
  const zh = isZhLocale(locale);
  if (zh) {
    return {
      title: "自动归档与常驻保护",
      subtitle: "定时归档长期不活跃会话，支持在每个会话的「更多」菜单中一键设置常驻防归档。",
      hostOnline: "共享 Host 已连接",
      hostOffline: "等待共享 Host 连接",
      autoEnabled: "启用自动归档",
      retentionDays: "归档阈值（天）",
      dateField: "计算基准",
      dateUpdated: "最后活跃时间",
      dateCreated: "创建时间",
      scanInterval: "扫描间隔（分钟）",
      skipPinned: "自动跳过置顶会话",
      showWidget: "显示主窗口悬浮挂件",
      saveSettings: "保存规则",
      saving: "保存中…",
      saved: "规则已保存",
      dryRun: "试运行预览",
      runNow: "立即归档超期会话",
      refresh: "刷新",
      statProtected: "常驻防归档",
      statExpiring: "待归档（已超期）",
      statTotal: "活跃会话总数",
      statArchived: "累计自动归档",
      lastScan: "上次扫描",
      nextScan: "下次计划",
      tabSessions: "会话保护列表",
      tabHistory: "归档记录",
      filterAll: "全部",
      filterExpiring: "已超期",
      filterProtected: "已保护",
      searchPlaceholder: "按会话标题、目录或 ID 搜索…",
      keepProtected: "防归档中",
      protectAction: "设为防归档",
      unprotectAction: "取消防归档",
      badgeRunning: "运行中",
      badgePinned: "置顶",
      badgeExpired: "将自动归档",
      badgeSafe: "安全期",
      noSessions: "暂无匹配的活跃会话",
      noHistory: "尚无自动归档记录",
      restore: "取消归档",
      restoreAndProtect: "恢复并防归档",
      clearHistory: "清空记录",
      confirmArchive: (count) => `确认立即归档 ${count} 个已超期且未受保护的会话吗？`,
      noExpiredToArchive: "当前没有需要归档的超期会话。",
      sweepDone: (archived, failed) =>
        failed > 0
          ? `已归档 ${archived} 个会话，${failed} 个失败。`
          : `本次已归档 ${archived} 个超期会话。`,
      dryRunResult: (count) =>
        count > 0
          ? `试运行完成：命中 ${count} 个待归档会话（未执行实际归档）。`
          : "试运行完成：当前没有符合归档条件的会话。",
      restoredToast: "已恢复会话",
      restoredProtectedToast: "已恢复会话并设为常驻防归档",
      menuProtect: "防止自动归档",
      menuProtected: "已防止自动归档",
      menuTip: "提示：可在任意会话的「更多（…）」菜单中快速切换常驻防归档。",
      widgetTitle: "自动归档",
      widgetPaused: "已暂停",
      widgetRunning: (days) => `超 ${days} 天`,
      widgetProtectedShort: (n) => `${n} 保护`,
      widgetExpiringShort: (n) => `${n} 待归档`,
      widgetClose: "收起",
      widgetOpen: "展开面板",
      widgetNoExpiring: "所有会话均处于安全期或已受保护",
      daysUnit: "天",
      triggerAuto: "定时自动",
      triggerManual: "手动触发",
    };
  }
  return {
    title: "Auto Archive & Keep Guard",
    subtitle: "Automatically archive stale sessions while protecting key threads from each session's More menu.",
    hostOnline: "Shared Host Connected",
    hostOffline: "Waiting for Shared Host",
    autoEnabled: "Enable Auto-Archive",
    retentionDays: "Archive After (Days)",
    dateField: "Age Reference",
    dateUpdated: "Last Activity",
    dateCreated: "Creation Time",
    scanInterval: "Scan Interval (Min)",
    skipPinned: "Skip Pinned Sessions",
    showWidget: "Show Floating Widget",
    saveSettings: "Save Rules",
    saving: "Saving…",
    saved: "Rules saved",
    dryRun: "Dry-Run Preview",
    runNow: "Archive Expired Now",
    refresh: "Refresh",
    statProtected: "Protected",
    statExpiring: "Ready to Archive",
    statTotal: "Active Sessions",
    statArchived: "Archived History",
    lastScan: "Last Scan",
    nextScan: "Next Scan",
    tabSessions: "Session Guard List",
    tabHistory: "Archive History",
    filterAll: "All",
    filterExpiring: "Expired",
    filterProtected: "Protected",
    searchPlaceholder: "Search by title, workspace, or thread ID…",
    keepProtected: "Protected",
    protectAction: "Keep Protected",
    unprotectAction: "Remove Guard",
    badgeRunning: "Running",
    badgePinned: "Pinned",
    badgeExpired: "Expired",
    badgeSafe: "Active",
    noSessions: "No matching active sessions",
    noHistory: "No auto-archived sessions yet",
    restore: "Unarchive",
    restoreAndProtect: "Restore & Protect",
    clearHistory: "Clear History",
    confirmArchive: (count) => `Archive ${count} expired unprotected session(s) now?`,
    noExpiredToArchive: "No expired unprotected sessions to archive.",
    sweepDone: (archived, failed) =>
      failed > 0
        ? `Archived ${archived} session(s), ${failed} failed.`
        : `Archived ${archived} expired session(s).`,
    dryRunResult: (count) =>
      count > 0
        ? `Dry run found ${count} session(s) eligible for auto-archive.`
        : "Dry run complete: no sessions match the auto-archive threshold.",
    restoredToast: "Session restored",
    restoredProtectedToast: "Session restored and protected",
    menuProtect: "Keep from Auto-Archive",
    menuProtected: "Protected from Auto-Archive",
    menuTip: "Tip: Toggle Keep from Auto-Archive directly inside any session's More (…) menu.",
    widgetTitle: "Auto Archive",
    widgetPaused: "Paused",
    widgetRunning: (days) => `>${days}d`,
    widgetProtectedShort: (n) => `${n} kept`,
    widgetExpiringShort: (n) => `${n} due`,
    widgetClose: "Collapse",
    widgetOpen: "Expand",
    widgetNoExpiring: "All sessions are fresh or protected",
    daysUnit: "d",
    triggerAuto: "Scheduled",
    triggerManual: "Manual",
  };
}

export function shieldSvg(filled = false) {
  if (filled) {
    return `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.25 2.5 3.4v4.15c0 3.35 2.32 6.13 5.5 7.2 3.18-1.07 5.5-3.85 5.5-7.2V3.4L8 1.25Zm2.72 5.47-3.25 3.3a.65.65 0 0 1-.93 0L5.2 8.67a.65.65 0 1 1 .93-.91l.88.9 2.78-2.83a.65.65 0 1 1 .93.9Z"/></svg>`;
  }
  return `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.75 2.75 3.8v3.75c0 3.05 2.13 5.58 5.25 6.65 3.12-1.07 5.25-3.6 5.25-6.65V3.8L8 1.75Z"/><path d="M5.75 8.15 7.3 9.7l3-3.05"/></svg>`;
}
