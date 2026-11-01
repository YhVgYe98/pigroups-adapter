# fix A 真机验证：#3 删除时子成员卡在 `bash sleep 40` 里 —— **FAIL**

**结论：FAIL（8 项里 3 项失败）。** 子成员收到 `sys.terminated` 时正在跑
`bash {"command":"sleep 40"}`。适配器等到 5 s 硬上限（`PANE_AGENT_EXIT_TIMEOUT_MS`）就
照常关窗格——**关窗时 `herdr pane list` 还把该 pane 报成 `agent=pi status=working`**。
pi 没有走完自己的退出路径：会话文件停在那个工具调用上，没有工具结果，没有
`To resume this session:`，herdr 也没有记录过“agent 离开窗格”。

这不是“抓到了旧 bug 的 0 ms 竞态”，而是同一个竞态的 5 s 版本：等待有上限，而子成员在
工具运行时不会中途退出。

## 环境

| 项 | 值 |
|---|---|
| adapter | `e1fcf13`，`src/herdr.ts` sha256 `196886e5be8bfa9f…` |
| 平台 | 端口 40777，一次性数据目录 |
| root | 成员 `m_570ee1`，pane `wE:p1E` |
| child | 成员 `m_11953b`，pane `wE:p1F`，pi pid 129090，窗格 shell pid 128972 |
| 版本 | pi 1.4.0 / herdr 0.9.5 / node v26.12.1，`deepseek/deepseek-flash` |
| 复跑 | `CHILD_TASK=midtool CHILD_TOOL_SLEEP=40 bash driver.sh` |

子成员的启动方式与前两次相同（`-ne -e <adapter>/src/extension.ts`，`--session-dir` 取证用）。
区别在于：先让它正常起来、说一句话、idle；然后 root 用 `pg_say` 命令它执行
`bash sleep 40`，等真正的 toolCall 出现在会话文件里之后，再 `pg_terminate`。

## 时间线（UTC）

| 时刻 | 事件 | 来源 |
|---|---|---|
| `13:03:40.446` | 子成员写下 `bash {"command":"sleep 40"}` 的 toolCall（工具开始跑） | `child-session.jsonl` |
| `13:03:44.335` | 平台提交 DELETE，写入 `sys.terminated` | `controls-after-terminate.json` |
| `13:03:44.335` | 子成员取走 notice（`delivered`） | 同上（`delivered_at`） |
| `13:03:49.340` | **最后一次**看到该 pane：`present  agent=pi  working` | `pane-samples.tsv` |
| `13:03:49.366` | herdr 收到 `pane.close`（DELETE 后 **5031 ms**，硬上限 5000 ms） | `herdr-server-window.txt` |
| `13:03:49.367` | 窗格 shell 退出（`code: 1`） | 同上 |
| `13:03:49.375` | 第一个说 `/proc/129090` 没了的采样（20 ms 粒度） | `pid-samples.tsv` |
| `13:03:49.381` | `pane list` 第一次报该 pane 不存在 | `pane-samples.tsv` |
| `13:03:49.389` | `pane session terminated pane=41 pid=128972 signal=Hangup` | `herdr-server-window.txt` |

注意最后几次采样的顺序：pane 一直报到 `49.340` 仍是 `agent=pi / working`，`49.366` 发出
close，`49.375` 才第一次看不到 pi 的进程。**close 发出时 pi 还活着**（20 ms 的进程采样粒度内，
它只可能是在 `49.355–49.375` 之间消失的，无法再细分到 close 的前后 11 ms）；herdr 对这次结束
的记录是 `pane session terminated … signal=Hangup`，并没有“agent 离开窗格”那一条。

## 原始证据

`pane-samples.tsv` 最后两行（40 ms 采样）：

```
1793538229340  2026-11-01T13:03:49.340Z  present  pi  working  π - probe-child - pgpc-scratch.DZHuv5
1793538229381  2026-11-01T13:03:49.381Z  absent
```

`pid-samples.tsv`（全部）：

```
1793538221552  2026-11-01T13:03:41.552Z  running  S
1793538229375  2026-11-01T13:03:49.375Z  gone
```

`herdr-server-window.txt`：

```
2026-11-01T13:03:49.366576Z  INFO … request_id="cli:pane:close" method="pane.close"
2026-11-01T13:03:49.367562Z  INFO … event="pane.exit" pane_id=41 status="ExitStatus { code: 1, signal: None }"
2026-11-01T13:03:49.389441Z  INFO herdr::pane: pane session terminated pane=41 pid=128972 signal=Hangup
2026-11-01T13:03:49.389562Z  INFO … outcome="ok" … method="pane.close"
```

herdr 对 `pane=41` 的全部生命周期日志（`grep "pane=41"`）——只有“agent 出现”和
“pane 会话被挂断”，**没有** “agent 离开窗格”那一条：

