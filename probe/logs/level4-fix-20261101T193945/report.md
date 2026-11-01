# Level 4 失败点复跑：删除后关闭 pane

- 时间：2026-11-01 19:39:45 +08:00
- 平台：`/home/yang/Documents/PiGroups`，端口 40629，临时数据目录
- adapter：`/home/yang/Documents/pigroups-adapter`（含 `terminate()` 关 pane 的修复）
- pi：`deepseek/deepseek-flash`；root 与 child 都带 `-ne`，只加载本适配器，不继承用户的全局扩展
- root：`m_dcfea5`，pane `wE:p0`
- child：`m_6713a6`（`probe-child`），pane `wE:p11`

## 步骤与结果

| # | 步骤 | 结果 |
|---|---|---|
| 1 | `POST /v1/bootstrap`，`herdr pane split`，`herdr agent start root` | root 启动，`interactive_ready:true`（`agent-start-root.json`） |
| 2 | prompt root 调 `pg_spawn` | root transcript：`{"id":"m_6713a6","name":"probe-child"}`；平台树多出 child |
| 3 | `herdr pane list` 前后对比 | 新增且只新增 `wE:p11`，`pane get` 确认它在删前存在（`child-pane-before-delete.json`） |
| 4 | prompt root 调 `pg_terminate member=m_6713a6` | root transcript：`{"terminated":["m_6713a6"]}`（`root-pane-after-delete.txt`） |
| 5 | 删除后查平台 | `GET /v1/members/m_6713a6` → `"status":"gone"`；`GET /v1/tree` 只剩 root |
| 6 | 删除后查 herdr | `wE:p11` 不在 `herdr pane list`；`probe-child` 不在 `herdr agent list` |
| 7 | 删除后查进程 | `ps` 中没有该 child 的 `pi` 进程 |

结论：`pg_terminate` 现在会关闭它拉起并记录过的 pane；level 4 的
“the child's pane is gone” 已由真机复跑确认。

## 边界

- 只复跑了失败点（spawn → terminate → pane 消失），没有重跑简报注入、群消息和进程退出的全套场景；这些在原 level 4 日志里已通过，本次修复不触碰它们。
- 本次复跑里 root 还收到了一条适配器自发的 `pg.report {status:"blocked", text:"no output after 3 nudges …"}`，说明 `pg.report` 控制通道本身可用；但模型侧仍没有 `pg_report` 工具（`docs/设计说明.md` §5.3 只列 9 个工具）。
