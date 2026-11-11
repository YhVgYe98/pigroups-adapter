# 回合边界投递 — 真机验证（2026-11-11T17:50:58Z）

验证对象：`cce755e` 的投递设计（`docs/概念稿.md` §8.1–§8.3）。一台机器、一次性平台、
一个真成员、一个 120 秒的 bash 工具、一次平台侧 `pg.abort`。

**结论：四项全部 PASS。** 原始证据在本目录；`node analyze.mjs` 会从
`final-session.jsonl` / `final-probe.jsonl` 重新算出下面的每个结论并打印 PASS/FAIL。

## 环境与方法

| 项 | 值 |
|---|---|
| adapter | `cce755e52cec6c20a743c5b7a2739b33a9584fbb`（0.17.1） |
| `src/loop.ts` | `sha256 79db0b562ee862e3437adfb990bc608528959166b3c3bc63a0b75d699dbd09f7` |
| `src/surface.ts` | `sha256 cd810f7a86ed14e77c509e8f37860c2965460d8cfd4b289bbac28ebc2b74f606` |
| pi / herdr / node | 1.5.0 / 0.9.5 / v26.13.0 |
| platform | 0.7.2，一次性目录 + `127.0.0.1:34213`，pid 1632902 |
| 成员 | `m_429f41`（`m_a745c9` 的直接子成员），独立 `--session-dir` |
| 模型 | `deepseek/deepseek-flash` |
| 投递窗口 | **生产默认 60 000 ms，未覆盖** |
| 轮询 | `PIGROUPS_POLL_WAIT=1`（默认 25 秒）——只改轮询节奏，让“到达到入队”和“窗口到投递”可测到约 1 秒；不改任何投递规则 |
| 工具 | 内置 `bash`，命令 `sleep 120; echo SLEEPDONE`（timeout 150） |

两处刻意的选择，先说清楚：

1. **工具是 120 秒，不是 60 秒。** 窗口也是 60 秒；若工具恰好 60 秒，“窗口关闭”和
   “工具返回”会落在同一秒里，测不出到底是窗口还是回合边界在挡。120 秒把两个时钟分开：
   窗口在工具的第 65 秒关闭，离工具返回还有 54.8 秒，于是“忙就不投”这条闸门被单独量到。
   第 1 项要的语义（消息在长工具里到达、不进当前回合、工具结果之后只出现一次）完全覆盖，
   而且比 60 秒版本更严格。
2. **轮询 1 秒**只出现在这次测量里；生产 25 秒的空轮询会让“到达 → 入队”多出最多 25 秒，
   它不属于“窗口 + 剩余回合”这两段设计延迟。日志里两段都分开报。

探针：`probe/boundary-probe.ts`（只记 pi 事件，不 import `src/`），驱动：
`probe/boundary-driver.mjs`。两份都在本目录留了副本。没有用 `pg_steer`：这次只验投递，
不验“steer 是不是被吞”。

## 第 1 项 — 长工具期间发消息：PASS

消息在工具开始后 **5.16 秒**发出，窗口在工具的第 65 秒关闭，工具在 120.005 秒返回。

| 事件 | 原始时间戳（本机时钟） |
|---|---|
| `bash` tool call | `2026-11-11T17:51:04.083Z` |
| 消息 POST / 平台 `created_at` | `17:51:09.244Z` / `17:51:09.246Z`（`dm:m_429f41_m_a745c9#1`） |
| 窗口按设计关闭 | `17:52:09.246Z`（工具仍在本轮里，离工具返回 54.844 秒） |
| `bash` tool result（`SLEEPDONE`） | `17:53:04.090Z`（`durationMs=120005`） |
| **`custom_message` 落盘** | **`17:53:05.128Z`**（工具结果后 **1.038 秒**） |
| 模型第一次回复 | `17:53:05.939Z` |

session 文件里的顺序（`timeline.txt`，行号是 `final-session.jsonl` 的下标）：

```
5  assistant  toolUse   bash sleep 120        17:51:04.083Z
6  toolResult SLEEPDONE                        17:53:04.090Z
7  assistant  READY（本回合最后一句话）        17:53:05.125Z
8  custom_message [dm:m_429f41_m_a745c9#1 …]  17:53:05.128Z   ← 唯一一份
9  assistant  BOUNDARY-A-75058Z                17:53:05.939Z   ← 新回合
```

探针的边界序列完全对得上：`tool_end 17:53:04.089Z` → `before_settle 17:53:05.126Z` →
`agent_settled(aborted=false) 17:53:05.126Z` → `agent_start 17:53:05.127Z` →
`message_end(custom, deliveryId=58ef145d-…) 17:53:05.128Z`。

**它没有在回合中间出现**（第 6 行之前没有任何 `custom_message`），也**不在工具结果之前**。
旧设计（忙时 steer）会把它塞进第 5–6 行之间；这次没有。

## 第 2 项 — 平台 `pg.abort` 切回合：PASS

