# CLAUDE.md — 项目约定（给 AI 协作者看）

本文件是 WebSurface 项目的开发约定。修改本项目前请先读完这里，避免破坏既定设计。

## 项目是什么

本地 Web 版 PowerShell 会话管理器：在浏览器里按「项目 → 任务」两级分类，管理多个
claude / codex / 纯 powershell 终端会话。会话由服务器持有，与浏览器解耦（关网页不中断，
重开可重连回放）。纯局域网自用，无账号、无 HTTPS、不连互联网。

## 技术栈（已定，不要更换）

- 后端：Node.js + Express + WebSocket(`ws`) + node-pty
- node-pty 用 `@homebridge/node-pty-prebuilt-multiarch`，**版本锁定 `0.13.1`**
  （唯一提供 Node 24 / ABI v137 Windows 预编译二进制的版本，见 README「已知问题」）。
  不要随手升级；升级前必须先确认目标版本对当前 Node ABI 有 win32-x64 预编译包。
- 前端：**原生 HTML/CSS/JS + xterm.js**（含 fit addon）。不要引入 React/Vue 等框架，
  不要引入构建工具（无 webpack/vite/ts 编译步骤）。
- xterm 资源本地化在 `public/vendor/`，**不走 CDN**（局域网离线可用）。
- 持久化：本地 JSON 文件 `data/projects.json`，**不要引入数据库**。
- 运行环境：Windows 11，服务器监听 `0.0.0.0` 供局域网访问。

## 浏览器兼容

以 Firefox 为基准，兼容 Chrome / Safari / 移动端。**不使用仅 Chromium 支持的 API。**

## 代码约定

- 全部源文件 UTF-8 编码；中文注释/文案直接写，不要转义。
- CommonJS（`require`/`module.exports`），与现有代码一致，不要改成 ESM。
- WebSocket 消息是 JSON，`{type, ...}` 结构，协议表见 README「架构速览」。
  新增消息类型时同步更新 README 那张表。
- 服务器启动必须打印本机与局域网访问地址（`server/index.js`）。
- 改动 `data/projects.json` 的结构时，`server/store.js` 要保持向后兼容读取。

## 目录职责

见 README「架构速览 → 目录职责」，不在此重复。改代码前先定位到对应文件：
- 数据/CRUD → `server/store.js` + `server/routes.js`
- 终端会话/pty → `server/sessions.js`
- 侧边栏/项目任务 UI → `public/js/app.js`
- 终端渲染/WebSocket 客户端 → `public/js/terminal.js`

## 分阶段开发（重要工作方式）

项目按阶段推进，**每个阶段完成后停下来告诉用户如何验证，等确认再进入下一阶段**：

- [x] 阶段1：服务器 + 项目/任务 CRUD + 侧边栏 UI
- [x] 阶段2：pty 会话 + xterm 终端流
- [x] 阶段3：上下分屏输入区、可靠大文本发送、终止进程按钮、断线重连回放
- [ ] 阶段4：移动端适配与打磨（含复制去行尾空格，缓解 ConPTY 折行问题）
- [ ] 阶段5：Git 版本管理（git init + .gitignore 排除 node_modules/ 和 data/projects.json + 提交历史；可仅本地）
- [ ] 阶段6：claude 无头可读模式（TUI ⇄ 可读聊天流双视图切换）
  - 背景：claude 是全屏 TUI，靠 ANSI 光标定位反复重绘整块屏幕，直接喂 xterm 会「换行乱、难复制」。
  - 做法：claude 任务**默认走原生 TUI**（`/model` `/skills` `/plugin` plan mode 等全保留），
    一键切到**无头可读模式**看干净可复制的聊天流；需要斜杠命令时再切回 TUI。两视图并存。
  - 无头链路：`claude -p --output-format stream-json --verbose`（`child_process.spawn`，无需 pty），
    逐行解析结构化 JSON（system/assistant/result）→ 新增 `hl_*` WebSocket 消息 → 前端渲染聊天气泡。
    多轮靠 `--resume <session_id>` 续接；不加 npm 依赖。
  - 仅 `kind === 'claude'` 的任务提供该切换；`powershell` / `codex` 保持纯 TUI 不变。

## 明确不做

- 不做用户登录、不做 HTTPS、不连接互联网。
- 不做「同时弹出真实 PowerShell 窗口并镜像」：网页终端本身就是窗口。
- 第一版不做「一个任务多个并行会话」「会话历史归档」（架构可扩展，但先不写）。
- 无头可读模式（阶段6）**不解析斜杠命令**（`/model` `/plugin` `/skills` `/clear` 等是 TUI 交互层功能）；
  需要这些请切回 TUI 视图。无头模式也没有 plan mode / 实时 Esc 打断。

## 验证与调试提示

- 启动：`cd D:\Proj02_WebSurface && npm start`，浏览器开 `http://localhost:3000`
  （改过前端记得 Ctrl+F5 强刷清缓存）。
- 端到端测终端：建任务 → 点开 → 终端出提示符 → 输命令有回显 → 徽标变绿。
- 停服务器：对应 PowerShell 窗口 Ctrl+C，或 `Stop-Process -Name node`。
- `AttachConsole failed` 是 kill 时的已知无害噪音，别当成 bug 去改 node_modules。

## 数据安全

`data/projects.json` 是唯一真实数据，改动删除类逻辑要谨慎，破坏性操作先跟用户确认。
