# 数据库与 Odoo ZIP

先用 `odoo config` 核对当前工作树，`odoo db list --json` 查库名、当前库和恢复来源。项目存档由 Odoo Manager 保存，各工作树通过同一 Git 仓库识别项目。

## 保存与发布

```sh
odoo archive save "销售验收版" -d odoo --tag latest
odoo archive import /path/to/source.zip
odoo archive list --json
odoo archive tag set latest <存档ID>
odoo archive tag list
```

保存需要运行中的 Odoo，导入通过目标项目的 Odoo 运行镜像校验 ZIP。默认保存只生成存档。需要同时更新标签时传 `--tag`，保存成功后才移动标签。导入后可用 `archive tag set` 更新标签。可把标签指回旧 ID。只有单独交付文件时才使用 `odoo db backup --file /path/to/backup.zip`。备份包含数据库和 filestore，保留原生 Odoo ZIP。

## 恢复与切换

```sh
odoo db restore latest --to sales_review
odoo db use sales_review
odoo db restore id:<存档ID> --to sales_copy --use
```

标签在命令执行时解析，恢复记录实际 ID。恢复默认中和外发任务，切换失败恢复原数据库配置。保留旧库以便回退。用 `--file <路径>` 恢复未导入的 Odoo ZIP，只有用户明确指定要覆盖目标库才使用 `--force`。验收需要核对记录、模块状态和真实附件内容。

`ODOO_SEED=tag:latest` 或 `id:<存档ID>` 搭配 `ODOO_SEED_MODE=first-start`，使 `odoo up` 在新开发环境空库时加载对应版本。用 `manual` 手动恢复。现有工作树的数据由该环境自己维护。

删除 ZIP 用 `odoo archive delete <存档ID> --yes`，带标签的存档须先移动或移除标签。删除环境中的数据库及附件用 `odoo db delete <数据库> --yes`，先切走当前库。分别核对目标并确认用户已授权该次删除。

## 恢复失败与迁移

恢复失败先查任务输出的校验、恢复、验证或切换阶段。普通恢复会清理本次新建的库。若仍有「恢复未完成」记录，确认目标环境后用 `odoo db recover --yes` 清理再重试，禁止将该库切为当前库。

```sh
odoo archive seed tag:latest
odoo archive source
odoo archive library export /path/to/new-library-directory
odoo archive library import /path/to/library-directory
odoo worktree archived
```

项目级来源用于新工作树。工作树内显式的 `ODOO_SEED_MODE=first-start` 和 `ODOO_SEED` 优先，`ODOO_SEED_MODE=empty` 可选空库。存档库目录包含原生 ZIP 与索引，带走 ID、标签和备注。导入保留本机已有的同名标签。清理已归档工作树卷使用 `odoo worktree clean <Compose标识> --yes`，先核对工作树和卷并取得用户授权。
