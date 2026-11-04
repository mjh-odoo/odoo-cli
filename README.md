# @mjh-odoo/cli

跨平台 Odoo 20 开发管理 CLI，命令名为 odoo。提供环境、模块、日志、原生数据库 ZIP 与镜像管理。

## 安装与启动

需要 Node.js 24+、Docker、Compose 和 Buildx。Windows PowerShell 可直接使用；Python/Odoo/PostgreSQL 在目标项目的容器中运行。

```sh
npm install -g @mjh-odoo/cli
odoo --help
odoo --version
```

进入兼容项目后执行 odoo init、odoo up。CLI 不创建完整 Odoo 项目；项目应包含 compose.yaml、.env.example、完整官方源码及容器脚本，见 [项目契约](docs/architecture.md)。模板密码的非空优先规则从 0.1.1 支持；0.1.0 先用项目的 node scripts/dev.mjs init 准备配置。

从子目录也能发现项目，指定目录时全局参数放在命令之前：

```sh
odoo --project /path/to/project status --json
```

## 常用命令

```sh
odoo config
odoo doctor --json
odoo up
odoo up --no-build --pull never --wait-timeout 600
odoo status --json
odoo logs all --since 10m --json
odoo logs all --since 10m --tail 1000 --level error --context 3 --hide-health --json
odoo module list --json
odoo module install first_module second_module
odoo module update first_module second_module -d target_db
odoo db list --json
odoo db backup
odoo db restore --file /path/to/backup.zip -d restored_db
odoo down
```

每个命令支持 --help。模块列表只读；安装和升级会停止 Odoo 并运行维护容器。-d 只改变本次目标，不改 .env。维护失败保留停止状态，先看本次错误输出再修复启动。

日志默认有限快照，持续查看才加 -f；JSON、筛选和文件导出不能与 -f 混用。异常保留上下文，空结果不代表服务无故障。

普通 down 保留卷；只有明确要删除本项目数据库与附件时使用 -v，可先 --dry-run 看计划。恢复已有目标库需要显式 --force；加 `--use` 可以在成功恢复到新库后切换。备份默认保存在工作树外，odoo config 显示位置。

## 与 Odoo Manager 共用存档

在 Odoo Manager 接入项目并设置存档目录后，可以在主目录或任意 Git 工作树中执行：

```sh
odoo archive save "销售验收版" --tag latest
odoo archive import /path/to/backup.zip
odoo archive list --json
odoo archive tag set latest <archive-id>
odoo db restore latest --to sales_review --use
```

桌面端和 CLI 共用存档及标签。标签在命令执行时解析，也可用 `id:<存档ID>` 固定版本。发布只移动标签，已有环境的数据由该环境自行维护。`db use` 更新当前环境的 `PGDATABASE` 并重启原本运行中的 Odoo，原库保留。用 `archive delete <ID> --yes` 删除无标签的 ZIP，用 `db delete <库名> --yes` 删除已切走的数据库和附件。

在新工作树的 `.env` 配置 `ODOO_SEED=tag:latest` 与 `ODOO_SEED_MODE=first-start`，首次 `odoo up` 会从标签恢复到空库，然后启动 Odoo。可在 `.env.example` 预填，使新工作树的 `odoo init` 一起复制配置。默认 `manual`。

`odoo archive seed tag:latest` 为已接入项目设置工作树的首次数据来源，`odoo archive source` 预览。恢复被中断后可用 `odoo db recover --yes` 清理本次创建的残留库。用 `odoo archive library export <新目录>` 和 `odoo archive library import <目录>` 迁移存档及标签。用 `odoo worktree archived` 查看已归档工作树的数据卷。

## 镜像与官方命令

```sh
odoo image build --dry-run
odoo image build --platform amd64 --file /path/to/runtime.tar
odoo image build --target production --tag my-erp:v1
odoo exec -- --version
odoo exec -- --help
odoo help exec
```

多架构和推送参数见 image build --help；生产镜像需要明确项目标签。exec 将后续参数原样传给容器内官方 Odoo，管理工具本身的说明用 help exec。

## Agent Skill

本仓库和 npm 包携带 [.agents/skills/odoo-cli](.agents/skills/odoo-cli/SKILL.md)。目标项目把完整目录放入自身 .agents/skills/ 后，可使用 `$odoo-cli` 管理该项目；Skill 按需要读取开发、日志或 ZIP 引用。

例如：使用 `$odoo-cli` 为当前项目导出默认数据库的原生 ZIP；或检查最近十分钟错误日志并保留上下文。

开发入口见 仓库根 AGENTS.md、[文档地图](docs/README.md)、[架构](docs/architecture.md)、[开发](docs/development.md) 和 [验证范围](docs/validation.md)。实际版本以 odoo --version 与包发布记录为准。
