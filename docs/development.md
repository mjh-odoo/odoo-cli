# CLI 开发与交付

## 准备与检查

需要 Node.js 24+。首次准备依赖用 npm ci --ignore-scripts；依赖和安装状态未变时不重复安装。

```sh
npm run check
npm test
```

参数、帮助与项目副作用检查由 test/cli.test.mjs 覆盖；环境、日志和镜像各有独立测试文件。验证与改动相符，文档或 Skill 变化只补链接、语法、命令帮助和打包检查，不为此启动用户数据库。

## 任务和合并

从最新 main 或包含所需前置改动的明确基线创建 codex/ 任务分支。工作树由原生工具管理；同一检出一个写入任务，审查优先只读。小而完整的变更及时集成，单一逻辑 PR 可 squash，有独立意义的历史保留。

行为变化更新 README 或对应专题。PR 写清问题、最终行为、验证和限制；跨会话复杂任务才维护 docs/tasks/<任务>.md，不复制聊天记录或凭据。

## 独立集成验收

test/docker-acceptance.py 需要 Python、Docker、兼容 Base 与已有基础镜像，脚本创建可丢弃测试项目。使用前阅读脚本和帮助，明确临时资源；不能在用户开发库运行删除卷或覆盖恢复。

```sh
python3 test/docker-acceptance.py /absolute/path/to/base /absolute/path/to/installed/odoo
```

单元测试不等于真实 Docker/平台验收。新增数据库或运行行为需在独立实例验证；没有对应设备时明确未测试，不把 CI 配置当结果。

## Skill 维护

Skill 源码为 .agents/skills/odoo-cli/，SKILL.md 只保留定位、路由和必要边界，开发、日志、数据库的细节在 references/。修改后使用可用的 skill-creator 校验器检查 frontmatter 与 agents/openai.yaml，并核对文中命令的真实帮助。

消费项目把完整目录放到自己的 .agents/skills/odoo-cli，保持同一内容。复制时保留官方技能与许可，不把真实项目路径和配置写入 Skill。npm 包中的同一路径可作为分发来源；项目内 .agents/skills 是 Agent 的发现位置。

## 打包与发布

使用 npm pack 生成候选，检查 files 白名单只包含可发布文件；安装到独立临时前缀，运行实际 odoo --version、--help、init 和相应功能，确认 Skill 的入口与引用一同存在。

main 是可集成主线，发布标签 v<版本> 固定验收结果。package.json 的候选版本不等于已在 npm 发布；发布状态以实际 registry/Release 结果为准。包发布、Git 推送与镜像上传分别遵循用户已授权范围，认证由本人处理，不记录凭据。
