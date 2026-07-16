初衷：使用codex/claude codex时，多任务并行干活的时候，总是要打开很多窗口。来回切换窗口非常麻烦，所以做了这个将terminal统一放到一个网页的项目。

小白随便vibe coding的项目。
欢迎大家狠狠提建议！有空就改。
欢迎下载改造，牛马们也要有适合自己的vibe coding 界面。



------------------ 分割线 ------------------


# WebSurface · 本地 Web 版会话管理器

在浏览器里按「项目 → 任务」两级分类管理多个 PowerShell / claude / codex 终端会话。
会话由服务器持有，关掉网页也不中断，重开页面可重连并恢复内容。纯局域网使用，无需账号和 HTTPS。

> [!WARNING]
> WebSurface 默认监听 `0.0.0.0`，且不提供登录、鉴权或 HTTPS。任何能够访问该端口的设备都可能浏览本机目录名称并操作 PowerShell 终端。只应在受信任的专用局域网中运行，并使用 Windows 防火墙限制访问；不要暴露到互联网、公共 Wi-Fi 或端口转发环境。

## 环境要求

- Windows 11
- Node.js 18 及以上（本项目在 Node 24 上开发）

## 安装

```bash
npm install
```

> node-pty（终端进程库）使用预编译版本 `@homebridge/node-pty-prebuilt-multiarch`，
> 版本**锁定在 `0.13.1`**（这是目前唯一提供 Node 24 / ABI v137 Windows 预编译二进制的版本，
> 见「已知问题」）。国内网络建议用镜像安装，通常无需 Visual Studio 编译工具链：
>
> ```bash
> set prebuild_install_mirror=https://registry.npmmirror.com/-/binary/node-pty-prebuilt-multiarch/
> npm install --registry=https://registry.npmmirror.com
> ```
>
> 若仍报错，见文末「故障排查」。

## 启动

```bash
npm start
```

启动后控制台会打印访问地址，例如：

```
  本机访问:   http://localhost:3000
  局域网访问: http://172.22.140.54:3000
```

- 本机浏览器：打开 `http://localhost:3000`
- 手机 / 平板 / 其他电脑：连接**同一局域网（WiFi）**后，浏览器打开上面的「局域网访问」地址

修改端口：`PORT=8080 npm start`（Windows PowerShell 用 `$env:PORT=8080; npm start`）。

## 局域网访问（安卓 / iPad）

1. 确保手机与电脑连在同一 WiFi。
2. 首次 `npm start` 时 Windows 防火墙会弹窗，勾选「专用网络」允许 Node.js。
   - 若没弹窗或点了拒绝，可在「Windows 防火墙 → 允许应用」里手动放行 Node.js，
     或为该端口新建入站规则。
3. 手机浏览器访问 `http://电脑局域网IP:端口`。

## 浏览器兼容

以 Firefox 为基准，兼容 Chrome / Safari / 移动端浏览器，不使用仅 Chromium 支持的 API。

## 开发阶段

- [x] 阶段1：服务器 + 项目/任务 CRUD + 侧边栏 UI
- [x] 阶段2：pty 会话 + xterm 终端流
- [x] 阶段3：上下分屏输入区、可靠大文本发送、终止进程、重连回放
- [ ] 阶段4：移动端适配与打磨（含复制去行尾空格）
- [ ] 阶段5：Git 版本管理（git init + .gitignore + 提交历史）
- [ ] 阶段6：claude 无头可读模式（TUI ⇄ 可读聊天流双视图切换；无头走 `claude -p` stream-json）

## 架构速览

```
浏览器 (xterm.js)  ⇄  WebSocket (/ws)  ⇄  Node 服务器 (pty 会话)  ⇄  powershell.exe
      前端渲染            JSON 消息            会话由服务器持有             真实终端进程
```

会话由服务器持有，与浏览器解耦：关掉/刷新网页，pty 进程继续运行；重开页面点任务可重连并回放缓冲。

### 目录职责

```
server/
  index.js       启动 Express + HTTP + WebSocket，打印局域网地址
  store.js       data/projects.json 读写（防抖落盘）+ 项目/任务 CRUD
  routes.js      REST API（/api/projects、/api/tasks）
  sessions.js    pty 会话管理 + WebSocket 桥接（每个 task 一个会话、回放缓冲、resize、kill）
public/
  index.html     页面骨架 + 模态框
  css/style.css  样式（含移动端抽屉、深色主题）
  js/api.js      REST 封装
  js/app.js      应用状态、侧边栏树、项目/任务增删改、模态框
  js/terminal.js xterm 实例管理 + WebSocket 客户端（输入/输出/resize/重连）
  vendor/        本地化的 xterm.js / xterm.css / fit addon（不走 CDN）
data/
  projects.json  唯一的持久化数据：项目与任务定义
```

### 数据模型

```
Project { id, name, tasks: [ Task ] }
Task    { id, name, cwd, kind: "claude" | "codex" | "powershell" }
```

每个 Task 运行时对应一个 pty 会话（同一时刻一个 task 最多一个活动会话）。