第二轮同样的 120 秒工具；消息在工具第 5 秒发出，8 秒后从平台发 `pg.abort`
（父成员 token，`POST /v1/control`，`cmd:'pg.abort'` → `handleControl → abortTurn`）。
这就是父/人“从 run 里切一个子成员”走的那条路；**本会话内**的 `pg_abort` 工具不带 member 时
走的是 `surface.abort()` 直达，不经过 `abortTurn()`（同样会在 aborted 的 `turn_end` 上重置窗口），
这次没有单独测那条。

| 事件 | 原始时间戳 |
|---|---|
| `bash` tool call | `2026-11-11T17:53:09.016Z` |
| 消息 POST / `created_at` | `17:53:14.023Z` / `17:53:14.025Z`（`dm:m_429f41_m_a745c9#2`） |
| `pg.abort` POST | `17:53:22.026Z`（平台回 `control_seq=1`，初态 `pending`） |
| 工具被切（`Command aborted`） | `17:53:22.030Z`（工具跑了 13 013 ms） |
| 回合结束（`agent_settled aborted=true`） | `17:53:22.032Z`（POST 后 **6 ms**） |
| 窗口内的任何 `agent_start` / `custom_message` | **无**（从 cut 到 `17:54:22.032Z`，采样步长 1 秒） |
| **`custom_message` 落盘** | **`17:54:22.189Z` = 切点后 60 157 ms** |
| 下一个 `agent_start` | `17:54:22.189Z`（同一毫秒，就是这次投递） |
| 模型第一次回复 | `17:54:23.362Z` |

判别性：这条消息原本的窗口在到达后约 1 秒内开，会在 `17:54:14.0–15.0` 关闭
（到达 + 60 秒，加上最多 1 秒轮询），也就是**切点后 52–53 秒**；即使入队晚 2 秒，
原窗口也不会晚于切点后约 54 秒关闭。实测在切点后 **60.157 秒**才投递，落在原窗口之外——说明 `windowStart` 真的在 aborted 的
`turn_end` 上重置了，不是“碰巧晚了一点”。旧代码的 abort 后强制 flush 会在
`17:53:22` 附近就出现 `custom_message`；这次没有。

`pg.abort` 本身没有进上下文：整个 session 里 `"[control"` 出现 **0** 次
（`pg.abort` 只在 system prompt 的工具表里出现 1 次）。

## 第 3 项 — `[conv#seq]` 在整份 session 里的出现次数：PASS

`final-session.jsonl` 共 16 条，`custom_message` 恰好 **2** 条（两轮各一条）。

| 计数对象 | 次数 |
|---|---|
| `[dm:m_429f41_m_a745c9#1` | **1** |
| `[dm:m_429f41_m_a745c9#2` | **1** |
| `[dm:m_429f41_m_a745c9#1 2026-11-12 01:51]`（带时间戳的完整前缀） | **1** |
| `[dm:m_429f41_m_a745c9#2 2026-11-12 01:53]` | **1** |
| 裸标记 `BOUNDARY-A-75058Z` | 4 |
| 裸标记 `BOUNDARY-B-75058Z` | 3 |

裸标记的次数不是投递次数：它本来就出现在消息正文里两次（“when you next see … reply with
exactly …”），模型回复（或 thinking）里又出现一次/两次。要验的是 `[conv#seq]` 前缀，两次都是 1。

## 第 4 项 — 投递延迟：PASS

“可见”取两个点：`custom_message` 落盘（已进 transcript、新回合已起）和模型第一次回复。

**第 1 轮（消息到达时工具还有 114.8 秒）**

| 分段 | 毫秒 | 说明 |
|---|---|---|
| 到达 → 窗口关闭 | **60 000** | 生产窗口；入队发生在到达后 ≤1 秒（poll wait=1） |
| 窗口关闭 → 工具返回 | **54 844** | 这就是“剩余回合”的代价：窗口早关了，闸门不放 |
| 工具返回 → 投递落盘 | **1 038** | 本回合还要再跑一次模型（`READY`）才 settle，然后新回合起 |
| 到达 → `custom_message` | **115 882** | 60.000 + 54.844 + 1.038 |
| 落盘 → 模型第一次回复 | **811** | 新回合的模型延迟 |
| 到达 → 模型第一次回复 | **116 693** | |

**第 2 轮（abort）**

| 分段 | 毫秒 | 说明 |
|---|---|---|
| 到达 → `pg.abort` POST | **8 001** | 消息在工具里等了 8 秒 |
| POST → 切点 | **6** | 平台控制被轮询取走；`abort()` 立即结束回合 |
| 切点 → 投递落盘 | **60 157** | 重新计时的窗口 60 000 + flush 157 |
| 到达 → `custom_message` | **68 164** | 8.001 + 0.006 + 60.157 |
| 落盘 → 模型第一次回复 | **1 173** | |
| 到达 → 模型第一次回复 | **69 337** | |

## 与概念稿 / 设计说明的对照

**从行为上验到的、与文档一致的点：**

- §8.1 “投递只在回合边界”：第 1 轮的 `custom_message` 在 `agent_settled` 之后 2 ms、
  `agent_start` 之后 1 ms；`before_settle/agent_settled` 之前一个都没有。
