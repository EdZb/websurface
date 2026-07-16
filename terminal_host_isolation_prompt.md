# WebSurface terminal host isolation prompt

项目目录：`D:\Proj02_WebSurface`

请认真阅读项目，重点检查：

- `server/sessions.js`
- `server/index.js`
- `server/routes.js`
- `public/js/terminal.js`
- `package.json`
- `README.md`
- `CLAUDE.md`

## 背景问题

WebSurface 当前通过 node-pty 启动 PowerShell/Codex。开发或重启 WebSurface 时，PTY 宿主可能退出，导致整棵进程树被终止：

```text
WebSurface Node
└─ PowerShell PTY
   └─ Codex
      └─ Python
         └─ MATLAB
```

这会使正在运行的分析任务被硬终止，来不及写退出日志或清理锁。

## 目标一：WebSurface 重启不影响终端会话

请设计并实现“终端宿主与 Web 服务器分离”的架构：

1. 创建独立、长期运行的 terminal host/broker 进程。
2. terminal host 独立持有 node-pty、PowerShell、Codex及其子进程。
3. Web/Express 开发服务器只负责 UI、REST 和 WebSocket代理。
4. 重启 Web服务器、刷新/关闭浏览器、修改前端代码，都不能终止 terminal host及已有PTY。
5. Web服务器重新启动后，应自动连接已有terminal host，并恢复：
   - taskId
   - session PID
   - running/exit 状态
   - PTY输出回放
   - WebSocket订阅
6. terminal host不得因为WebSocket断开而终止会话。
7. 删除任务时默认只删除/隐藏任务配置，不自动杀进程；若任务仍在运行，必须明确警告。
8. “终止进程”必须是独立操作，二次确认后才能终止整棵进程树。
9. 停止Web服务器不能向terminal host传播Ctrl+C、SIGTERM或进程树终止。
10. terminal host应使用Windows下真正脱离当前PTY生命周期的启动方式，不能只依赖普通子进程继承。
11. terminal host意外退出时写清楚原因、PID、时间及仍在运行的session信息。
12. 不要升级或更换当前锁定的node-pty依赖。

## 目标二：显示当前进程树

新增一个PowerShell启动脚本，例如：

```text
scripts/start-websurface.ps1
```

在启动WebSurface的PowerShell窗口中，定期显示WebSurface相关进程树，包括：

- launcher/supervisor
- terminal host
- Web/Express server
- PTY PowerShell
- Codex/Claude
- Python
- MATLAB
- 其他后代进程

每个进程至少显示：

- PID
- PPID
- 进程名
- 启动时间
- taskId或sessionId（能映射时）
- 命令行摘要
- 是否仍存活

实现要求：

1. 使用Win32_Process/CIM读取ParentProcessId和CommandLine。
2. 递归构建进程树，不要只显示直接子进程。
3. 默认每2秒刷新一次，刷新频率可配置。
4. 支持一次性查看和持续监控：
   - `-Once`
   - `-Watch`
   - `-IntervalSeconds`
5. 进程退出时显示一条明确事件，而不是静默消失。
6. 不得因为查询失败、PID复用或进程已退出而杀进程。
7. terminal host与Web server必须使用不同的PID和清晰标签。

## 安全约束

- 当前可能已有Codex、Python或MATLAB任务正在运行。
- 在修改和检查过程中，禁止调用taskkill、Stop-Process、session.proc.kill()或重启现有服务。
- 不得删除当前task、PTY或锁文件。
- 任何需要重启terminal host或可能影响现有会话的操作，必须先停止并向我说明，等待授权。
- 浏览器断开、页面刷新和Web server重启都不得触发kill。
- 保留现有大文本传输、重连回放和终端功能。

## 验收测试

1. 启动一个Codex终端。
2. 从该终端启动一个至少运行60秒的Python子进程。
3. 记录PowerShell、Codex和Python PID。
4. 重启Web/Express server，但不重启terminal host。
5. 验证上述PID保持不变，Python继续运行。
6. 浏览器重新连接后能恢复终端输出。
7. 关闭浏览器后Python仍继续运行。
8. 只有点击明确的“终止进程”并二次确认后，相关进程树才被终止。
9. PowerShell监控窗口能正确显示完整进程树及退出事件。
10. 为关键生命周期行为补充自动化测试。

## 工作方式

先做只读检查并给出当前架构、终止路径和改造方案。确认方案后再实施。完成后更新README，说明：

- terminal host与Web server的启动方式
- 安全重启Web server的方法
- 查看进程树的方法
- 正确终止会话的方法
- terminal host异常后的恢复方式

最终列出所有修改文件、验证结果和仍然存在的Windows/node-pty限制。
