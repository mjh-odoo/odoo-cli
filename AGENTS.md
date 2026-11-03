# Odoo CLI 协作入口

默认中文。此仓库维护独立 npm 包 @mjh-odoo/cli，可执行命令为 odoo。Node.js 24+，命令和帮助统一由 Commander 定义。项目根目录从当前目录或 --project 发现，不能绑定 CLI 安装目录。

## 约定

- 帮助、版本和参数校验不创建 .env、不连接 Docker。日志、配置、状态等读取命令也不初始化项目。
- 默认 down 保留数据；只有显式 -v/--volumes 才删除本项目卷。集成测试只能使用独立临时项目，不在用户开发数据库执行删除卷、覆盖恢复等动作。
- Python 运行、模块维护和备份恢复委托项目内的 Docker/脚本。保留 base 中的官方源码，本 npm 包不携带该源码、.env、日志、数据库或附件。
- 发布包用 files 白名单。验收 npm pack 安装后的真实 odoo 命令，不能只验证源码入口。
- 使用 Node 测试及独立 Docker 集成测试；记录 Windows 原生与当前 macOS 实测范围的区别。
- main 为发布分支，后续开发分支使用 codex/ 前缀。提交采用 [TAG] scope: imperative 格式。

## 当前授权

2026-11-03 用户明确授权完善并发布独立 CLI，npm 包名选定 @mjh-odoo/cli。先前 base 本机验收限制不再阻止本 CLI 发布；base 全量源码和基础镜像不在本次发布包中。npm 登录和 2FA 使用用户本人认证，不在仓库或聊天存放凭据。