```
2026-11-01T13:03:17.371316Z  INFO herdr::pane: agent changed pane=41 previous_agent=None agent=Some(Pi) process=pi pgid=Some(129090)
2026-11-01T13:03:49.389441Z  INFO herdr::pane: pane session terminated pane=41 pid=128972 signal=Hangup
2026-11-01T13:03:49.389655Z  WARN herdr::app::actions: PaneDied for unknown pane pane=41
```

子成员会话文件：文件本身没被截断（最后一行完整、有换行），但**最后一条是没等到结果的
工具调用**：

```
lines=31 bad=0 endsWithNewline=true
last.type=message role=assistant stopReason=toolUse
```

```
{"type":"message","id":"1fbe257d",…,"timestamp":"2026-11-01T13:03:40.446Z","message":{"role":"assistant",
 "content":[{"type":"thinking","thinking":"Root asks me to call bash with command 'sleep 40' exactly once…
 [{"type":"toolCall","id":"call_00_60SgGDDYkO6okumYNDMs6289","name":"bash","arguments":{"command":"sleep 40","timeout":60}}]
```

`child-pane-at-exit.txt` **不存在**：pane 采样从没看到过“pane 在、agent 没了”的那一帧，
没有机会在 close 前抓回滚。

root 的 `pg_terminate` 返回成功，且没报关闭失败：

```
2026-11-01T13:03:49.390Z [{"type":"text","text":"{\"terminated\":[\"m_11953b\"],\"pane_close_failed\":[]}"}]
```

## 判定

| 观测 | 结果 | 数值 / 理由 |
|---|---|---|
| O1 会话文件完整（JSON 全可解析、行尾换行） | PASS | 31 条，0 坏行（但最后一条是 in-flight 工具调用） |
| O2 最后一次写入早于 pi 退出 | PASS | 40.446 ≤ 49.375（这是“没截断”的必要条件，不是充分条件） |
| O3 notice 送达早于退出 | PASS | 44.335 → 49.375 |
| O4 **pi 退出后 pane 仍在、close 在其后** | **FAIL** | 最后一次 pane 采样（49.340）仍是 `agent=pi working`；close 49.366；pi 49.375 才消失 |
| O5 **pi 走完 graceful exit** | **FAIL** | 没有 `To resume this session:`，也没有工具结果；`stopReason=toolUse` |
| O6 窗格消失、无残留 pi、成员 gone | PASS | 三项成立（但窗格是被 close 收掉的） |
| O7 无 `pane_close_failed` | PASS | `[]`——**注意：子成员被切断了，适配器仍然报成功** |
| O8 **等待在 5 s 硬上限内** | **FAIL** | 5031 ms > 5000 ms，到点照常关窗格，关的仍是一个活着的 agent |

反事实不成立（这次没有“丢掉的写入”）：删除之后子成员一个字都没写，所以会话文件没有丢行。
失败的不是“文件被截半行”，而是**close 在子成员退出之前就发生了**：5 s 上限到点时 pi 还在
工具里（pane 仍报 working），窗格被 SIGHUP 挂断，子成员没有机会走完自己的退出。

## 为什么会这样（机制，见下一个目录的对照）

pi 在 shutdown 期间不会中途放弃正在跑的工具。`paneclose-…-midtool6` 用 `sleep 6` 跑了同样的
流程：notice 送达后工具又跑了 2.5 s 跑到自然结束，子成员先写工具结果、再写收尾消息、
然后才退出；pane close 在那之后。也就是说，子成员的退出耗时 ≈ 剩余工具时间 + 收尾，
而 `PANE_AGENT_EXIT_TIMEOUT_MS = 5000` 是一个固定上限。

另外 `src/loop.ts:105` 的 `STOP_TIMEOUT_MS = 3000`、`817-823` 的 `discardAndShutdown()`
（`await this.stop()` 之后才 `surface.shutdown()`）意味着适配器自己也有一个 3 s 的等待；
两个上限在这种场景下都会到点。这次的全部产物无法分辨 pi 的 shutdown 究竟从哪一刻开始
（没有 `pg.report{exiting}`：成员已被删除，`whoami` 失败），但确定的是：**到 5 s 时 pi 还活着，
close 先动手了。**

## 备注

- 这条 FAIL 不是“探针没等够”：driver 在删除后一直采样，pane 从 `working` 直接跳到 `absent`，
  中间没有“agent 已退出、pane 还在”的一帧。
- 会话文件没有截断这一次是运气：`bash sleep 40` 的 toolCall 写在删除前 3.9 s，之后 pi 没有
  再写任何东西。若被切断的时刻正赶上一行写一半，后果就是截断。
- 分析脚本：`node probe/paneclose-analyze.mjs <本目录>`（输出即 `timeline.txt`，退出码 1）。
