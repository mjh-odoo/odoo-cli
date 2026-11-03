# Odoo 原生 ZIP 存档

先确认目标项目和数据库：`odoo config` 查看默认 PGDATABASE 与备份目录，`odoo db list --json` 区分当前库。管理命令中的 `-d/--database` 省略时使用项目 PGDATABASE。

## 导出

```sh
odoo db backup
odoo db backup -d source_db --file /path/to/source.zip
```

使用运行中的 Odoo 容器调用官方 `db dump`，保留数据库管理页同类原生 ZIP，包含数据库和 filestore。默认保存到工作树外的用户数据目录，不覆盖已有文件。服务未运行时先核对状态，再按任务需要启动；不要用裸 SQL 导出替代用户要求的 ZIP。

应避免备份时同时进行业务写入。存档不包含项目源码，验收记录可注明对应 Git 提交和模块版本，但不修改 ZIP 结构。

## 恢复

```sh
odoo db restore --file /path/to/source.zip -d restored_db
odoo db list --json
```

`db restore` 调用官方 `db load --neutralize`，默认中和外发任务。CLI 检查格式、CRC、路径和 20.0 主版本后执行恢复；目标库已存在时默认拒绝。只有用户已明确要求覆盖该目标时使用 `--force`。

恢复到新名字不会自动修改项目 PGDATABASE。用户要切换默认运行库时，修改 `.env` 的 PGDATABASE 并执行 `odoo up --no-build`，用 up 明确应用配置；`module ... -d` 只改变本次维护目标，不切换项目默认库。

先保证项目具备存档内已安装模块的兼容源码，再核对记录、模块状态及真实附件下载内容。ZIP 校验和恢复命令通过只能证明对应步骤成功，不代替业务或附件验收。仅恢复可信存档。

## 兼容入口

项目脚本的数据库语法是 `node scripts/dev.mjs backup --database name`、`node scripts/dev.mjs restore --file path --database name`，没有管理 CLI 的 `db` 子命令；其他参数以该脚本帮助为准。
