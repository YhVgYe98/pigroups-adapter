# fix A 真机验证：#1 删除时子成员空闲

**结论：PASS（8/8）。** pane close 发生在子成员 pi 自己退出之后：DELETE 后 608 ms 关窗格，
其中 pi 用 426 ms 走完 shutdown，关窗前 182 ms 已退出，窗格回滚里留有 pi 的
`To resume this session:`（只有非信号退出路径才打印的那一行）。

## 环境

| 项 | 值 |
|---|---|
| adapter | `e1fcf13`（含 `7ae1adc` 的 fix A），`src/herdr.ts` sha256 `196886e5be8bfa9f…` |
| 平台 | `/home/yang/Documents/PiGroups`，端口 40777，一次性数据目录（运行后删除） |
| root | 成员 `m_82baea`，pane `wE:p1A` |
| child | 成员 `m_a763f5`，pane `wE:p1B`，pi pid 124290 |
| 版本 | pi 1.4.0 / herdr 0.9.5 / node v26.12.1，模型 `deepseek/deepseek-flash` |
| 复跑 | `CHILD_TASK=idle bash driver.sh`（本目录） |

root 与 child 都带 `-ne -e <adapter>/src/extension.ts`；`PIGROUPS_SPAWN_CMD` 里同样带
`-ne -e …`，另外加了 `--session-dir`，让子成员的会话文件落在一个可预测目录（默认路径是
`~/.pi/agent/sessions/--<cwd>--/`，用 `--session-dir` 只是为了取证方便，不改变被测行为）。

## 时间线（UTC，括号内为 epoch ms）

| 时刻 | 事件 | 来源 |
|---|---|---|
| `12:59:03.914` | 平台提交 DELETE，写入 `sys.terminated` | `controls-after-terminate.json`（`?all`） |
| `12:59:03.915` | 子成员的 poll 取走该 notice（receipt `delivered`） | 同上，`delivered_at` |
| `12:59:04.340` | `/proc/124290` 消失（20 ms 采样，真值在 04.320–04.340 之间） | `pid-samples.tsv` |
| `12:59:04.502` | `pane list` 第一次报该 pane 无 agent（title 变成 shell） | `pane-samples.tsv` |
| `12:59:04.504` | 抓取窗格回滚，里面有 graceful-exit 行 | `child-pane-at-exit.txt` |
| `12:59:04.522` | herdr 收到 `pane.close` 请求 | `herdr-server-window.txt` |
| `12:59:04.544` | `pane list` 第一次报该 pane 不存在 | `pane-samples.tsv` |

DELETE → close 共 **608 ms**（上限 5000 ms，余量 4392 ms）。

## 原始证据

子成员会话文件（`child-session.jsonl`，31 条）——最后一条是删除前 1.6 s 写完的普通消息，
文件完整：

```
lines=31 bad=0 endsWithNewline=true
last.type=message role=assistant stopReason=stop
```

窗格回滚（`child-pane-at-exit.txt`，pid 消失后 2 ms 抓的）：

```
/tmp/pgpc-scratch.wSYJbr • probe-child
To resume this session: pi --session-dir /tmp/pgpc-childsess.JSdIL0 --session 01a19730-9e49-7457-9855-ea1a87c44d3c

/tmp/pgpc-scratch.wSYJbr ...................................................................................... 36s node system 20:59:04
>
```

`To resume this session` 只在 `interactive-mode.js:3465-3478` 那条“正常 shutdown”
分支里打印（`fromSignal` 分支在 3451 行起，不打印），所以它证明子成员走的是
`ctx.shutdown()` 的退出路径，而不是被 SIGHUP 打断。

pane 列表在关窗前的最后几个采样（`pane-samples.tsv`）——先是 agent 消失、title 变成 shell，
之后才 absent：

```
1793537944502  2026-11-01T12:59:04.502Z  present  (no agent)  idle  yang@yangPC:/tmp/pgpc-scratch.wSYJbr  agent-gone-first-seen
1793537944544  2026-11-01T12:59:04.544Z  absent
```

herdr 服务端日志（`herdr-server-window.txt`）：

```
2026-11-01T12:59:04.522287Z  INFO … request_id="cli:pane:close" method="pane.close"
2026-11-01T12:59:04.523279Z  INFO … event="pane.exit" pane_id=37 status="ExitStatus { code: 1, signal: None }"
2026-11-01T12:59:04.524952Z  INFO herdr::pane: pane session terminated pane=37 pid=124172 signal=Hangup
2026-11-01T12:59:04.525057Z  INFO … outcome="ok" … method="pane.close"
```

（`pane_id=37` / `pid=124172` 是窗格里的 shell，不是 pi；pi 是 124290，先于这条日志退出。）

root 的 `pg_terminate` 返回（`root-terminate-result.txt`）：

```
2026-11-01T12:59:04.525Z [{"type":"text","text":"{\"terminated\":[\"m_a763f5\"],\"pane_close_failed\":[]}"}]
```

## 判定

| 观测 | 结果 | 数值 |
|---|---|---|
| O1 会话文件完整（JSON 全可解析、行尾换行） | PASS | 31 条，0 坏行 |
| O2 最后一次会话写入早于 pi 退出 | PASS | 02.358 ≤ 04.340 |
| O3 `sys.terminated` 送达早于退出 | PASS | 03.915 → 04.340（425 ms） |
| O4 pi 退出后 pane 仍在列表里，close 在其后 | PASS | agent 消失 04.502，close 04.522（+20 ms） |
| O5 pi 走完 graceful exit | PASS | 回滚里有 `To resume this session:` + shell 提示符 |
| O6 窗格消失、无残留 pi、成员 gone | PASS | 三项都成立 |
| O7 适配器未报 `pane_close_failed` | PASS | `[]` |
| O8 关窗等待在 5 s 硬上限内 | PASS | 608 ms |

反事实（`7ae1adc` 之前）：pane 会在 `12:59:03.914` 就关掉——比 pi 退出早 426 ms，pi 会被
SIGHUP 打断在 shutdown 中途；这次会话里没有删除之后写入的条目，所以丢的不是“数据”，而是
子成员没有机会走完自己的退出。

## 备注

- `attempt0-run.txt` / `attempt1-run.txt` 是探针本身的两轮返工（先是找不到子进程 pid，因为
  pi 会把自己的 argv 重写成 `pi`；后来改用 `HERDR_PANE_ID` + `PIGROUPS_TOKEN` 认进程），
  不是产品行为，保留只为可追溯。
- `control/` 是一次性对照：一个 `pi.on('agent_settled')` 里调 `ctx.shutdown()` 的最小会话。
  它说明 **pi 的会话 JSONL 里没有“shutdown 记录”**——正常退出时最后一条就是最后一条普通消息
  （`control/clean-shutdown-session.jsonl`）。所以“结束得干净”的判据只能是：文件完整 +
  最后一次写入早于进程退出 + 窗格回滚里的 `To resume this session:` 行。
- 分析脚本：`node probe/paneclose-analyze.mjs <本目录>`，输出即 `timeline.txt`。
