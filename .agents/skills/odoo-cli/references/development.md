# 环境与模块

## 常用入口

```sh
odoo init
odoo config
odoo doctor --json
odoo status --json
odoo up --no-build --wait-timeout 600
odoo down
```

`init` 只准备本机配置。`up` 默认构建镜像，再启动并等待健康；已有镜像用 `--no-build`，完全离线还可指定 `--pull never`。等待超时不表示数据库可丢弃，应查看实际状态和日志。

首次初始化按代码目录分配项目身份和宿主端口，形成独立数据卷。支持模板密码规则的版本保留三个非空模板密码，空项才生成。已有 `.env` 始终保留。管理员初始密码只用于空库；改配置不会重置已有后台账号或 PostgreSQL 角色。

修改 `.env` 后用 `odoo up --no-build` 重建服务配置；只变更配置模板或镜像依赖时需要重新构建。`restart` 默认处理 Odoo，先重启选定服务，再执行 `up --no-build --wait` 确保服务就绪；`restart all` 包含当前项目的数据库。其他项目不在 all 的范围内。配置修改仍建议明确执行 `up`。

## 模块安装与升级

```sh
odoo module list --json
odoo module install first_module second_module
odoo module update first_module second_module -d target_db
odoo module update first_module --no-restart
```

模块名用空格分隔。`-d/--database` 覆盖本次维护目标，不修改项目的 `PGDATABASE`。安装用于未安装模块，升级用于已安装模块；Python 热重载不代替字段、视图和数据结构的升级。

无模块名时 `module update` 会拒绝执行，只有显式 `--all` 才升级已安装的项目扩展；它不代表升级整个官方核心。维护会确保数据库运行、停止 Web、使用一次性容器执行，成功后按选项启动。失败先保存本次命令的错误输出。

## 镜像

先用 `odoo image build --dry-run` 看本机基础镜像计划。完整项目镜像需要 `--target production --tag <项目:版本>`。单架构离线包使用 `--platform amd64 --file /path/to/image.tar`，服务器用 Docker load 导入。

多架构推送需要已支持相应架构的 Buildx 构建器以及显式 `--push --tag`；发布目标和权限沿用当前用户授权，不从本地构建任务推导为上传任务。
