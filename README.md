# Auto Archive & Keep Guard (`auto-archive-guard`)

CodexHost 统一 Host 扩展（`manifestVersion: 2`），同时支持 **Codex Desktop** 与 **CodexHost Web / PWA**：

- **定时自动归档 + 延迟缓冲期**：由共享 Host 单实例 `backend` 按指定天数阈值定时扫描不活跃会话（默认 **3 天**、每 **1440 分钟 / 24 小时**扫描一次）；扫描命中超期会话后默认延迟 **30 分钟**再正式归档（`graceMinutes`，可调，填 `0` 为立即归档），期间随时可一键保护撤回。即使关闭 Desktop 与 Web 窗口也会持续运行。
- **每个会话「更多（`...`）」菜单常驻防止归档**：通过 `web` 与 `desktop` 入口，在每个会话的「更多」菜单（及右键菜单）中常驻注入 **防止自动归档 / Keep from Auto-Archive** 开关；受保护的会话在侧边栏显示盾牌标记，永久规避自动归档。
- **跨端独立管理页（`page`）+ 主窗口挂件（`widget`）**：支持快速调整天数阈值、预览待归档列表（Dry Run）、手动立即归档、搜索并批量管理受保护会话，以及在归档历史中一键恢复（或恢复并设为常驻保护）。
- **多重安全保护**：自动跳过运行中/等待输入中的会话，默认跳过置顶会话。

## 安装与启用

### 从 GitHub 远程一键安装（推荐）
在 **Codex Desktop「设置 → 插件」** 或 **CodexHost Web「插件 → 插件中心」** 中选择从 GitHub 安装，输入：

```text
biground/codexhost-plugin-auto-archive
```

或完整地址：

```text
https://github.com/biground/codexhost-plugin-auto-archive
```

### 从本地 ZIP 安装
1. 在 **Codex Desktop「设置 → 插件」** 或 **CodexHost Web「插件 → 插件中心」** 导入 `auto-archive-guard-1.0.0.zip`（可从 [Releases](https://github.com/biground/codexhost-plugin-auto-archive/releases) 下载，或本地执行 `node scripts/build-zip.mjs` 生成）。
2. 启用 **自动归档与常驻保护** 后：
   - Desktop 可从插件卡片或「设置」左侧 **插件页面 → 自动归档** 打开独立管理页；
   - Web 可从左侧 **插件** 工作区顶部的**切页栏**直接切换到 **自动归档** 独立页面；
   - 双端侧边栏每个会话的 `...` 更多菜单（及右键菜单）将出现常驻 **防止自动归档** 保护开关，主窗口右下角显示轻量状态挂件。

## 本地打包与测试

```bash
npm run build
npm test
```

打包产物位于 `dist/auto-archive-guard-1.0.0.zip`（`manifest.json` 位于压缩包根目录）。

## 发布到 GitHub

1. 将本目录推送到公开 GitHub 仓库（确保仓库根目录包含 `manifest.json`）。
2. 创建正式 Release（例如 `v1.0.0`），并将 `dist/auto-archive-guard-1.0.0.zip` 作为 Release Asset 上传。
3. 用户即可直接在 CodexHost「插件中心」粘贴你的 GitHub 仓库链接导入，或直接下载 `.zip` 导入。
