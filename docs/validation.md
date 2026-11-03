# 0.1.0 验证记录

日期：2026-11-03。

## 本机与包

macOS ARM64，Node 26.8.1、Docker 29.7.2、Compose 5.4.0；容器 Odoo 20.0、Python 3.12、PostgreSQL 17。

32 项 Node 测试通过，覆盖环境隔离、重复初始化、中文和空格路径、全量帮助、参数校验、批量模块维护、日志事件与遮盖、镜像计划与离线文件。npm pack 后安装到独立临时前缀，实际 odoo --version、--help 及所有以下 Docker 检查均使用安装后的可执行文件。

发布包约 31 KB，files 白名单仅含 bin、src、docs、README、package.json 与许可；逐项检查无 Odoo 源码、真实环境文件、数据库、附件、node_modules 或本机绝对路径。

## 隔离 Docker 验收

- 全新临时项目使用本机已构建的基础镜像启动并通过健康检查。
- 单条命令安装两个模块，列出安装状态；批量升级及 --no-restart 保持停止通过。
- 通过官方 shell 写入真实 raw 附件，先验证 raw.content 和 filestore 文件。
- ZIP 同时包含 manifest.json、dump.sql、filestore；已有备份文件拒绝覆盖。
- 恢复到独立新库，列表正确区分 current；恢复后逐字节读取附件一致。
- module update -d 维护新库，原 .env 字节未改。
- 有限 JSON 日志快照读取真实 Docker 日志事件。
- 普通 down 保留两个卷，重新 up 后数据库仍在；显式 down -v 删除两个测试卷。
- 所有临时容器、卷和网络已清理，原 base .env 字节未改，原有运行容器继续运行。

本机 Docker 默认地址池已满，验收专门创建独立、无冲突的临时内部网络，结束后删除。此测试安排没有写入通用 base 配置，也没有清理其他项目网络。

复查脚本 test/docker-acceptance.py 仅用于可丢弃的新项目，在 macOS 实测；需要 Python 3、本机已有兼容 base 和 mjh-odoo/odoo-runtime:20.0-v0.1.0 镜像：

```sh
python3 test/docker-acceptance.py /absolute/path/to/base /absolute/path/to/installed/odoo
```

## 平台边界

GitHub CI 在 Windows、macOS、Linux 的 Node 24 上运行单元测试及打包安装检查；最终结果以发布提交的 Actions 为准。Windows 原生 Docker、WSL 及 Linux Docker 尚未实测。基础镜像与完整 base 均未在本次 CLI 发布中上传。
