<div align="center">
  <img src="https://raw.githubusercontent.com/XLYing23333/Werodex/main/assets/WerodexBar.jpg" alt="Werodex — 本地优先的远程开发桥接工具" width="860" />

  <h1>Werodex</h1>
  <p><strong>面向远程开发与编程 Agent 的本地优先 SSH 桥接工具。</strong></p>
  <p>编辑器、Agent 和凭据留在本地；代码、Git 与长任务在 Linux 服务器运行。</p>
  <p><a href="README.md">English</a></p>
</div>

---

Werodex 主要为 Codex 等编程 Agent 提供规范化的远程 Linux 项目交互方式。用户安装工具并提出任务；Agent 在本地编辑文件，通过 Werodex 同步源码、执行远端命令并汇报结果。数据集、检查点和运行产物可以继续保留在服务器上。

Werodex 不会在远端运行 Codex，不会把模型凭据复制到服务器，也不要求额外开放远端 TCP 服务。

## 功能特点

- **本地优先：** 编辑器、编程 Agent 和模型身份认证留在本机。
- **持久 SSH：** 本地 daemon 管理 SSH ControlMaster 连接，并限制并发通道数。
- **谨慎同步源码：** `sync` 与 `pull` 使用逐文件 SHA-256 基线检测冲突，默认不删除文件。
- **保护远端数据：** 数据集、检查点、输出及其他远端专属目录不会参与自动源码操作。
- **长任务管理：** 通过 `tmux` 启动分离任务，可等待任务、查看摘要日志或按需连接终端。
- **显式下载产物：** 只获取指定文件，并保存到 `.werodex/artifacts/`，不镜像整个输出目录。
- **凭据保护：** 可选的本地 Vault 加密保存 Secret；工作区配置只保存引用，不保存 Secret 本身。

## 环境要求

当前支持 **Linux** 和 **Node.js 20 或更新版本**。本地需要安装：

- OpenSSH 客户端
- Git
- rsync
- Python 3

远端需要 OpenSSH、Git、rsync、tmux、Bash 和 GNU coreutils。请先配置并验证 OpenSSH Host 别名与认证方式。远端项目目录必须已经存在。若尚无独立 Git 仓库，`init` 会在该目录创建 `main` 分支；已有仓库和分支保持原样。

## 安装 CLI 与 Skill

