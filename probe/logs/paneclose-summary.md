# fix A（`7ae1adc`）真机验证总结

对象：`herdr: wait for the pane's agent to exit before close`。`docs/handoff.md:450` 把
“关 pane 抢在子成员 `sys.terminated` 收尾之前”记成“已知，未改”，`:564` 写着“要真机复跑抓子进程
收据”。这次就是那个复跑。

## 一句话结论

**在子成员能在 5 s 内退出时，fix A 成立（3/3，有 pi 自己的 graceful-exit 行、进程顺序和
herdr 服务端日志）；在子成员卡在一个长工具里时，fix A 失败（1/1）——`PANE_AGENT_EXIT_TIMEOUT_MS`
到点后照常关窗格，关的是一个 `herdr pane list` 仍报 `agent=pi status=working` 的活 agent；
pi 在 close 之后才消失，没有 graceful exit，herdr 对这次结束的记录是 `signal=Hangup`。**

失败不是“探针没等够”，也不是回到旧行为：是同一个竞态从 0 ms 推到了 5 s。触发它的是普通行为
（一个没跑完的 `bash` 工具），不是异常。

## 四次运行

| # | 目录 | 删除时子成员在做什么 | DELETE→`pane close` | pi 退出 vs close | 判定 |
|---|---|---|---|---|---|
| 1 | `paneclose-20261101T205517-idle` | 空闲 | 608 ms | pi 早 182 ms | **PASS 8/8** |
| 2 | `paneclose-20261101T205921-midturn` | 一轮模型 turn 中（删除后还写了 1 条消息） | 4626 ms | pi 早 196 ms | **PASS 8/8**（余量 374 ms） |
| 3 | `paneclose-20261101T210306-midtool` | `bash sleep 40` 运行中（还剩约 31 s） | **5031 ms**（硬上限 5000 + 31） | pi 在 close **之后**才消失（9 ms），无 graceful exit | **FAIL 3/8** |
| 4 | `paneclose-20261101T210437-midtool6` | `bash sleep 6` 运行中（还剩约 2.5 s） | 3825 ms | pi 早 138 ms | **PASS 8/8** |

3 与 4 只差工具长度；4 证明“pi 在 shutdown 期间不打断正在跑的工具，而是等它结束”，
3 因此没能在 5 s 内退出。

## 逐项观测（`probe/paneclose-analyze.mjs`）

| 观测 | #1 idle | #2 midturn | #3 midtool | #4 midtool6 |
|---|---|---|---|---|
| O1 会话 JSONL 完整（每行可解析、结尾换行） | PASS | PASS | PASS\* | PASS |
| O2 最后一次会话写入早于 pi 退出 | PASS | PASS | PASS | PASS |
| O3 `sys.terminated` 送达早于 pi 退出 | PASS | PASS | PASS | PASS |
| O4 pi 退出后 pane 仍在列表、close 在其后 | PASS | PASS | **FAIL** | PASS |
| O5 pi 走完 graceful exit（回滚里有 `To resume this session:`） | PASS | PASS | **FAIL** | PASS |
| O6 窗格消失、无残留 pi、成员 gone | PASS | PASS | PASS | PASS |
| O7 适配器未报 `pane_close_failed` | PASS | PASS | PASS | PASS |
| O8 等待在 5 s 硬上限内 | PASS | PASS | **FAIL**（5031 ms） | PASS |

\* #3 的文件没有截断，但最后一条是**没有结果的工具调用**（`stopReason=toolUse`，之后没有
toolResult）：那一轮被切掉了。没有截半行是运气——删除时那条 toolCall 已经写完 3.9 s。

## 怎么证明的（可复核）

1. **notice 送达时刻**：平台 `GET /v1/control?all` 里 `sys.terminated` 的 `created_at` 与
   receipt 的 `delivered_at`（同一个事务写入、同一个 poll 取走）。
2. **pi 是否还活着**：`/proc/<pid>` 每 20 ms 采样（`pid-sampler.mjs`）。pid 不是猜的：
   `herdr pane process-info` 的 foreground pid + `/proc/<pid>/environ` 里的
   `HERDR_PANE_ID=<子 pane>` 与 `PIGROUPS_TOKEN≠root token`。**注意**：pi 会把自己的 argv
   重写成 `pi`，所以 `ps`/`pgrep -f` 找不到它的参数。
3. **pane 的 agent 状态**：`herdr pane list` 每 40 ms 采样（`pane-sampler.mjs`），记录
   `present/agent/agent_status/terminal_title` 的每次变化；第一次看到“pane 在、agent 没了”时
   立刻 `herdr pane read` 抓回滚。
4. **`pane.close` 的墙钟**：`~/.config/herdr/herdr-server.log` 里 `method="pane.close"` 的
   `api.request.start`，微秒级时间戳。
5. **graceful exit 的判别**：pi 的 `interactive-mode.js:3465-3478` 只有**非信号** shutdown 分支
   才打印 `To resume this session: …`（`fromSignal` 分支在 3451 起，不打印）。回滚里出现这行，
   说明子成员走的是 `ctx.shutdown()`，不是被 SIGHUP 打断。
6. **会话文件完整性**：逐行 `JSON.parse` + 结尾换行 + 最后一条的形状。
   **pi 的会话 JSONL 里没有 shutdown 记录**——对照实验（`paneclose-…-idle/control/`，
   一个在 `agent_settled` 里调 `ctx.shutdown()` 的最小扩展）里，正常退出的会话最后一条就是
   最后一条普通消息。所以“结束得干净”只能用 2/4/5/6 一起判。

