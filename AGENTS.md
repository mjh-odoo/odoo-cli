# Odoo CLI 协作入口

默认中文。维护 npm 包 @mjh-odoo/cli，可执行命令 odoo，要求 Node.js 24+。

- 先看 Git 状态，保留手改；按 [文档地图](docs/README.md) 选择架构、开发或运行管理资料。小修复使用提交/PR 说明，跨会话任务才建独立记录。
- 命令和帮助统一在 src/cli.mjs 定义。项目从调用目录或 --project 查找，不能绑定 CLI 安装目录。
- 帮助、版本和参数校验不创建 .env、不连接 Docker；只读命令不自动初始化项目。
- 普通 down 保留卷；只有用户已明确要删除该项目数据时带 -v。测试只使用临时项目，不能覆盖用户数据库或删除开发卷。
- Python 运行与原生 ZIP 校验/恢复委托目标项目脚本。包不包含 Odoo 源码、真实 .env、日志、数据库或附件。
- 发布包使用 files 白名单，必须验证 npm pack 后安装的实际命令与所携带 Skill。
- 开发检查使用 npm run check、npm test；按改动补独立 Docker 集成验收。平台范围和未执行项目如实记录。
- 本仓库的 [odoo-cli Skill](.agents/skills/odoo-cli/SKILL.md) 用于管理目标 Odoo 项目；修改管理 CLI 源码读 [开发说明](docs/development.md)。Skill 完整目录随 npm 包提供，消费项目使用相同副本。
- main 为集成主线，任务分支 codex/<任务>；提交采用 [TAG] scope: imperative。一项逻辑变更及时合并，发布使用已授权的版本与目标，不从构建任务扩展为推送。
