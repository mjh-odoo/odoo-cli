# 架构与目标项目契约

## 管理 CLI 的代码

| 文件 | 职责 |
| --- | --- |
| bin/odoo.mjs | 读取包版本，启动命令解析和错误出口 |
| src/cli.mjs | Commander 命令树、帮助、参数校验与命令分派 |
| src/project.mjs | 向上查找目标、Compose 上下文、数据库/服务名检查、进程执行和操作锁 |
| src/commands.mjs | 环境、服务、模块、数据库操作 |
| src/lib/environment.mjs | .env 解析、初始化、项目身份、端口、存档位置与脱敏配置 |
| src/lib/logs.mjs | 有限日志、事件、上下文、脱敏和导出 |
| src/lib/image.mjs | Buildx 镜像计划、平台约束和离线输出 |
| .agents/skills/odoo-cli/ | 管理操作的可复用 Agent Skill，随 npm 包提供 |

全局 --project 放在子命令之前；否则从调用目录向上寻找同时含 compose.yaml 与 .env.example 的项目。npm 包安装位置不影响项目定位。

## 目标项目提供什么

| 目标文件/目录 | 用途 |
| --- | --- |
| compose.yaml、.env.example | 项目识别与运行配置 |
| .env | 本机配置，真实值不入 Git |
| odoo/odoo-bin、odoo/ | 官方进程和完整源码 |
| addons/ | 项目、外部和非生产模块 |
| scripts/runtime.py | serve、install、upgrade 等容器运行逻辑 |
| scripts/backup_utils.py | ZIP validate、restore，调用官方 load |
| config/、Dockerfile | 运行配置与镜像构建 |

Compose 服务名为 odoo 和 db。CLI 显式指定主 Compose、环境文件及项目身份。模块维护通过 runtime.py 的一次性容器执行；ZIP 备份调用运行容器中的官方 odoo db dump，恢复通过 backup_utils.py 调用官方 db load --neutralize。管理命令的 -d 默认读取 PGDATABASE，不自动切换项目默认库。

只读命令通过 validateEnv 读取已有配置，init/up 可准备缺失的 .env。支持固定模板密码的版本为 0.1.1+；已有环境不改写。项目内兼容脚本有自己的语法和副作用，不能假设与全部 CLI 选项相同。

环境、日志、镜像能力也可能存在于项目内兼容入口。修改共享行为时检查对应项目实现和测试，任务记录列出需要同步的消费方；不自动改无关仓库。