## 失败场景的机制（#3 与 #4 的对照）

`#4`：`13:05:15.239` notice 送达（`bash sleep 6` 正在跑）→ `13:05:17.742` 工具**自然结束**并把
结果写进会话（删除后 2.5 s，没有被中断）→ `13:05:18.809` 收尾消息 → `13:05:18.926` pi 退出 →
`13:05:19.064` 才 close。工具跑满 6 s 而不是立刻返回，直接证明 pi 在 shutdown 时**等**工具。

`#3`：同样的流程，但工具还剩约 31 s。`13:03:44.335` notice 送达 → 到 `13:03:49.340` pane 仍报
`agent=pi working` → `13:03:49.366` 适配器在 5031 ms 关窗格 → `13:03:49.375` 第一次看不到 pi 的
进程（20 ms 采样粒度，只可能落在 `49.355–49.375`）→ `13:03:49.389` herdr 记
`pane session terminated … signal=Hangup`。herdr 对 `pane=41` 的日志里只有“agent 出现”和
“pane 会话被挂断”，**没有** “agent 离开窗格”。

源码位置：等待循环在 `src/herdr.ts:37-38`（5000/200 ms）与 `103-115`；子成员侧
`src/loop.ts:815` 的 `discardAndShutdown()` 先 `await this.stop()`（其上限
`STOP_TIMEOUT_MS = 3000`，`src/loop.ts:105`）再 `surface.shutdown()`；`src/herdr.ts:30-35`
的注释已经写明这是“hard stop”，但 `7ae1adc` 的提交标题是“wait for the pane's agent to exit
before close”——真机上这句话只在 5 s 内成立。

## 意外发现 / 值得记账的

1. **5 s 不是宽裕的余量**：单纯一轮模型 turn 在删除后还跑了 4.3 s（#2，余量 374 ms）；
   一个 `sleep 6` 的工具就用了 3.7 s（#4）。也就是说“子成员正在干活”是常态量级，
   不是病态。
2. **适配器仍报成功**：`#3` 里子成员被切断，`pg_terminate` 仍返回
   `{"terminated":[…],"pane_close_failed":[]}`。硬上限到点不报错是代码的选择，但工具结果里
   没有任何“子成员没走完退出”的痕迹。
3. **`pg_spawn` 会等到子成员 idle**（`waitReady`），所以“子成员第一轮就长工具”根本不会在删除时
   还在跑；要制造#3，必须先 idle，再用 `pg_say` 让它跑长工具。这是复跑方法上的坑。
4. **`herdr pane list` 报 agent 消失比进程退出晚 22–162 ms**（有这一帧的三次运行；#3 没有这一帧），close 的 200 ms 轮询
   就落在这个延迟之后，所以正常情况 close 总是比 pi 退出晚 20–200 ms。
5. **探针曾经误判**（`paneclose-…-midturn/correction.txt`）：`grep '"name":"bash"'` 会匹配
   系统提示里的工具声明。严格判据是 `"type":"toolCall"…"name":"bash"`。那次运行的实际场景
   因此是“删除落在一轮 turn 中途”，不是“工具运行中”。
6. **`wE:p12` 不是我建的**：它在我开始前就在 `panes-baseline.json` 里（`agent=-`,
   `status=unknown`, cwd `/home/yang/Documents/PiGroups`），我没有动它。收尾后 pane 列表 =
   基线：`wD:p1E`、`wE:pB`、`wE:p1`、`wE:p12`。

## 复跑

每个目录里都有当次的 `driver.sh`、两个采样器、全部产物和 `report.md`；`env.sh` 记着当次的
端口、成员 id、pane、pid、会话路径（token 没有落盘；平台是一次性的、已删除）。

```bash
cd probe/logs/paneclose-20261101T210306-midtool
CHILD_TASK=midtool CHILD_TOOL_SLEEP=40 bash driver.sh     # 复现 FAIL
cd ../paneclose-20261101T210437-midtool6
CHILD_TASK=midtool CHILD_TOOL_SLEEP=6  bash driver.sh     # 复现 PASS（机制对照）
node ../../paneclose-analyze.mjs .                        # 逐项 PASS/FAIL
```

driver 自己会：起一次性平台（端口 40777，`PIGROUPS_ADMIN_TOKEN=adm`，临时 `PIGROUPS_DATA`）、
bootstrap root、`herdr pane split` + `herdr agent start root`（`-ne -e <adapter>/src/extension.ts`，
`PIGROUPS_SPAWN_CMD` 同样带 `-ne -e …`）、prompt root 调 `pg_spawn`/`pg_terminate`、采样、
收尾（关自己开的 pane、停平台、删临时目录、打印最终 pane 列表）。`trap` 兜底。

## 建议（未实施，属于产品决定）

- 要让“agent 先退出再关窗格”这句话无条件成立，需要在等待前**先让成员退出**（例如平台/adapter
  在发 `sys.terminated` 后同时 abort 它正在跑的一轮），或者把关闭流程做成“请求退出 → 有界等待 →
  仍未退出则记录”的三段式，而不是“有界等待 → 直接关”。
- 也可以只把 5 s 调大，但那只是把同一个竞态推远；#2 的 374 ms 余量说明它并不遥远。
- 至少：`#3` 的 `pg_terminate` 结果里，`pane_close_failed` 为空，调用者看不出子成员被切断。
  把“等待超时”作为一条单独的事实回报出来，比静默成功要诚实。