### WebSocket JSON 协议（路径 `/ws?taskId=<id>`）

| 方向 | 消息 | 说明 |
|---|---|---|
| 客户端→服务器 | `{type:"start", cols, rows}` | 建立/复用会话并订阅，触发回放 |
| 客户端→服务器 | `{type:"input", data}` | 键盘输入写入 pty |
| 客户端→服务器 | `{type:"large_input_start", id, overwrite, textLength, byteLength, checksum}` | 带完整性信息开始或恢复大文本发送事务 |
| 客户端→服务器 | `{type:"large_input_chunk", id, seq, data}` | 按序发送一个最多 1025 UTF-16 code units 的文本块 |
| 客户端→服务器 | `{type:"large_input_end", id, textLength, byteLength, checksum}` | 请求校验全部文本并提交回车 |
| 客户端→服务器 | `{type:"resize", cols, rows}` | 同步 pty 行列 |
| 客户端→服务器 | `{type:"kill"}` | 终止会话进程（阶段3 接按钮） |
| 服务器→客户端 | `{type:"status", running, exitCode}` | 当前会话状态 |
| 服务器→客户端 | `{type:"replay", data}` | 重连时先回放的缓冲内容 |
| 服务器→客户端 | `{type:"output", data}` | pty 实时输出 |
| 服务器→客户端 | `{type:"exit", code}` | 进程退出 |
| 服务器→客户端 | `{type:"large_input_ready", id, expectedSeq, textLength, byteLength, checksum}` | 事务就绪；断线恢复时给出下一序号和累计校验信息 |
| 服务器→客户端 | `{type:"large_input_ack", id, seq, textLength, byteLength, checksum}` | 该块已按序写入 pty，且累计校验一致，可以发送下一块 |
| 服务器→客户端 | `{type:"large_input_complete", id, textLength, byteLength, checksum}` | 全文校验一致且回车已写入，CLI 已提交 |
| 服务器→客户端 | `{type:"large_input_error", id, message}` | 大文本事务被拒绝或已失效 |

大文本输入不设业务字数上限。浏览器按 1024 个 UTF-16 code units 分块，单块在途，服务器按序去重并以 10ms 间隔写入 ConPTY；发送中不会混入普通键盘输入。每个 ACK 同时核对累计 UTF-16 长度、UTF-8 字节数和 FNV-1a 校验值。只有最终三项全部一致，服务器才写入回车提交 CLI；Codex/Claude TUI 会在校验后额外等待 500ms，让其先消费完最后一批输入。失败时聊天框保留原文，CLI 输入区保留此前已写入的部分。ACK 表示数据已写入 pty，并不代表终端内运行的程序已经处理完毕。发送连接意外断开时，客户端会用同一事务 ID、序号和完整性信息自动续传；事务和完成记录在服务端保留 60 秒用于恢复与去重。
| 服务器→客户端 | `{type:"error", message}` | 错误提示 |

### REST：目录浏览（新建/编辑任务时选目录用）

`GET /api/fs?path=<目录>` —— **只读**列出该目录下的子目录（不含文件、不读内容）。
不带 `path` 时返回盘符列表（C:\、D:\…）。返回 `{ path, parent, dirs:[{name, path}] }`，
`parent` 为 `null` 表示已在盘符层、为 `""` 表示上级是盘符层。仅供局域网自用，无鉴权。

## 数据备份

`data/projects.json` 是**唯一的真实数据**（你的所有项目与任务定义），不进版本库。
建议定期手动复制一份，误删或改坏后可直接还原。

## 已知问题

- **node-pty 版本必须锁 `0.13.1`**：`0.12.0` 和 `0.14.0` 都没有 Node 24（ABI v137）的
  Windows 预编译二进制（安装时报 404 → 回退编译 → `spawn EINVAL`）。只有 `0.13.1` 提供
  `node-v137-win32-x64` 预编译包。升级 Node 大版本后需重新确认对应 ABI 是否有预编译包。
- **kill 会话时控制台可能刷出 `AttachConsole failed` 堆栈**：来自 node-pty 内部一个用于
  枚举控制台进程列表的辅助子进程，属 ConPTY 已知无害噪音。崩的是该独立子进程，不影响主服务器
  与终端功能，浏览器端也看不到。kill 通过内部 5 秒超时兜底照常完成。

## 故障排查

- **`npm install` 时 node-pty 报 404 / `spawn EINVAL`**：预编译二进制未找到导致回退到本地编译。
  确认版本锁在 `0.13.1`，并用「安装」一节的 npmmirror 镜像命令重装。
- **`EBUSY: resource busy or locked`**：安装时 node_modules 被占用。先停掉正在运行的服务器
  （对应 PowerShell 窗口按 Ctrl+C，或 `Stop-Process -Name node`）再重装。
- **手机打不开局域网地址**：确认同一 WiFi；确认 Windows 防火墙已放行 Node.js（专用网络）。

## 许可证

本项目采用 [MIT License](LICENSE)。
