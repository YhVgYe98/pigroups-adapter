# E 真机复跑：先 abort 再 shutdown（`25b8c1b`）

## 一句话结论

**3/3 PASS。上一轮唯一失败的 `bash sleep 40` 场景现在 PASS：DELETE 后 3 ms 工具被切断，
118 ms pi 退出，167 ms `pane list` 已看不到 agent，204 ms 才 close；`pg_terminate` 报
`pane_close_forced: []`。会话最后一条不再是悬空的 `toolUse`，而是完整的
“Command aborted”工具结果 + 一条 `stopReason=error / This operation was aborted` 的结束消息。**

这次没有改代码，也没有动平台；只跑了真机测量。

## 环境

| 项 | 值 |
|---|---|
| adapter | `25b8c1b`（`src/herdr.ts` sha256 `dddf0eef558b77dd…`） |
| 平台 | 每个 case 一个一次性数据目录 + 独立端口（40861/40862/40863） |
| 版本 | pi 1.4.0 / herdr 0.9.5 / node v26.12.1，`deepseek/deepseek-flash` |
| 根/子启动 | 两边都带 `-ne -e /home/yang/Documents/pigroups-adapter/src/extension.ts`，子进程另有 `--session-dir` |
| 子进程识别 | `herdr pane process-info` 的 foreground pid + `/proc/<pid>/environ` 的 `HERDR_PANE_ID`；没有用 `pgrep -f pi`（pi 会重写 argv） |
| 驱动/分析 | 本目录 `driver.sh`、`analyze.mjs`；每个 case 的完整产物在 `case*/` |

三个 case 都先让子成员正常起来并 idle；长工具 case 再通过 root `pg_say` 让它跑
`bash sleep 40`，等真正的 `"type":"toolCall"…"name":"bash"` 写进会话后才删除。
midturn case 为了确保删除时 turn 一定在跑，先从外部直接给子 pane 一个长文生成 prompt，
`herdr agent wait --until working` 确认 working 后再让 root 调 `pg_terminate`；上一轮那种
“删除落在一轮 nudge turn 中途”的触发方式没有重放。

## 结果总表

时间均为 UTC；`DELETE→close` 是平台落库时刻到 herdr `pane.close` 请求的墙钟。

| case | DELETE | 工具结果 | pi 退出 | agent 从 pane list 消失 | pane.close | 会话最后一条 | 判定 |
|---|---|---|---|---|---|---|---|
| idle | `13:24:11.414` | — | `13:24:11.544` | `13:24:11.811` | **406 ms**（`11.820`） | `stopReason=stop` | **PASS 11/11** |
| midturn | `13:24:48.045` | — | `13:24:48.166` | `13:24:48.316` | **404 ms**（`48.449`） | `stopReason=aborted` / `Operation aborted` | **PASS 11/11** |
| midtool40 | `13:23:25.652` | `25.655`（`Command aborted`） | `13:23:25.770` | `13:23:25.819` | **204 ms**（`25.856`） | `stopReason=error` / `This operation was aborted` | **PASS 13/13** |

`pi 退出` 是 20 ms pid 采样第一次发现 `/proc/<pid>` 不在的时刻，真实退出只会更早 0–20 ms；
`agent 消失` 是 40 ms `pane list` 采样。

## 失败场景（midtool40）的逐项时间线

子成员 `m_6f8d83`，pane `wE:p1P` / herdr pane 48，pi pid `145923`。

```
13:23:22.979  子成员写下 bash {"command":"sleep 40","timeout":60}
13:23:25.652  DELETE 提交，sys.terminated 写入（删除前最后一个 pane 采样 = working）
13:23:25.653  子成员 poll 取走 notice（delivered）
13:23:25.655  bash 工具结果写入：isError=true, "Command aborted"   ← DELETE 后 3 ms
13:23:25.656  最后一条会话写入：assistant, stopReason=error,
              errorMessage="This operation was aborted"             ← DELETE 后 4 ms
13:23:25.770  第一次 pid 采样：pi 已退出                             ← DELETE 后 118 ms
13:23:25.819  pane list 第一次报 pane 在、agent 不在                 ← DELETE 后 167 ms
13:23:25.856  herdr 收到 pane.close                                 ← DELETE 后 204 ms
13:23:25.859  herdr 日志 signal=Hangup（关掉的是 pi 退出后留下的 shell）
13:23:25.861  pane list 第一次报 pane 不存在
```

上一轮这个 case 在 `5031 ms` 关窗时 pane 仍报 `agent=pi working`，pi 在 close 之后才消失，
没有 graceful exit，会话最后是 `stopReason=toolUse` 且没有 toolResult。现在这三件事全部反过来：

