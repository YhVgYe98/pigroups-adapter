# fix A 真机验证：#4 删除时子成员卡在 `bash sleep 6` 里（机制对照）

**结论：PASS（8/8）。** 与 #3 只差工具长度：这次删除时工具还剩约 2.5 s，子成员把工具跑完
（notice 送达后 2.5 s 写出工具结果）、再写一条收尾消息、然后自己退出，pane close 在那之后。
这条运行的作用是把#3 的失败原因钉死：**pi 在 shutdown 期间不放弃正在跑的工具；
子成员能走完退出，是因为它的剩余工作短于 5 s 上限。**

## 环境

| 项 | 值 |
|---|---|
| adapter | `e1fcf13`，`src/herdr.ts` sha256 `196886e5be8bfa9f…` |
| 平台 | 端口 40777，一次性数据目录 |
| root | 成员 `m_6e1726`，pane `wE:p1G` |
| child | 成员 `m_771744`，pane `wE:p1H`，pi pid 131625 |
| 版本 | pi 1.4.0 / herdr 0.9.5 / node v26.12.1，`deepseek/deepseek-flash` |
| 复跑 | `CHILD_TASK=midtool CHILD_TOOL_SLEEP=6 bash driver.sh` |

## 时间线（UTC）

| 时刻 | 事件 | 来源 |
|---|---|---|
| `13:05:11.737` | 子成员写下 `bash {"command":"sleep 6"}` 的 toolCall | `child-session.jsonl` |
| `13:05:15.239` | 平台提交 DELETE，写入 `sys.terminated`；子成员同一毫秒取走 notice | `controls-after-terminate.json` |
| `13:05:17.742` | **工具结果写进会话**（删除后 2.5 s，工具自然结束，没有被打断） | `child-session.jsonl` |
| `13:05:18.809` | 子成员写完最后一条 assistant 消息（`Ran \`sleep 6\` once. Stopping.`） | `child-session.jsonl` |
| `13:05:18.926` | `/proc/131625` 消失（20 ms 采样） | `pid-samples.tsv` |
| `13:05:18.948` | `pane list` 第一次报 pane 无 agent | `pane-samples.tsv` |
| `13:05:19.064` | herdr 收到 `pane.close` | `herdr-server-window.txt` |
| `13:05:19.072` | `pane list` 第一次报 pane 不存在 | `pane-samples.tsv` |

DELETE → close 共 **3825 ms**（上限 5000 ms，余量 1175 ms）。

## 原始证据

会话里删除之后的两次写入（`child-session.jsonl`）：

```
2026-11-01T13:05:17.742Z  message role=toolResult  [{"type":"text","text":"(no output)"}]
2026-11-01T13:05:18.809Z  message role=assistant stopReason=stop  [{"type":"text","text":"Ran `sleep 6` once. Stopping."}]
```

工具确实跑满 6 s（`11.737 → 17.742`），而不是在 shutdown 时立刻返回——这是“pi 等工具”
而不是“pi 打断工具”的直接证据。

窗格回滚（`child-pane-at-exit.txt`，pid 消失后 22 ms 抓的）：

```
To resume this session: pi --session-dir /tmp/pgpc-childsess.cV9kmX --session 01a19736-577a-7460-a97a-53e3abfadf2f
```

会话完整性：

```
lines=27 bad=0 endsWithNewline=true
last.type=message role=assistant stopReason=stop
```

herdr 日志：

```
2026-11-01T13:05:19.064352Z  INFO … request_id="cli:pane:close" method="pane.close"
2026-11-01T13:05:19.067757Z  INFO herdr::pane: pane session terminated pane=43 pid=131508 signal=Hangup
```

## 判定

| 观测 | 结果 | 数值 |
|---|---|---|
| O1 会话文件完整 | PASS | 27 条，0 坏行 |
| O2 最后一次写入早于 pi 退出 | PASS | 18.809 ≤ 18.926（117 ms） |
| O3 notice 送达早于退出 | PASS | 15.239 → 18.926（3687 ms） |
| O4 pi 退出后才 close | PASS | agent 消失 18.948，close 19.064（+116 ms） |
| O5 graceful exit | PASS | 回滚里有 `To resume this session:` |
| O6 窗格消失、无残留 pi、成员 gone | PASS | 三项成立 |
| O7 无 `pane_close_failed` | PASS | `[]` |
| O8 等待在 5 s 内 | PASS | 3825 ms（余量 1175 ms） |

反事实：`7ae1adc` 之前会在 `13:05:15.239` 关窗，删除之后写入的两条
（`13:05:17.742Z` 工具结果、`13:05:18.809Z` 收尾消息）都会丢。

## 备注

- 与 #3 的差别只有“剩余工具时间”：约 2.5 s（本目录，PASS）对约 35 s（#3，FAIL）。
  两者的 `PANE_AGENT_EXIT_TIMEOUT_MS` 都是 5000，这是同一个边界的两侧。
- 分析脚本：`node probe/paneclose-analyze.mjs <本目录>`（输出即 `timeline.txt`）。
