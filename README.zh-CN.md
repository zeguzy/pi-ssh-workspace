# pi-ssh-workspace

**把 [pi](https://github.com/earendil-works/pi) 的 read / write / edit / bash 工具通过 SSH 路由到远端机器执行，并支持在会话中随时用 `/ssh-cwd` 切换远端工作目录。**

模型调用仍然从你本机发出，只有文件与 shell 操作落到远端。也就是说 API Key、模型选择、本机
pi 配置都不用搬，而 Agent 真正编辑和构建的，是你最终要部署的那台机器。

```bash
pi install npm:pi-ssh-workspace
pi --ssh my-host --ssh-cwd /home/user/code/project
```

```text
/ssh-cwd                     # 当前远端目录是哪里？
/ssh-cwd ~/code/other        # 切过去；相对路径和 ~ 都支持
```

---

## 为什么需要它

常见的"远程开发"方案都得二选一：要么把 Agent 整个跑在远端（放弃本机的模型、Key、插件和
TUI），要么全在本地跑（放弃远端的工具链）。这个扩展把两件事拆开：pi 在本地，四个文件/shell
工具在远端。

这个拆分里最容易出问题的是工作目录。一个长会话里你会来回移动 —— 先 `backend/`，再
`frontend/`，然后又是另一个仓库。为了换目录重启 pi 会丢掉对话，所以 `/ssh-cwd` 原地切换远端
根目录，并告知模型根目录变了。

---

## 安装

```bash
pi install npm:pi-ssh-workspace
```

或从 git 安装：

```bash
pi install git:github.com/zeguzy/pi-ssh-workspace
```

然后带 `--ssh` 启动 pi。不带这个参数时扩展完全不生效：所有工具仍在本地，行为没有任何变化。

**依赖：** pi ≥ 1.1（已在 1.1.0 验证）· Node.js ≥ 22.19 · 到远端的 SSH 密钥认证 · 远端有 `bash`

---

## 用法

### 在远端工作区启动会话

```bash
pi --ssh my-host --ssh-cwd /home/user/code/project
```

| 参数 | 含义 |
|---|---|
| `--ssh <host>` | SSH 目标。`ssh` 能接受的都行：`~/.ssh/config` 里的别名、`user@host`、IP。 |
| `--ssh-cwd <path>` | 远端工作目录。绝对路径、`~` 开头、或相对远端 home 的路径。默认是远端 `$HOME`。 |

也支持合并写法：

```bash
pi --ssh user@host:/home/user/code/project
```

但推荐用两个独立参数：解析更稳定，也避免 `:端口` 被误认成路径。端口请写进 `~/.ssh/config`。

启动时扩展会在远端用 `cd <dir> && pwd -P` 解析该目录。如果失败 —— 主机名错误、机器不可达、
目录不存在 —— pi 会打印 `SSH mode not enabled: <原因>`，然后继续**以本地模式**运行。请先确认
这条提示，再信任该会话里的任何编辑；详见[已知限制](#已知限制)。

### 运行中切换远端目录

```text
/ssh-cwd                          # 打印当前远端目录
/ssh-cwd /home/user/code/other    # 绝对路径
/ssh-cwd ~/code/other             # ~ 展开为远端 $HOME
/ssh-cwd subdir                   # 相对当前远端目录
/ssh-cwd ../other                 # 支持 ..
```

每次切换都会先在远端校验再生效：

- 目标必须存在且是**目录**（传文件路径会被拒绝）
- 保存的是 `pwd -P` 得到的物理绝对路径，不会存 `~` 字符串或软链接路径
- 切换失败时保留原目录，并回报远端错误
- 切到当前所在目录时只提示 `unchanged`，不重复通知模型

切换成功后，`read`、`write`、`edit`、`bash` 以及 `!` 命令立即指向新目录，同时 pi 会收到一条
消息告知模型根目录已变更。

### 你自己的 shell 命令

pi 输入框里的 `!` 和 `!!` 同样路由到远端：

```text
!pwd              # 远端目录，输出进入模型上下文
!!git status      # 远端执行，输出不进上下文
```

---

## 哪些在远端、哪些在本地

这是整个扩展的核心，值得写清楚：

| 在**远端**执行 | 在**本地**执行 |
|---|---|
| `read`、`write`、`edit` | 模型调用与 provider 请求 |
| `bash` | `ls`、`grep`、`find`（pi 自带搜索工具） |
| `!` / `!!` shell 命令 | `process`（长驻进程工具） |
| 模型通过 `bash` 执行的任何命令 | LSP 诊断与代码智能（pi-lens） |
| | 你的 `~/.ssh/config`、密钥、pi 配置与插件 |

扩展在每一轮都会显式告诉模型这一点，因为这个失败模式很隐蔽：对着一份过期的本地副本跑
`grep`，看起来像是一次成功的搜索。所以提示词里明确写明本地搜索工具**看不到**远端目录树，
要检查远端文件请走 `bash`。

### 路径映射

工具参数先按 pi 启动时的本地目录解析，再映射到远端根目录。若你在
`/Users/you/code/project` 启动 pi，并把 `--ssh-cwd` 指向 `/home/user/code/project`：

| 你（或模型）传入 | 远端实际使用 |
|---|---|
| `/Users/you/code/project/src/app.ts` | `/home/user/code/project/src/app.ts` |
| `src/app.ts` | `/home/user/code/project/src/app.ts` |
| `/etc/hosts`（本地根之外） | `/etc/hosts`，原样传递 |

本地工作区之外的路径会原样透传，所以绝对远端路径总是可用。

---

## 推荐的 SSH 配置

扩展调用 `ssh` 时带 `BatchMode=yes`，因此不支持密码和交互式 2FA —— 请使用密钥、ssh-agent
或已认证的 Host。开启连接复用可以显著降低每次调用的延迟：

```sshconfig
Host my-host
    HostName 10.0.0.10
    User byteide
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

    ServerAliveInterval 15
    ServerAliveCountMax 3

    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
```

启动 pi 之前先验证非交互连接可用：

```bash
ssh -o BatchMode=yes my-host 'printf "connected\n"; pwd'
```

### Cloud IDE / LAPS 类主机

云 IDE 工具生成的 Host 别名同样可用：

```bash
pi --ssh cloudide-wsd9e82240b9ecf39a --ssh-cwd /home/byteide/code/LAPS
```

---

## 一个实用别名

如果你总是落在同一个远端工作区：

```bash
# ~/.zshrc
alias pi-remote='cd ~/code/project && pi --ssh my-host --ssh-cwd /home/user/code/project'
```

之后直接 `pi-remote`，需要换目录时在里面用 `/ssh-cwd`。

---

## 已知限制

这些是真实存在的，所以写明确：

- **没有镜像/同步。** 本地没有远端目录树的副本。`ls`/`grep`/`find` 和 pi-lens 读的是你本地
  那份未同步的检出。要看远端文件，请用远端 `bash`。
- **只接管四个工具。** `process`、浏览器自动化、pi-lens 等扩展仍在本地运行。用 `process`
  起 dev server 会起在你的笔记本上，而不是远端。目前请改用远端 `bash`（或 `!`）。
- **不支持密码与交互式 2FA。** `BatchMode=yes` 是有意为之，避免调用卡在提示符上。
- **一个会话只有一个远端主机。** Host 在启动时固定，`/ssh-cwd` 只换目录、不换机器。换主机
  需要新开 pi 会话。
- **远端目录结构需与本地一致。** 路径映射假设两边工作区相对布局相同。布局不一致时请使用
  绝对远端路径。
- **启动失败会退回本地模式。** 若 `--ssh` 无法解析目录，pi 会继续在本地运行并给出提示。不会有
  操作被悄悄发到远端，但也不会有操作被阻止 —— 该会话里的编辑会落在你的笔记本上。请留意启动
  提示。

---

## 实现原理

扩展是对 pi 自带工具的薄封装。pi 为每个工具提供可插拔的 operations 层，扩展只替换这一层，
schema、校验、渲染、截断仍由 pi 负责：

```text
pi read/write/edit/bash 工具
        │
        ├─ 无 --ssh ─────────► 本地文件系统 / 本地 shell
        │
        └─ --ssh <host> ─────► ssh <host> '...'  （远端文件系统 / 远端 shell）
```

`/ssh-cwd` 只更新一个内存值。因为 operations 层在每次调用时都会依据该值重建，所以切换无需
重启、无需重载会话。

扩展同时改写 pi 结构化系统提示中的 `cwd` 分段，让模型对"我在哪"的认知与远端根目录一致。
它只 patch 该分段而不是替换整个提示词，从而在轮次之间保住 prompt cache 前缀。

---

## 开发

```bash
npm install
npm run check     # 类型检查 + 测试
```

测试通过放在 `PATH` 里的假 `ssh`（`test/fixtures/ssh-double.sh`）驱动真实的工具实现：该脚本
在临时沙箱中本地执行远端命令。因此无需真实服务器就能覆盖完整远端代码路径 —— 引号处理、路径
映射、目录解析、错误处理。分两个阶段运行：`local`（不带 `--ssh`，所有工具必须留在本地）和
`ssh`（路由、`/ssh-cwd` 语义、提示词改写）。

想在不安装的情况下试本地改动：

```bash
pi --no-extensions -e ./src/index.ts --ssh my-host --ssh-cwd /path
```

---

## 许可证

MIT
