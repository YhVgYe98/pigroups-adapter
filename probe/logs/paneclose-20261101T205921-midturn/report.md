# fix A 真机验证：#2 删除时子成员正在一轮 turn 里

**结论：PASS（8/8），但余量只剩 374 ms。** 这次删除落在子成员一轮模型 turn 中途；
子成员在收到 `sys.terminated` 之后 4.3 s 才写完那一轮，然后自己退出，pane close 在其后。
关窗一共等了 4626 ms，而 `PANE_AGENT_EXIT_TIMEOUT_MS` 是 5000 ms。

## 环境

| 项 | 值 |
|---|---|
| adapter | `e1fcf13`，`src/herdr.ts` sha256 `196886e5be8bfa9f…` |
| 平台 | 端口 40777，一次性数据目录 |
| root | 成员 `m_fea2df`，pane `wE:p1C` |
| child | 成员 `m_31b9f8`，pane `wE:p1D`，pi pid 125955 |
| 版本 | pi 1.4.0 / herdr 0.9.5 / node v26.12.1，`deepseek/deepseek-flash` |
| 复跑 | `CHILD_TASK=midtool bash driver.sh`（本目录的 driver 是**当时那一版**，见 `correction.txt`） |

## 这次跑的是什么（以及探针当时的错误判断）

原计划让子成员在 `bash sleep 25` 里被删除。实际发生的是：

1. 子成员第一轮就调了 `bash {"command":"sleep 25"}`（`12:59:34.283`），`12:59:59.287` 返回；
2. 但 `pg_spawn` 要等 `herdr agent wait --until idle`，root 的 spawn turn 直到子成员第一轮
   结束才返回，driver 拿到 child id 时 sleep 已经过去 16 s；
3. 于是删除落在**下一轮**（被适配器 nudge 触发的一轮）中途。

`run.txt` 里 “bash call seen in the child session” 那行是探针判据太松（`grep '"name":"bash"'`
连系统提示里的工具声明一起匹配了）。`correction.txt` 记了这件事和严格判据的复查结果。
`run.txt` 按当时打印的原样保留。

## 时间线（UTC）

| 时刻 | 事件 | 来源 |
|---|---|---|
| `13:00:15.495` | 平台提交 DELETE，写入 `sys.terminated` | `controls-after-terminate.json` |
| `13:00:15.495` | 子成员取走 notice（`delivered`） | 同上 |
| `13:00:19.807` | 子成员写完删除之后的那条 assistant 消息 | `child-session.jsonl` |
| `13:00:19.925` | `/proc/125955` 消失（20 ms 采样） | `pid-samples.tsv` |
| `13:00:19.953` | `pane list` 第一次报 pane 无 agent | `pane-samples.tsv` |
| `13:00:20.121` | herdr 收到 `pane.close` | `herdr-server-window.txt` |
| `13:00:20.158` | `pane list` 第一次报 pane 不存在 | `pane-samples.tsv` |

DELETE → close 共 **4626 ms**（上限 5000 ms，余量 374 ms）。

## 原始证据

删除之后仍写进会话文件的那一条（`child-session.jsonl` 最后一条）：

```
2026-11-01T13:00:19.807Z  message role=assistant stopReason=stop
```

会话完整性：

```
lines=21 bad=0 endsWithNewline=true
last.type=message role=assistant stopReason=stop
```

窗格回滚（`child-pane-at-exit.txt`，pid 消失后 28 ms 抓的）：

```
To resume this session: pi --session-dir /tmp/pgpc-childsess.1TwOdB --session 01a19731-95c5-732e-a4f0-9e55bde0b81d
```

`sys.terminated` receipt：

```json
{"seq":1,"from":"sys","to":"m_31b9f8","cmd":"sys.terminated","created":"2026-11-01T13:00:15.495Z",
 "receipts":[{"to":"m_31b9f8","state":"delivered","delivered":"2026-11-01T13:00:15.495Z"}]}
```

herdr 日志：

```
2026-11-01T13:00:20.121586Z  INFO … request_id="cli:pane:close" method="pane.close"
2026-11-01T13:00:20.122597Z  INFO … event="pane.exit" pane_id=39 status="ExitStatus { code: 1, signal: None }"
2026-11-01T13:00:20.124844Z  INFO herdr::pane: pane session terminated pane=39 pid=125838 signal=Hangup
2026-11-01T13:00:20.124938Z  INFO … outcome="ok" … method="pane.close"
```

## 判定

| 观测 | 结果 | 数值 |
|---|---|---|
| O1 会话文件完整 | PASS | 21 条，0 坏行 |
| O2 最后一次写入早于 pi 退出 | PASS | 19.807 ≤ 19.925（118 ms） |
| O3 notice 送达早于退出 | PASS | 15.495 → 19.925（4430 ms） |
| O4 pi 退出后才 close | PASS | agent 消失 19.953，close 20.121（+168 ms） |
| O5 graceful exit | PASS | 回滚里有 `To resume this session:` |
| O6 窗格消失、无残留 pi、成员 gone | PASS | 三项成立 |
| O7 无 `pane_close_failed` | PASS | `[]` |
| O8 等待在 5 s 内 | PASS（余量 374 ms） | 4626 ms |

反事实：`7ae1adc` 之前会在 `13:00:15.495` 关窗，比 pi 退出早 4430 ms；删除之后写入的那条
`13:00:19.807Z(message/assistant)` 会丢。

## 备注

- 4.3 s 里包含什么：notice 送达时子成员正处在一轮 turn 中；从证据只能确定
  （a）`ctx.shutdown()` 的 pi 侧退出发生在该轮写完之后，（b）pi 自己没被信号打断。
  这些产物无法区分“适配器晚调 `ctx.shutdown()`”和“pi 的 shutdown 等这一轮结束”，
  但两种情况的后果一样：子成员的退出耗时不受适配器约束，5 s 上限随时可能到点。
  下一条（`paneclose-…-midtool`）证明“工具在跑时 pi 不会中途放弃它”。
- 分析脚本：`node probe/paneclose-analyze.mjs <本目录>`（输出即 `timeline.txt`）。
