# dsh-tray-restart

给 **DeepSeek Harness 官方桌面端** 的 Windows 系统托盘（任务栏通知区）右键菜单加三项：
**「重启应用与 Host」**、**「刷新页面」**（刷新前端）和 **「彻底退出 Harness」**（结束所有
Harness 进程），并在桌面端每次自动更新覆盖 `app.asar` 之后自动重打补丁。

Adds **Restart App and Host**, **Reload Page** (refresh the frontend) and **Force Quit**
(kill every Harness process) items to the Windows system-tray menu of the official
DeepSeek Harness desktop shell, and re-applies the patch after every desktop update.

![tray menu: Open / Restart / Reload Page / Force Quit / Exit](https://img.shields.io/badge/tray%20menu-Open%20%7C%20Restart%20%7C%20Reload%20%7C%20Force%20Quit%20%7C%20Exit-6ea8fe)

---

## 效果 / What you get

托盘菜单从：

```
打开 DeepSeek Harness
────────────
退出 DeepSeek Harness
```

变成：

```
打开 DeepSeek Harness
重启应用与 Host          ← 新增
刷新页面                 ← 新增（刷新前端，Host 不重启）
────────────
彻底退出 Harness         ← 新增（结束所有 Harness 进程）
退出 DeepSeek Harness
```

* **重启应用与 Host**：执行 `app.relaunch(); quitWithoutConfirmation()`，与官方开发版应用菜单
  里的同名项一致——干净退出 Host、重启整个应用，不弹“任务仍在运行”的确认框。
* **刷新页面**：对主窗口执行 `webContents.reload()`，等价于前台按 `Ctrl+R`。只重载前端页面，
  Host、会话和正在跑的任务都不受影响；前端改坏了、白屏或要重新加载界面时用。
* **彻底退出 Harness**：先正常请求退出，同时启动一个脱离应用进程的 PowerShell 清理脚本
  （`%USERPROFILE%\.dsh\dsh-tray-restart\quit-all.ps1`，插件启动时写入）。脚本等待约 1.2 秒后
  强制结束所有匹配的进程：桌面端 Electron 全部进程、`dsh-desktop-host`、`%LOCALAPPDATA%\Programs\DeepSeek Harness\` 下的运行时、`.dsh\profiles` 启动的子进程、rea / Windows-MCP / GitHub-MCP
  以及 `@dsh-ops` 启动的 shell。

前两项复用官方已有的本地化文案（`messages.restartAppHostMenu` / `messages.reloadPageMenu`），
中英文随系统语言切换。

## 安装 / Install

需要 DSH 桌面端 **0.2.x（Windows）**。已在 `@deepseek-ai/dsh-desktop` 0.2.1-rc.2 +
Windows 11 + Node 24 上验证。

**方式一：插件管理器（桌面端推荐）**

1. 把本仓库克隆到任意目录：
   ```bash
   git clone https://github.com/QIRSHENG/dsh-tray-restart.git
   ```
2. 打开 DeepSeek Harness → 设置 → 插件，选择“从本地目录安装”，指向克隆下来的
   `dsh-tray-restart` 目录（就是含 `package.json` 的那一层）。
3. 安装完成后 **完全退出并重新打开** DeepSeek Harness。

桌面端 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝，
所以桌面端请走插件管理器（或由 agent 调用 `plugin_manager` 的 `install_bundle`）。

**方式二：CLI（非桌面端独占的 profile）**

```bash
dsh plugin --profile <profile> add github:QIRSHENG/dsh-tray-restart
# 或本地目录
dsh plugin --profile <profile> add C:\path\to\dsh-tray-restart
```

安装完成后 **完全退出并重新打开** DeepSeek Harness。桌面端主进程代码只在启动时加载，
所以托盘菜单会在下一次启动时出现。

> 安装后如果托盘还没变，先退出应用（托盘 → 退出），在 PowerShell 里运行一次
> `node lib/patcher.mjs status` 确认 `status: "patched"`，再启动应用。

## 为什么需要改 app.asar / Why an asar patch

DSH 插件跑在 Host 子进程里（Cordis），而系统托盘属于 **Electron 主进程**。官方没有暴露
托盘 / Electron 主进程的扩展点，所以插件只能给 `resources/app.asar` 里的
`/lib/main.js` 打一个最小补丁。

补丁的设计约束：

* **等长改写**：托盘菜单模板被压紧，插入两项后用尾部空白补齐，`/lib/main.js` 的
  字节数完全不变 → asar 头里其它文件的 `offset` 全部保持有效。
* **只改托盘这一处**：仅 `DesktopTray.relabel()` 的 `tray.setContextMenu(...)` 模板；
  为腾出字节会同时压缩两段纯注释（不改变任何行为）。锚点不唯一、结构不认识或长度
  会变大时 **拒绝写入**。
* **可升级旧补丁**：1.0.x 只加了重启项；1.1.0 会把旧补丁原地升级成「重启 + 刷新」两项。
* **同步完整性摘要**：同时刷新 asar 目录里 `/lib/main.js` 的 SHA-256（等长 hex），
  即使 `EnableEmbeddedAsarIntegrityValidation` 被打开也不会失配。
* **可回滚**：首次写入前把原始 `/lib/main.js` 保存到
  `%USERPROFILE%\.dsh\dsh-tray-restart\main.original.js`，`restore` 命令可原样写回。
* **幂等**：已经是补丁状态时只做只读检查。

插件在每次 Host 启动约 2 秒后运行一次检查，因此桌面端自动更新把 `app.asar` 换回官方版本后，
下一次启动会自动重打补丁（那一次启动看到的还是旧菜单，再启动一次即可）。

> 更新后的**第一次启动**只负责重打补丁；托盘菜单在**下一次启动**才出现。

## 手动命令 / Manual CLI

任何 Node.js ≥ 20 都可以直接运行补丁器（不需要安装插件）：

```bash
node lib/patcher.mjs status          # 只读检查
node lib/patcher.mjs apply           # 需要时打补丁（幂等）
node lib/patcher.mjs apply --dry-run # 只检查能否安全打补丁
node lib/patcher.mjs restore         # 写回安装前的原始 main.js
```

加 `--json` 输出机器可读结果，加 `--asar <path>` 指定别的 `app.asar`。

默认路径：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`；
也可用环境变量 `DSH_DESKTOP_APP_ASAR` 覆盖。

每次运行的记录在 `%USERPROFILE%\.dsh\dsh-tray-restart\status.json`。

## 卸载 / Uninstall

```bash
# 1. 先还原托盘菜单
node lib/patcher.mjs restore

# 2. 移除插件（桌面端：在插件管理器里移除；其它 profile 用 CLI）
dsh plugin --profile <profile> remove dsh-tray-restart
```

如果 `restore` 报 `size-mismatch`（桌面端版本已经变化），直接重新安装官方桌面端即可。

## 安全边界 / Safety

* 只支持 **官方 Windows 桌面端**（打包的 Electron 应用）；开发模式、`dsh web`、
  `dsh --profile headless` 没有系统托盘，插件会安全跳过。
* 只改写 `/lib/main.js` 中一段已知的托盘菜单模板；任何结构变化都会让补丁**失败而不是写坏文件**。
* 不改注册表、不加启动项、不联网。
* 桌面端升级后若补丁失败，菜单只是保持官方原样，不会影响应用启动。
* 如果应用因任何原因无法启动，先 `node lib/patcher.mjs restore`；仍不行则重装桌面端。

## 已知限制 / Limitations

* 需要重启应用才能看到菜单（主进程代码只在启动时读取）。
* 官方桌面端更新后需要**启动两次**：第一次重打补丁，第二次显示菜单。
* 与其它直接修改 `app.asar` 的工具可能冲突；发现 `status: "unsupported"` 时不要强行写入。
* 非 Windows 平台不支持（macOS 的菜单栏与 Linux 的托盘实现不同）。

## 文件结构 / Layout

```
index.js            Cordis Host 插件：每次 Host 启动检查/重打补丁
lib/patcher.mjs     等长改写补丁器 + CLI（status / apply / restore）
cordis.patch.yml    bundle patch：插入插件行
locale/*.json       插件管理器展示文案
icon.svg            插件图标
```

## 开发 / Development

```bash
node --check index.js
node --test test/patcher.test.mjs     # 用合成 asar 验证打补丁/还原
node lib/patcher.mjs apply --dry-run --json
```

补丁器是纯 ESM、零依赖；只使用 `node:fs`、`node:crypto`、`node:path`。

## License

MIT License © 2026 QIRSHENG
