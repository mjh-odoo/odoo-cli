# 日志排查

先在复现窗口查询错误。CLI 0.1.2 起可用 `--hide-health` 去掉成功的健康检查，失败请求仍可查到。

```sh
odoo logs all --since 10m --tail 1000 --level error --context 3 --hide-health --json
odoo logs all --since 2026-11-03T09:25:30+08:00 --until 2026-11-03T09:26:30+08:00 --tail 1000 --hide-health --json
```

`matched` 是命中数，`shown` 包括命中和相邻事件，`context=true` 标记相邻事件。找到可疑错误后，用其时间戳限定前后 30 秒，查看完整堆栈和其他服务。日志先按容器行数取样再筛选，`tailReached=true` 时可扩大行数或缩小时间窗。

需要现场复现时再用 `odoo logs -f`；Ctrl+C 只结束查看。筛选、JSON 和文件选项不能与 follow 混用。导出可用 `--file .local/logs/debug.json`，拒绝覆盖已有文件，内容中的业务数据仍需按任务处理。

安装、升级或恢复使用的临时维护容器可能已经被移除；优先保留失败命令的输出。当前服务日志不能补回该容器的全部错误。不要因日志中只有 health 200 就判断模块已正确安装或业务正常。