项目仓库：[XLYing23333/Werodex](https://github.com/XLYing23333/Werodex)。仓库根目录就是这里的 `Werodex/` 包目录；克隆后可直接看到 `package.json` 和 `werodex_skills/`，无需再进入第二层 `Werodex/`。首次发布到 npm 后，可运行 `npm install -g werodex` 安装。发布前请使用下方源码安装方式。

在 Werodex 包目录中安装：

```bash
git clone https://github.com/XLYing23333/Werodex.git
cd Werodex
npm ci
npm install -g .
werodex help
```

从上面克隆的 GitHub 仓库直接安装[随仓库提供的 `werodex-init` Skill](werodex_skills/werodex-init/SKILL.md)，放进 Codex 用户级 Skills 目录，供所有项目使用。如果暂时只安装 Skill，执行上面的 `git clone` 和 `cd Werodex` 即可复制，无需先运行 npm。

```bash
# 在克隆的 Werodex 仓库根目录执行。
skill_dir="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$skill_dir"
cp -a werodex_skills/werodex-init "$skill_dir/"
```

全局安装 `werodex` npm 包后，也可以从已安装的包中复制同一个 Skill：

```bash
skill_dir="${CODEX_HOME:-$HOME/.codex}/skills"
mkdir -p "$skill_dir"
cp -a "$(npm root -g)/werodex/werodex_skills/werodex-init" "$skill_dir/"
```

两种方式的目标都是 `$CODEX_HOME/skills/werodex-init`；未设置 `CODEX_HOME` 时为 `~/.codex/skills/werodex-init`。重复复制会更新已有 Skill。新开 Codex 对话后，在本地项目工作区说 `/Werodex Init HOST /远端项目绝对路径` 即可使用。实际初始化工作区之前还需安装 Werodex CLI。

## 在 Agent 中使用 Werodex

### `AGENTS.md`：Agent 的远程操作规范

`werodex init` 会在**本地项目根目录**创建或更新 `AGENTS.md` 受管区块，保留区块外的原有说明。这是给 Codex 等 Agent 使用的项目级操作规范。`werodex-init` Skill 负责引导首次初始化；初始化后，Agent 应**立即读取新生成的 `AGENTS.md` 区块**，并在后续任务中遵循它。当前对话中新建的文件不应被假定会自动重新载入。

受管区块规定了何时检查目录树、排除数据与本地专用文件、同步源码、运行远端任务、处理冲突和查看有界日志。功能验证完成后，它要求 Agent 按指定路径执行远端 `checkpoint`、刷新 `git-tree`，并写本地工作日志。Werodex CLI 强制执行传输和路径约束；修改哪些代码、如何合并冲突由当前 Agent 或人工判断。`AGENTS.md` 遵循 Agent 正常的指令层级。

### 给 Agent 的使用流程

1. **启动已启用 Skill 的新对话。** 如果刚安装了 Skill，请新开 Codex 对话让它加载。初始化工作区前，确认本机可运行 `werodex help`。
2. **打开本地工作空间并初始化。** 使用新建的本地项目文件夹，或 Agent 提供的本地工作空间，在其中告诉 Agent：`/Werodex Init MY-SERVER /home/me/demo`。Agent 使用 `werodex-init` Skill 完成目录检查、排除标记和首次同步，并立即读取生成的 `AGENTS.md`。这句话是给 Agent 的提示语；实际 CLI 命令为 `werodex init --target MY-SERVER --project /home/me/demo`。
3. **随后正常提出远端开发任务。** Agent 按工作空间 `AGENTS.md` 操作：在本地修改 Source，通过 Werodex 同步、远端验证和提交，记录工作日志；明确只留本地的文件先添加排除。CLI 示例和命令参考见本节之后。

## CLI 命令与功能

以下命令供参考，展示 Agent 如何初始化本地工作区并关联已有的远端项目：

```bash
mkdir -p ~/Projects/demo
cd ~/Projects/demo
werodex init --target MY-SERVER --project /home/me/demo
werodex tree
# 检查并填写 .werodex/project-tree.md，标记发现的数据或产物目录：
werodex exclude add downloads --reason "下载的数据集"
werodex review complete
werodex status
```

`--target` 是 OpenSSH Host 别名或主机名；`--project` 是远端项目的绝对路径。如果远端目录还不是独立 Git 仓库，`init` 自动创建 `main`；`--init-git` 仍兼容旧脚本。

同步源码并运行远端命令：

```bash
werodex sync
werodex exec -- python3 -V
werodex run --detach -- python3 train.py
werodex jobs
werodex wait <job-id> --timeout 3600
werodex logs <job-id>
```

功能完成后，只提交本次改动的远端 Source，并在本地记录：

```bash
werodex checkpoint -m "完成示例功能" -- src/main.py .gitignore
werodex git-tree
# 先在 .werodex/entry.md 写好“修改内容”和“收益”两节。
werodex log add --file .werodex/entry.md --asset /home/me/demo/outputs/preview.png
```

没有必要附件时省略 `--asset`。本地专用文档先执行 `werodex exclude add PATH --reason "local-only: ..."`，再创建文件。运行 `werodex help` 查看完整命令列表。已有工作区可重新运行 `werodex review complete`，刷新生成的 `AGENTS.md` 受管区块。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `werodex init --target HOST --project PATH` | 将当前本地工作区关联到远端项目 |
| `werodex status` | 查看连接、Git、同步和任务状态 |
| `werodex tree [PATH]`、`review complete` | 有界查看本地目录并批准首次同步 |
| `werodex exclude add PATH --reason TEXT`、`exclude remove PATH`、`exclude list` | 管理项目内的字面路径排除项 |
| `werodex sync` / `werodex pull` | 双向传输源码并检测冲突 |
| `werodex diff` | 查看源码差异 |
| `werodex exec -- CMD` | 通过 SSH 执行短命令 |
| `werodex run --detach -- CMD` | 启动可持久运行的远端任务 |
| `werodex jobs`、`wait`、`logs`、`kill` | 管理任务并获取限量输出 |
| `werodex fetch ABSOLUTE_PATH` | 下载一个明确指定的远端文件 |
| `werodex checkpoint -m "说明" -- PATH...` | 同步并仅提交指定的远端 Source 文件 |
| `werodex git-tree` | 将有界的远端 Git 提交图与工作区状态写到本地 `.werodex/git-tree.md` |
| `werodex log add --file ENTRY.md [--asset 远端绝对路径]...` | 头插当天工作日志，并按需拉取少量附件 |
| `werodex doctor` | 检查本地和远端依赖 |
| `werodex credential` | 查看或管理可选的本地 Vault |

发生冲突时，`sync` 会生成报告，并将远端冲突文件副本保存在 `.werodex/conflicts/<id>/`。手动合并后运行 `werodex sync --resolve <id>`；也可以明确选择 `--keep-local <id>` 或 `--keep-remote <id>`。Werodex 不会调用 AI Agent 自动解决冲突。

### 同步范围与数据边界

Werodex 将文件分为源码、忽略项、大文件、受保护的远端专属数据和显式获取的产物。受保护路径规则优先于 `.gitignore`；将数据目录写入 `.gitignore` 本身并不构成保护机制。

- 自动源码操作会跳过 `datasets/`、`data/`、`pretrained/`、`checkpoints/`、`outputs/`、`wandb/`、`runs/` 和 `artifacts/` 等远端专属目录。
- `.werodex/`、`.git/`、`node_modules/`、环境变量文件、SSH 目录和配置的排除路径不会作为源码同步。
- 非源码文件超过 32 MB 时默认报告并跳过。常见代码和文档后缀（如 `.py`、`.c`、`.cpp`、`.html`、`.js`、`.go`、`.ts`、`.md`）不因大小自动忽略。`.pth`、`.tar.gz`、`.json` 不按后缀一概排除；应明确标记数据和产物目录。非源码大文件确需同步时，可使用 `sync --allow-large` 或 `pull --allow-large`。
- `exclude add` 同时写入 `sync.exclude`、两端 `.gitignore` 受管区块，并在本地目录概览记录原因。用户指定只留本地的文件，应在创建前排除具体路径。Werodex 在两端执行 `sync.exclude`；排除项是字面路径，不是 glob。没有目录累计大小上限。
- `fetch` 仅接受远端项目内明确指定的普通文件；拒绝符号链接路径、已存在的本地目标，以及数据集/预训练文件批量下载。超过 32 MB 的文件需要 `--allow-large`。
- 传输前整批文件必须通过两端的忽略与大小策略。任一端忽略某路径（包括 Git 已跟踪文件），都会返回 `WDX_TRANSFER_POLICY` 并停止写入。请检查两端规则，或通过 `exclude add PATH --reason TEXT` 一致排除该路径，然后重试。
- 同步期间请暂停其他对源码的写入进程。Werodex 会重新检查已传输文件，但无法让多个独立进程的写入形成原子快照。

### 任务与输出

完成一项功能后，Agent 应验证、`sync`、通过 `checkpoint -m "说明" -- PATH...` 只提交本次变更的远端 Source，并运行 `git-tree`。本地 Git 用于忽略和状态判断，不要求本地 commit。日志由 Agent 撰写包含“修改内容”和“收益”的 Markdown，再显式执行 `log add --file`；每个工作日使用一个 `logs-YYYY-MM-DD.md`，按上海时间 04:00 切日，新条目位于文件顶部。最多指定 5 个附件，每个默认不超过 32 MB；日志及附件只保存在本地 `.werodex/`。

短命令通过 SSH 直接运行。分离任务使用远端 `tmux`，本地终端或 daemon 断开后仍会继续。远端任务日志默认每个任务最多 256 MB，已完成任务保留 7 天。`logs` 默认返回有限输出；需要人工排查时可显式使用 `logs --raw`。

## 安全

Werodex 不会将 Secret 写入工作区或远端项目。SSH Host Key 校验保持开启。启用本地 Vault 时，Secret 使用 scrypt 和 AES-256-GCM 加密，并要求在交互式终端中解锁。本地 daemon 使用校验 Linux UID 的 Unix Socket 通信。详见[安全说明](SECURITY.md)和[威胁模型](docs/THREAT_MODEL.md)。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [工作区配置](docs/CONFIG.md)
- [安全策略](SECURITY.md)
- [威胁模型](docs/THREAT_MODEL.md)
- [配置示例](examples/config.example.json)
- [English README](README.md)

## 发布前检查

运行 `npm run release:check`，完成构建、测试、实际 tarball 中的敏感文件与常见凭据模式检查，并在隔离的全局安装目录中验证 CLI。包中包含 CLI、daemon、文档、横幅和 skill 文件。检查完成并登录 npm 后运行 `npm publish`；发布钩子会再次执行同一检查。详见[发布说明](docs/RELEASING.md)。

## 开发

```bash
npm install
npm test
```

项目使用 TypeScript 构建，并通过 Node.js 内置测试运行器执行测试。

## 许可证

Werodex 使用 [Apache License 2.0](LICENSE) 发布。