- 工具在 DELETE 后 **3 ms** 被 abort 切断（实际只跑了 2676 ms，请求是 40000 ms）；
- pi 在 close 前 **86 ms** 已经退出；
- 会话完整（29 条、0 坏行、行尾换行），最后 3 条依次是
  `assistant(toolUse)` → `toolResult("Command aborted")` → `assistant(stopReason=error)`。

`child-pane-at-exit.txt` 在 agent 从 pane list 消失的当帧抓到了回滚，里面有 pi 的正常退出行：

```
To resume this session: pi --session-dir /tmp/pgpc-childsess.XD0xSw --session 01a19746-…
```

所以 `signal=Hangup` 不是“关掉了活 agent”：它在 pi 退出 **89 ms 后**、close 请求 **3 ms 后**
才发生，是关闭残留 shell 的结果。三个 case 都有这一行。

## `pg_terminate` 的原文

三个 case 都是同样的形状（`pane_close_failed` 为空，`pane_close_forced` 为空）：

```
2026-11-01T13:24:11.823Z [{"type":"text","text":"{\"terminated\":[\"m_cabea0\"],\"pane_close_failed\":[],\"pane_close_forced\":[]}"}]
2026-11-01T13:24:48.453Z [{"type":"text","text":"{\"terminated\":[\"m_9cd4ee\"],\"pane_close_failed\":[],\"pane_close_forced\":[]}"}]
2026-11-01T13:23:25.860Z [{"type":"text","text":"{\"terminated\":[\"m_6f8d83\"],\"pane_close_failed\":[],\"pane_close_forced\":[]}"}]
```

midtool40 里 close 等到了正常退出，所以按 F 的语义报 `forced: []` 是对的；如果 abort 没生效、
5 s 到点仍关活 agent，这里应该出现 `{"member":"m_6f8d83","pane":"wE:p1P"}`。这次没有。

## 与上一轮的差值

| case | 上一轮（`7ae1adc`） | 本轮（`25b8c1b`） | 变化 |
|---|---|---|---|
| idle | 608 ms，PASS | **406 ms**，PASS | −202 ms |
| 模型 turn 中 | 4626 ms，PASS（余量 374 ms） | **404 ms**，PASS | −4222 ms（触发方式不同，仅作量级对照） |
| `bash sleep 40` 中 | **5031 ms，FAIL**（close 时仍 working） | **204 ms，PASS** | −4827 ms；从 FAIL 变 PASS |

`bash sleep 6` 的旧对照（3825 ms）本轮没有重跑，因为要回答的是上一轮失败的那个 case。

## 会话现在长什么样

| case | 条数/坏行 | 最后一条 |
|---|---|---|
| idle | 27 / 0 | `assistant stopReason=stop`（DELETE 前 2.853 s 写完） |
| midturn | 21 / 0 | `assistant stopReason=aborted, errorMessage="Operation aborted"` |
| midtool40 | 29 / 0 | `assistant stopReason=error, errorMessage="This operation was aborted"` |

三个文件都以换行结束，没有任何半行。midtool40 的 bash toolResult 带 `isError=true` 和
`"Command aborted"`，不再出现“有 toolCall、没 toolResult”的悬空尾巴。

## 复跑

```bash
cd probe/logs/terminate-20261101T132033
OUT=$PWD/case1-idle     CASE_NAME=case1-idle     PORT=40861 CHILD_TASK=idle     bash driver.sh
OUT=$PWD/case2-midturn  CASE_NAME=case2-midturn  PORT=40862 CHILD_TASK=midturn  bash driver.sh
OUT=$PWD/case3-midtool40 CASE_NAME=case3-midtool40 PORT=40863 CHILD_TASK=midtool CHILD_TOOL_SLEEP=40 bash driver.sh
node analyze.mjs case1-idle case2-midturn case3-midtool40
```

`analysis.txt` 是三个目录合并后的完整 PASS/FAIL 输出。

## 收尾与未覆盖

- 本轮创建的 3 个 root pane 和 3 个 child pane 全部关闭；临时 `/tmp/pgpc-*` 已删除；
  三个平台进程已停止，40861/40862/40863 无监听。
- 最终 pane 列表与开跑前基线一致：`wD:p1E wE:pB wE:p1 wE:p12 wE:p1J`。后两个在开跑前就存在，
  不是本轮创建的，未动。
- 开跑前已有 6 个 `node src/main.ts`（PIDs `43634 43748 83388 83438 83555 91513`），
  本轮没有新增平台进程，也没有动这 6 个。
- E 的 abort 仍然是协作式的：这次 `bash` 工具会响应 pi 的 abort signal，所以 3 ms 就结束了。
  一个完全忽略 signal 的工具仍可能拖过 3 s；那种情况下 F 会通过 `pane_close_forced` 把强制
  关窗报出来，而不是静默成功。
- `pane list` 失败时 `Herdr.close()` 仍无法判断 agent 是否还活着，只能报 `forced: false`；
  这是已知的“未知”，不是干净退出的证明。