- §8.1 “窗口关闭 + pi 空闲，两个条件同时成立”：第 1 轮窗口在工具第 65 秒关闭，
  投递发生在工具返回 + 回合结束之后（+1.038 秒）。光有窗口不够，光有空闲也不够。
- §8.3 ① “abort 只结束这一轮，窗口从切点重新计时”：切点后 60.157 秒才投递；原窗口会在
  切点后 52–53 秒关闭。第 2 轮没有任何“abort 后立刻投”或“下一批免等窗口”。
- §8.4 “`pg.abort` 不进上下文”：`"[control"` 出现 0 次。
- §8.1 提交点是回声：`custom_message.details.deliveryId` 与探针收到的 `message_end` 的
  `deliveryId` 一一对应；两轮之后 `injected.json` 分别是 `#1`、`#2`，`journal/` 为空。
  （这只能证明“回声之后状态正确”，不能在真机上证明两次写盘之间的先后；那一层只能靠
  `test/delivery.test.ts` 的 failed-prepare 用例。）

**读起来比实现更强的两处措辞（不是本次行为矛盾，但建议下次改文档时收紧）：**

1. §8.1 的 **“没有副本，没有重投表。”** 紧接着又说没回声的批次“原样重投”。字面上两者
   需要“回声之后没有副本”这个限定；实现里 `inFlight` 在“send 已接受、pi 还没回声”之间
   保留一份（至多一份）。本次两轮的 `custom_message` 与探针的 `message_end` 都在同一毫秒，
   `inFlight` 随即释放，所以行为上没看到任何副本；但这句原文单独读会与实现冲突。
2. §8.1 的 **“窗口在它干活的第 10 秒就关了”** 是例子；本次是第 65 秒关闭（工具 120 秒、
   消息在第 5 秒到达）。不影响结论。

**这次没有覆盖、因此不能算验过的条目：**

- 401 token 提示走 `notice`（`triggerTurn:false`）的路径；
- “投递已发出、pi 还没回声 → abort”那一行（需要注入 prepare 失败）；
- 溢出 10 条、journal 重放、启动简报不等窗口、催办；
- `lastAssistantText` / `pg.inspect` 那条链路。

## 清理

`cleanup.json` 与 `run.txt` 的原始记录：

- 平台 pid `1632902`：已退出（`alive=false`）；成员 pi pid `1633028`：已退出。
- `/proc` 扫描：没有进程的 environ 含本次的 `PIGROUPS_DATA=/tmp/pigroups-boundary-data.tuOR9k`。
- 窗格基线 = 结束列表：`wE:p55 wE:p5G wE:p5Z wE:p62`，一个不多一个不少；`wE:t42` 已关闭。
- 四个临时目录（data / adapter dir / scratch / sessions）已删除。
- `commands.txt` 里的成员 token 与 `*_API_KEY` 已打成 `<redacted>`（平台已销毁，token 无效；
  仍然不落盘）。

## 文件

| 文件 | 内容 |
|---|---|
| `final-session.jsonl` | pi 自己的 session 文件（测量本体，16 条） |
| `final-probe.jsonl` / `probe.jsonl` | 探针事件（含 `epoch_ms`、`deliveryId`、abort 边界） |
| `phase-a/`、`phase-b/` | 各轮的 `session.jsonl` + `probe.jsonl` + `message.json` / `abort.json` + `summary.json` + `adapter-view/` |
| `adapter-view/injected.json` | 水位：两轮后 `{dm:m_429f41_m_a745c9: 2}` |
| `adapter-view/journal/` | 空（回声后已提交） |
| `analysis.txt` | `node analyze.mjs` 的输出（逐项 PASS/FAIL + 原始时间戳） |
| `timeline.txt` | 只看关键行的 session 时间线（一行一个 JSON） |
| `run.txt` / `commands.txt` | 驱动日志与每一条 herdr/git 命令（归档成 `.txt`：`.gitignore` 忽略 `*.log`） |
| `platform.txt` / `platform.pid` / `env.sh` | 一次性平台 |
| `baseline-panes.json` / `final-panes.json` / `cleanup.json` | 清理证据 |
| `boundary-driver.mjs` / `boundary-probe.ts` | 本次驱动与探针的副本（顶层 `probe/` 也有）。驱动副本是跑完后补了命令日志脱敏（`redact()`）的同一份，投递逻辑未改；本次实际执行的是未脱敏日志版 |

## 复跑

```bash
cd /home/yang/Documents/pigroups-adapter
EVID=probe/logs/boundary-$(date -u +%Y%m%dT%H%M%SZ) node probe/boundary-driver.mjs
cp probe/logs/boundary-20261111T175058Z/analyze.mjs "$EVID"/
node "$EVID/analyze.mjs"    # 默认读脚本所在目录；也可以传一个证据目录参数
```

实测 `17:50:58 → 17:54:26`（约 3.5 分钟）。需要 `herdr` server、`pi`、一个可用模型与凭据；
平台、成员、adapter 目录、session 目录都是临时目录，驱动自己收尾。
