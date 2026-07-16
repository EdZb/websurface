# WebSurface 首次上传 GitHub 指南

本指南适用于 Windows PowerShell。目标是先在本地完成代码、安全和提交内容审查，再把 `D:\Proj02_WebSurface` 发布为公开的 GitHub 仓库 `websurface`。

> 命令中的 `你的GitHub用户名` 和邮箱需要替换为你自己的信息。每一步确认没有报错后，再执行下一步。

## 1. 确认项目目录和仓库边界

```powershell
cd "D:\Proj02_WebSurface"
Get-Location
git --version
git rev-parse --show-toplevel
```

- 输出正是 `D:/Proj02_WebSurface`：可以继续。
- 提示 `not a git repository`：执行下面两条命令，然后重新检查。
- 输出是更上层目录（例如 `D:/`）：立即停止，因为项目位于另一个仓库内部。

```powershell
git init
git branch -M main
```

确认状态和远端：

```powershell
git rev-parse --show-toplevel
git remote -v
git status
```

每个正常仓库由自己的 `.git`、提交历史和远端管理。在 WebSurface 中执行 Git 命令不会提交其他路径的内容。

## 2. 设置仅作用于本仓库的 Git 身份

不要覆盖已有的全局配置。在 WebSurface 目录执行：

```powershell
git config user.name "你的GitHub用户名"
git config user.email "你的邮箱或GitHub noreply邮箱"
git config --local --list
```

这两项配置只影响当前仓库。如果不希望公开真实邮箱，可在 GitHub 的 `Settings > Emails` 中查找 `noreply` 邮箱。

## 3. 检查项目结构

```powershell
Get-ChildItem -Force
Get-ChildItem -Recurse -Force -File |
Where-Object { $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\.venv\\' } |
Select-Object FullName
```

确认源码入口、配置模板、静态资源和运行必需的小型数据都在项目目录内，同时识别缓存、构建输出、日志、真实用户数据和未公开研究数据。

## 4. 审查敏感信息

如果已经安装 `rg`（ripgrep），执行：

```powershell
rg -n --hidden -g "!.git/**" -g "!node_modules/**" -g "!.venv/**" "(api[_-]?key|secret|token|password|private[_-]?key|BEGIN .*PRIVATE KEY)" .
```

逐项检查 `.env`、API Key、数据库连接字符串、云服务凭据、私钥、本机绝对路径、个人信息和未公开研究数据。示例占位符可以保留，真实凭据必须删除。若凭据曾进入 Git 历史，还必须轮换凭据并在上传前清理历史。

## 5. 创建或补充 `.gitignore`

```powershell
Test-Path .gitignore
notepad .gitignore
```

如果文件不存在则创建；如果已经存在，只补充缺少的规则：

```gitignore
# Secrets and local configuration
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx

# Dependencies
node_modules/
.venv/
venv/

# Build output and caches
dist/
build/
.next/
.cache/
__pycache__/
*.pyc
*.log

# IDE and operating system
.vscode/
.idea/
.DS_Store
Thumbs.db
```

不要直接忽略整个数据目录。运行必需且可以公开的小型 JSON、CSV、图片或初始化数据应保留；敏感数据和运行输出应按具体路径忽略。

## 6. 检查大文件

GitHub 拒绝普通方式上传超过 100 MB 的单个文件。提前检查超过 90 MB 的文件：

```powershell
Get-ChildItem -File -Recurse -Force |
Where-Object { $_.FullName -notmatch '\\.git\\|\\node_modules\\|\\.venv\\' } |
Where-Object { $_.Length -gt 90MB } |
Select-Object @{Name="SizeMB";Expression={[math]::Round($_.Length/1MB,2)}}, FullName
```

- 非运行必需文件：加入 `.gitignore`。
- 含隐私或无权公开的文件：不要上传。
- 必须公开的大型运行资源：使用 Git LFS。

```powershell
winget install --id GitHub.GitLFS --exact
git lfs install
git lfs track "相对路径/文件名"
```

`git lfs track` 会生成或修改 `.gitattributes`，该文件应一并提交。

## 7. 完整代码审查

首次公开前至少检查：

- 是否写死了 `localhost`、本机绝对路径或私人服务器地址。
- 网络请求失败、无效输入和文件缺失是否有错误处理。
- 用户输入是否未经处理直接传给 `innerHTML`，从而产生 XSS 风险。
- 文件名大小写是否一致，避免在 GitHub/Linux 环境失效。
- 前端代码是否暴露了本应只存在于后端的密钥。
- 是否残留测试账号、临时调试代码和不应公开的注释。
- 第三方依赖是否存在已知高危漏洞。

如果项目有 `package.json` 和 `package-lock.json`，执行：

```powershell
npm install
npm audit
npm run
```

根据 `npm run` 显示的脚本，运行项目实际存在的检查，例如：

```powershell
npm run lint
npm test
npm run build
```

如果项目使用 `pnpm-lock.yaml` 或 `yarn.lock`，使用对应的 `pnpm` 或 `yarn`，不要混用包管理器和锁文件。

## 8. 审查准备提交的内容

```powershell
git add --dry-run .
git add .
git status
git diff --cached --stat
git diff --cached
```

确认没有密钥、敏感数据、依赖目录、日志和无关大文件。如果误添加文件，在提交前执行：

```powershell
git restore --staged "文件相对路径"
```

将不应上传的路径加入 `.gitignore`。审查通过后提交：

```powershell
git branch -M main
git commit -m "Initial public release"
git log -1 --oneline
```

## 9. 使用干净副本验证项目

```powershell
$review = Join-Path $env:TEMP ("websurface-review-" + (Get-Date -Format "yyyyMMddHHmmss"))
git clone . $review
Set-Location $review
```

在临时副本中重新安装依赖，并运行项目已有的 `lint`、`test`、`build` 和启动命令。这可以发现程序是否错误依赖了被 `.gitignore` 排除的本地文件或数据。

验证后回到原项目：

```powershell
cd "D:\Proj02_WebSurface"
```

## 10. 安装 GitHub CLI

```powershell
winget install --id GitHub.cli --exact
```

安装后关闭 PowerShell，重新打开并验证：

```powershell
gh --version
```

如果 `winget` 不可用，从 GitHub CLI 官方网站下载安装：<https://cli.github.com/>。

## 11. 登录 GitHub

```powershell
gh auth login
```

依次选择 `GitHub.com`、`HTTPS` 和 `Login with a web browser`。浏览器授权后检查：

```powershell
gh auth status
```

GitHub CLI 登录不会修改其他仓库的文件、提交和远端。如果其他仓库使用不同的 GitHub 账号，每次推送前应额外核对 `gh auth status` 和 `git remote -v`。

## 12. 创建公开仓库并推送

```powershell
cd "D:\Proj02_WebSurface"
git remote -v
```

如果没有任何远端输出：

```powershell
gh repo create websurface --public --source . --remote origin --push
```

如果已经存在正确的 GitHub 远端，不要重复创建：

```powershell
git push -u origin main
```

最后打开仓库页面：

```powershell
gh repo view --web
```

检查 README、源码、静态资源、必要数据和提交记录，确认没有敏感内容。当前暂不添加许可证，因此代码虽然公开可见，但默认保留全部权利。

## 13. 后续更新代码

```powershell
cd "D:\Proj02_WebSurface"
git status
git add .
git diff --cached --stat
git commit -m "简要描述本次修改"
git push
```

每次提交前都应检查 `git status` 和暂存内容，避免意外公开本地配置、密钥或敏感数据。
