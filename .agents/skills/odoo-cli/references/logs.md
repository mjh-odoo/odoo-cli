# 日志排查

从有限快照开始，不默认持续跟随：

```sh
odoo logs all --since 10m --json
odoo logs all --since 10m --level error --context 3 --json
odoo logs --tail 500 --match my_module --json
```

`matched` 是匹配事件数，`shown` 包括上下文；事件 `context=true` 表示邻近上下文，未知级别为 null。先看错误前后事件和完整堆栈，必要时扩大时间或 tail 范围。起点可能截断异常，空结果不能证明服务正常。

需要现场复现时再用 `odoo logs -f`；Ctrl+C 只结束查看。筛选、JSON 和文件选项不能与 follow 混用。导出可用 `--file .local/logs/debug.json`，拒绝覆盖已有文件，内容中的业务数据仍需按任务处理。

安装、升级或恢复使用的临时维护容器可能已经被移除；优先保留失败命令的输出。当前服务日志不能补回该容器的全部错误。不要因日志中只有 health 200 就判断模块已正确安装或业务正常。
