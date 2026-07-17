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
- Node.js 24（当前开发和验证版本：`24.15.0`）
- Git

## 安装

在 PowerShell 中执行：

```powershell
git clone https://github.com/EdZb/websurface.git
Set-Location .\websurface
npm ci
```

> node-pty（终端进程库）使用预编译版本 `@homebridge/node-pty-prebuilt-multiarch`，
> 版本**锁定在 `0.13.1`**（这是目前唯一提供 Node 24 / ABI v137 Windows 预编译二进制的版本，
> 见「已知问题」）。国内网络建议用镜像安装，通常无需 Visual Studio 编译工具链：
>
> ```powershell
> $env:npm_config_homebridge_node_pty_prebuilt_multiarch_binary_host_mirror = 'https://registry.npmmirror.com/-/binary/node-pty-prebuilt-multiarch/'
> npm ci --registry=https://registry.npmmirror.com
> ```
>
> 若仍报错，见文末「故障排查」。

## 启动

```powershell
npm start
```

### 在任意 PowerShell 路径启动

安装完成后，在 WebSurface 项目目录中执行一次：

```powershell
npm link
```

此后无论 PowerShell 当前位于哪个目录，都可以直接启动：

```powershell
websurface
```

`websurface` 命令始终启动已链接的 WebSurface 项目；PowerShell 当前目录不会改变任务中保存的工作目录。停止服务时按 `Ctrl+C`。如果不再需要全局命令，可执行 `npm unlink --global websurface`。

启动后控制台会打印访问地址，例如：

```
  本机访问:   http://localhost:3000
  局域网访问: http://172.22.140.54:3000
```

- 本机浏览器：打开 `http://localhost:3000`
- 手机 / 平板 / 其他电脑：连接**同一局域网（WiFi）**后，浏览器打开上面的「局域网访问」地址
- `localhost` 始终指向当前运行 WebSurface 的电脑；默认端口不变时，本机地址固定为 `http://localhost:3000`。
- 局域网 IP 由电脑所在网络分配，换电脑、换网络或重新连接后都可能变化。每次以启动日志实际打印的地址为准；如果打印多个地址，应选择与访问设备处于同一网段的地址。

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

## 本地 Git 备份与恢复

本项目同时使用两个 Git 远端：

```text
origin  -> https://github.com/EdZb/websurface.git
backup  -> D:\Proj_backup\Proj02_websurface
```

`backup` 是本机上的 bare Git 仓库，用于在项目代码改坏、`.git` 损坏或工作目录丢失时恢复。它不会自动更新，只有已经提交并推送到 `backup` 的版本才能恢复。

> [!IMPORTANT]
> Git 备份不包含 `.gitignore` 排除的 `data/projects.json`、`node_modules/` 和本机配置。尤其是 `data/projects.json`，必须另外复制备份；从 Git 恢复代码后不会自动恢复你的项目和任务数据。

### 创建一个可恢复版本

修改完成并确认可用后，在 PowerShell 中执行：

```powershell
Set-Location D:\Proj02_WebSurface
git status
git add .
git diff --cached --stat
git commit -m "说明本次修改"
git push backup main
git push origin main
```

其中 `git push backup main` 更新本地备份，`git push origin main` 更新 GitHub。即使 GitHub 暂时无法连接，也可以先成功保存到本地 `backup`。

检查两个远端及最近的备份版本：

```powershell
git remote -v
git log -1 --oneline
git -C D:\Proj_backup\Proj02_websurface log -1 --oneline
```

### 撤销尚未提交的文件修改

先查看差异：

```powershell
git diff
```

确认要放弃某个文件的未提交修改后执行：

```powershell
git restore "文件相对路径"
```

该命令会丢弃该文件尚未提交的修改，执行前应确认其中没有需要保留的内容。

### 撤销已经提交的错误修改

先查看提交历史：

```powershell
git log --oneline
```

若只需撤销最近一次提交，推荐创建一个反向提交，而不是改写历史：

```powershell
git revert HEAD
git push backup main
git push origin main
```

撤销更早的某次提交时，将 `HEAD` 换成对应提交哈希。公共仓库中不建议使用 `git reset --hard` 后强制推送。

### 从本地备份恢复单个文件

当前仓库的 `.git` 仍可用时，可以直接从本地备份取回文件：

```powershell
Set-Location D:\Proj02_WebSurface
git fetch backup
git restore --source backup/main -- "文件相对路径"
git diff
```

检查恢复结果后，再正常提交并推送到两个远端。

### 从本地备份恢复整个项目

不要直接克隆到仍然存在且非空的原目录。先恢复到一个新目录：

```powershell
git clone D:\Proj_backup\Proj02_websurface D:\Recovered_WebSurface
Set-Location D:\Recovered_WebSurface
npm ci
npm test
```

确认恢复后的项目正常，再决定是否替换原工作目录。需要任意路径启动命令时，在恢复目录重新执行：

```powershell
npm link
```

最后从单独的数据备份中还原 `data/projects.json`。验证本地 bare 仓库完整性可执行：

```powershell
git -C D:\Proj_backup\Proj02_websurface fsck --full
```

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
