# @mjh-odoo/cli

跨平台 Odoo 20 开发管理 CLI，命令名为 `odoo`。用于 mjh-odoo 社区版 base 及基于它建立的项目。

## 安装

需要 Node.js 24+、Docker Engine/Desktop、Docker Compose 和 Buildx。Windows 可在 PowerShell 中使用，无需 Make 或 Bash。Odoo/Python/PostgreSQL 在容器内运行。

```sh
npm install -g @mjh-odoo/cli
odoo --help
odoo --version
```

CLI 不附带 Odoo 源码，也不会创建完整项目。现阶段需先准备兼容的 base 仓库：根目录包含 `.env.example`、`compose.yaml`、`odoo/`、`addons/`、`scripts/runtime.py`、`scripts/backup_utils.py` 和 `config/`。Base 当前独立验收，尚未公开发布。

进入项目后运行：

```sh
odoo init
odoo doctor
odoo up
odoo status
```

从子目录运行也能找到项目。指定其他目录时，全局参数放在命令前：

```sh
odoo --project /path/to/erp status --json
# Windows
odoo --project "C:\Code\my-erp" status
```

## 常用命令

```sh
odoo up                              # 构建开发镜像并后台启动，等待健康
odoo up --no-build --pull never       # 使用已有镜像离线启动
odoo restart                         # 重启 Odoo
odoo restart all                      # 重启 Odoo 和数据库
odoo down                            # 停止并移除容器，保留持久卷
odoo down -v --dry-run                # 预览本项目卷删除操作
odoo down -v                         # 删除本项目数据库和附件卷
odoo build --pull                    # 构建当前 Compose 开发镜像
odoo config                          # 脱敏配置和默认存档目录

odoo module list --json
odoo module install module_a module_b
odoo module update module_a module_b
odoo module update --all              # 已安装的项目扩展，不含官方核心
odoo module update module_a -d test_db --no-restart

odoo db list --json
odoo db backup
odoo db backup -d odoo --file ./before-sale.zip
odoo db restore --file ./before-sale.zip -d sale_test
odoo db restore --file ./before-sale.zip -d sale_test --force

odoo logs
odoo logs all --since 10m --level error --context 3 --json
odoo logs odoo --match sale_module --tail 1000
odoo logs all --since 30m --json --file .local/logs/diagnostic.json
odoo logs -f

odoo image build --help
odoo image build --platform amd64 --file ./runtime-amd64.tar
odoo image build --platform amd64,arm64 --tag registry.example/team/runtime:v1 --push
odoo image build --target production --tag my-erp:v1

odoo exec -- --version                # 容器内官方 Odoo CLI
odoo exec -- --help
odoo exec -- shell -c /etc/odoo/odoo.conf
odoo help exec                        # 查看管理工具的转发说明
```

每个命令支持 `--help`，官方命令转发 `exec` 的说明使用 `odoo help exec`。

## 配置与数据

项目使用 `.env + compose.yaml + config/`。`init` 只在缺少 `.env` 时生成独立项目身份与可用端口；三个密码沿用 `.env.example` 中的非空值，只有空项才随机生成；重复运行保留已有文件。不同代码目录（包括 Git 工作树）默认使用不同身份、端口和数据卷。手动复制 `.env` 时需自行调整这些值。

密码字段为 `PGPASSWORD`（PostgreSQL 连接）、`ODOO_MASTER_PASSWORD`（数据库管理）和 `ODOO_ADMIN_PASSWORD`（空库管理员初始密码）。`PGUSER`、`PGDATABASE`、`ODOO_ADMIN_LOGIN` 及普通参数继续沿用模板。模板中的 `PROJECT_NAME` 和三个宿主端口保持空白，由 init 按目录分配；人工固定时修改生成后的 `.env`。

修改模板不更新已有 `.env` 或重置现有账号。管理员初始密码只用于空库；PostgreSQL 密码需与已有角色一致。真实密码放忽略的 `.env`，模板只填写可共享的开发默认值。此规则从本地 0.1.1 候选加入，npm 0.1.0 尚未包含。

`module install/update` 先停止 Odoo，使用一次性维护容器，再启动服务；失败时保留停止状态供排查。`-d` 只覆盖本次维护的目标库，不修改 `.env`。

备份包含数据库和 filestore，使用 Odoo 标准 ZIP；默认保存到用户数据目录的 `mjh-odoo/backups/<PROJECT_NAME>/`，位于代码目录之外，`config` 可查看实际路径。现有文件不会被覆盖。备份时应避免并发业务写入，保证数据库和附件的一致性。

恢复先校验 ZIP 路径、CRC、清单及 Odoo 20.0 主版本，再停止服务。默认中和外发任务；已有目标库需要显式 `--force`。恢复新库不会自动切换项目，切换时修改 `.env` 中的 `PGDATABASE`。

日志默认读取最近 200 行有限快照；筛选保留相邻事件与异常堆栈。`--json` 和 `--file` 不能与 `-f` 同用。已知 `.env` 密码值会被遮盖，业务内容仍需自行判断。临时模块维护容器的失败信息以维护命令本身的输出为准。

本版本包含环境、模块、ZIP 备份恢复、日志、镜像管理。桌面 App、存档目录索引、工作树自动克隆数据库和定时备份尚未实现。

## 开发与验收

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

测试覆盖跨平台参数解析、中文及空格路径、帮助无副作用、批量模块维护、日志和镜像计划。真实 Docker 验收范围见 [验证记录](docs/validation.md)。LGPL-3.0-only，见 LICENSE 和 COPYRIGHT。
