# v3 验证报告：0.5.0 的投递、名册与预约

运行：`v3-20261101T173805Z` · pi 1.4.0 · herdr 0.9.5 · node v26.12.1 ·
adapter HEAD `8d21f37` · 模型 `deepseek/deepseek-flash` · 一次性平台 `http://127.0.0.1:33283`。

本文只记录**证据**。结论先摆在这里：

| 项 | 结果 |
|---|---|
| 变异扫描（12 个） | **全部被杀**，无存活变异 |
| A 长工具中投递（不等空闲） | **PASS**：适配器在工具结束前 50.363 s 投递；pi 在工具返回后 **+1 ms** 落盘 |
| B abort 不丢队列里的消息 | **PASS（单批次）**：abort 后 55 ms 重新投递并落盘；去掉 requeue 的负对照复现 **LOST**。多批次同轮有洞，见 §7 |
| C 真机 `pg_members` / `pg_schedule` | **PASS**：名册 6 行、四种关系齐全；预约 10 s 的唤醒在到点后 8.9 s 送达 |
| D 两个 skill 被 pi 发现 | **PASS**：`[Skills]` 列表里同时出现 `pigroups-org`、`pigroups-message` |
| 清理 | pane 列表与运行前一致；无残留平台或 pi 进程 |

---

## 1. 变异扫描

每次变异都是**只改 `src/` 的一份临时副本**（`node_modules` 软链），测试树不动；
跑完后副本丢弃。驱动与补丁在 `mutation/`，原始输出 `mutation/results.txt`。
基线与每次恢复后：`npm test` 122/122 通过。

| # | 变异（src 里的一处改动） | 跑的测试 | 变红的测试（原文） | 存活？ |
|---|---|---|---|---|
| 1 | `windowDue()` 恒返回 `true`（窗口永不等待） | delivery | `a DM from the parent waits for its window, then arrives with the conversation id and the message seq`（另 7 条同文件） | 否 |
| 2 | 在 `deliverPending()` 顶部加回 `if (this.surface.isBusy()) return 'waiting'` | delivery | `a busy member still receives the window batch: delivery is a steer, not a wait for idle`；`the batch cap is a size valve…` | 否 |
| 3 | `deliver()` 去掉 `deliverAs: 'steer'` | surface | `deliver sends a custom message that asks pi to start a turn, as a steer` | 否 |
| 4 | `abortTurn()` 去掉强制 flush 与 `windowImmediate` | control | `pg.abort delivers what is pending without waiting for the window`；`pg.abort cuts, then closes the window and delivers the steer queued behind it at once`；`a message that arrives after the abort is delivered without waiting for a fresh window` | 否 |
| 5 | `turn_end(aborted:true)` 不再 `requeueLastDelivered()` | delivery | `a batch delivered into an aborted turn is put back and delivered again; a clean end clears it`；`a batch delivered into a provider-error turn is kept; the next aborted end re-sends it` | 否 |
| 6 | `relationOf()` 删掉 `sibling` 分支（兄弟报成 peer） | members | `pg_members lists the live roster with each member’s relation, parent name and child count` | 否 |
| 7 | `schedule()` 删掉下限检查 | schedule | `schedule() takes 5 s to 24 h and at most eight pending wakes` | 否 |
| 8 | `schedule()` 删掉上限检查 | schedule | 同上 | 否 |
| 9 | `schedule()` 删掉 8 条待触发上限 | schedule | 同上 | 否 |
| 10 | 到点的预约标成 `windowless: true`（绕过窗口） | schedule | `a due wake enters the queue as `[scheduled]`, waits for the delivery window, and fires once` | 否 |
| 11 | `pg_members` 的 `query` 去掉 `toLowerCase()` | members | `a query filters by name, case-insensitively, and total still tells the model the roster size` | 否 |
| 12 | 不订阅 `message_end`（最后一轮助手文本丢失） | surface | `message_end keeps the last assistant text, and only assistant text` | 否 |

**没有存活变异。** 两点说明：

- 第 1 个变异让 8/10 条投递测试变红；`chatter` 与 `gap` 两条仍绿是合理的——它们断言的
  是"有真实消息时才投"，不是"要等窗口"。
- 第 2 个变异只红 2 条：忙碌闸门在窗口关闭时唯一改变的就是"忙时也发"，
  另有批量上限测试因为它把剩余批次也挡住了。

---

## 2. 真机：A — 长工具运行中投递，不等空闲

成员 `v3a-174208`，`PIGROUPS_DELIVERY_WINDOW_MS=5000`。prompt 让它跑
`bash: sleep 60; echo SLEEPDONE`，工具开始后由 root 发一条 DM。

`A-steer-midtool/probe.jsonl`（探针，原始行截断）：

```
{"ts":"2026-11-01T17:42:13.949Z","step":"tool_start","toolName":"bash","args":{"command":"sleep 60; echo SLEEPDONE","timeout":120},"isIdle":false}
{"ts":"2026-11-01T17:43:13.955Z","step":"tool_end","toolName":"bash","isError":false,"result":{"content":[{"type":"text","text":"SLEEPDONE\n"}]},"isIdle":false}
```

`A-steer-midtool/adapter-watch.jsonl`（每 50 ms 采适配器自己的 journal 与注入水位）：

```
{"ts":"2026-11-01T17:42:14.357Z","journal":["0001793554934354-000000-f2a06903.json"],"injected":null}
{"ts":"2026-11-01T17:42:23.592Z","journal":[],"injected":{"mtimeMs":1793554943585.4,"content":{"v":1,"injected":{"dm:m_28c0c8_m_9ab09c":1}}}}
```

`A-steer-midtool/session.jsonl`（pi 自己的会话文件）：

```
2026-11-01T17:43:13.955Z toolResult bash isError=false durationMs=60004
2026-11-01T17:43:13.956Z custom_message "[dm:m_28c0c8_m_9ab09c#1] root: STEER-MARK-v3a-20261101T174208Z: …"
2026-11-01T17:43:14.739Z assistant "STEER-MARK-v3a-20261101T174208Z"
```

推导出的时间关系：

| 事件 | 时刻 | 相对量 |
|---|---|---|
| DM 写入平台 | 17:42:14.351 | — |
| **适配器 deliver 返回**（journal 清空 + 水位写入） | **17:42:23.592** | DM 后 9.241 s（= 5 s 窗口 + 5 s tick 粒度） |
| bash 工具返回 | 17:43:13.955 | **投递比工具结束早 50.363 s** |
| pi 落盘 `custom_message` | 17:43:13.956 | **工具返回 +1 ms** |
| 模型首次提到 marker | 17:43:14.739 | 落盘后 +783 ms |

**PASS。** 这条同时复现了概念稿 §8.2 的两个测量：`sendMessage` 返回 = 排队；
steer 真正落盘在工具返回 +1 ms。适配器没有等空闲——如果等空闲，水位只会在
17:43:13.955 之后写。

---

## 3. 真机：B — abort 不丢已投递的批次

成员 `v3b-174208`，同样 5 s 窗口、60 s 工具；工具开始后发 DM，等适配器投递完成，
再在工具还剩约 49 s 时发 `pg.abort`。

`B-abort-requeue/probe.jsonl`（探针，原始行截断）：

```
{"ts":"2026-11-01T17:43:21.028Z","step":"tool_start","toolName":"bash","isIdle":false}
{"ts":"2026-11-01T17:43:32.153Z","step":"tool_end","toolName":"bash","isError":true,"result":{"content":[{"type":"text","text":"Command aborted"}]},"isIdle":false}
{"ts":"2026-11-01T17:43:32.155Z","step":"agent_settled","event":{"type":"agent_settled","aborted":true},"isIdle":true}
{"ts":"2026-11-01T17:43:32.203Z","step":"agent_start","isIdle":false}
```

`B-abort-requeue/session.jsonl`（`timeline.txt` 同内容）：

```
{"index":6,"type":"message","timestamp":"2026-11-01T17:43:32.153Z","role":"toolResult","toolName":"bash","isError":true,"durationMs":11123,"text":"Command aborted"}
{"index":7,"type":"message","timestamp":"2026-11-01T17:43:32.154Z","role":"assistant","stopReason":"error","errorMessage":"This operation was aborted","text":""}
{"index":8,"type":"custom_message","timestamp":"2026-11-01T17:43:32.203Z","content":"[dm:m_1f66a4_m_28c0c8#1] root: ABORT-MARK-v3b-20261101T174208Z: …"}
{"index":9,"type":"message","timestamp":"2026-11-01T17:43:33.656Z","role":"assistant","text":"…ABORT-MARK-v3b-20261101T174208Z"}
```

时间线：

| 事件 | 时刻 | 说明 |
|---|---|---|
| 首次 deliver（水位写入） | 17:43:31.050 | 工具仍在跑，批次进了 pi 的 steer 队列 |
| `pg.abort` 投递 | 17:43:32.148 | 工具已跑 11.1 s |
| 工具的 abort 结果 + 错误助手消息 | 17:43:32.153 / .154 | pi 切断了这一轮 |
| `agent_settled(aborted:true)` | 17:43:32.155 | 该轮以 aborted 结束 |
| **新的 `agent_start` + `custom_message` 落盘** | **17:43:32.203** | abort 后 **55 ms**；requeue → 强制 flush 起了新的一轮 |
| 模型提到 marker | 17:43:33.656 | 新的一轮真的看到了它 |

注意 `adapter-watch.jsonl` 在 17:43:32.200 又出现一个 journal 条目，那是 **`pg.abort`
控制批次本身的 journal**，不是消息重投；不要把它当第二条证据。判别性的证据是
`agent_settled(aborted:true)` 之后 48 ms 的 `agent_start`，以及紧跟它的 `custom_message`。

### 负对照：同一序列，去掉 requeue

`B-negative-control-no-requeue/` 用一份只改了 `src/loop.ts` 的临时副本
（`loop.ts` sha256 `19628f46…`，删掉 `if (event.aborted === true) this.requeueLastDelivered();`），
其余完全相同：

| 事件 | 带 requeue（B） | 去掉 requeue（负对照） |
|---|---|---|
| 首次 deliver（工具运行中） | 17:43:31.050 | 17:45:09.166 |
| abort | 17:43:32.148 | 17:45:10.167 |
| abort 后 `custom_message` | **1 条（.203）** | **0 条** |
| abort 后助手提到 marker | **1 条（33.656）** | **0 条** |
| 结论 | KEPT | **LOST** |

负对照的会话文件在 `index 7`（`stopReason:"error"`）之后就没有了，marker 全文 0 次出现
（`summary.json`: `customMessages: []`, `mentions: []`）。这与
`probe/logs/steer-20261101T170244Z/e2-native-steer-platform-abort/` 的 LOST 判决一致。

**PASS。** 这条证明的不是"pi 这次没丢"，而是**适配器的 requeue 是必需的**：
同一条 pi、同一个 abort 序列，去掉它就会丢。

但这条只覆盖"一轮里只投了一个批次"。两个批次进同一轮时有一个洞，见 §7。

---

## 4. 真机：C — `pg_members` 与 `pg_schedule`

成员 `v3c-174208`；它的父是 root，兄弟有 `v3a`/`v3b`/`v3c-sibling`，
自己有一个子成员 `v3c-worker`（都由平台 API 建成，worker 用的是 v3c 自己的 token）。

### `pg_members`（无 query）

工具结果（`C-members-schedule/session.jsonl` index 7，17:43:40.982Z）：

```json
{
  "self": "m_344e7f",
  "total": 6,
  "matched": 6,
  "members": [
    { "id": "m_28c0c8", "name": "root", "parent_id": null, "parent_name": null,
      "relation": "parent", "child_count": 4, "last_seen_at": 1793555016180 },
    { "id": "m_9ab09c", "name": "v3a-20261101T174208Z", "parent_id": "m_28c0c8",
      "parent_name": "root", "relation": "sibling", "child_count": 0, "last_seen_at": 1793554995500 },
    { "id": "m_1f66a4", "name": "v3b-20261101T174208Z", "parent_id": "m_28c0c8",
      "parent_name": "root", "relation": "sibling", "child_count": 0, "last_seen_at": 1793555015972 },
    { "id": "m_344e7f", "name": "v3c-20261101T174208Z", "parent_id": "m_28c0c8",
      "parent_name": "root", "relation": "self", "child_count": 1, "last_seen_at": 1793555020980 },
    { "id": "m_b7fc60", "name": "v3c-worker-20261101T174208Z", "parent_id": "m_344e7f",
      "parent_name": "v3c-20261101T174208Z", "relation": "child", "child_count": 0, "last_seen_at": null },
    { "id": "m_28df88", "name": "v3c-sibling-20261101T174208Z", "parent_id": "m_28c0c8",
      "parent_name": "root", "relation": "sibling", "child_count": 0, "last_seen_at": null }
  ]
}
```

四种关系（self / parent / child / sibling）都在真机上出现；`child_count` 是 1（worker），
`parent_name` 是 v3c 自己的名字，`last_seen_at` 对从未鉴权过的 worker/sibling 是 `null`，
对活着并鉴权过的成员是数字——这正是"最后鉴权时间，不是存活"。

### `pg_schedule`

工具结果 17:43:42.559Z：`{"due_at":1793555032558,"pending":1}`（到点 = 17:43:52.558Z）。

```
17:44:01.475 custom_message "[scheduled] SCHED-MARK-v3c-20261101T174208Z: reply with exactly …"
17:44:02.392 assistant "SCHED-MARK-v3c-20261101T174208Z"
```

到点 → 送达 **8.917 s**（5 s 窗口 + 5 s tick 粒度），然后起了一轮并回答了 marker。
**PASS**，同时记录：`pg_schedule` 的"10 秒后"不是送达时刻（见 §6 第 3 条）。

---

## 5. 真机：D — 两个 skill 由包清单加载

用包目录本身启动（不是单个扩展文件）：

```
pi -ne -e /home/yang/Documents/pigroups-adapter -np -nc --no-mcp --session-dir … --model deepseek/deepseek-flash
```

`D-skills-banner/pane.txt` 启动 banner 原文：

```
[Skills]
  council-mode, pi-intercom, pi-subagents, pigroups-message, pigroups-org, workflow-authoring, workflow-patterns

[Extensions]
  extension.ts
```

`pigroups-org` 与 `pigroups-message` 都在；扩展列表只有包清单里的 `extension.ts`，
说明这两个 skill 走的是 `package.json` 的 `pi.skills`，不是用户目录里的同名文件
（`~/.pi/agent/skills` 不存在这两个名字）。**PASS。**

---

## 6. 与概念稿不一致的地方

按"验证中实际撞到的"排序，不改 `docs/概念稿.md`（它是规格）。

1. **§2.2 名词表现在自相矛盾。** `settle` 一行仍写着"一次 settle 只允许一次投递，
   这是适配器的规矩"，而 §8.1 明确说"没有……'一次 settle 只投一次'"。同一份文档里
   两句话互斥；术语表是 v2 的遗留。

2. **§7 的 `pg_schedule` 描述把"延迟"写成了"送达"。** 表格说"N 秒后把 note 投给我并起一轮"。
   真机 C 里 `after_seconds=10`，`due_at` 到送达是 **8.9 s 的额外延迟**（窗口 5 s + tick 5 s）。
   实现没有错（任务明确要求它不绕过窗口），错的是这句读起来像"10 秒就到"。
   工具描述已经写了"may arrive up to one window after the delay"。

3. **§7.6 的 skill 名字与交付物不一致。** §7.6 写 `pigroups-member` / `pigroups-lead`；
   §13.1 和本次任务写 `pigroups-org` / `pigroups-message`；交付的是后者。

4. **"发消息要带会话 id"在 DM 上不成立。** §7.6 的 skill 内容（以及本次任务里
   "use the conversation id from the injected prefix"）会让模型把 `dm:<a>_<b>` 传给
   `pg_say`；平台的写侧只接受 `g:<owner>` 或**裸成员 id**（平台 §3.4），`dm:` 是读侧 id。
   `skills/pigroups-message/SKILL.md` 里改用了一张"读用 `dm:`、说用对方成员 id"的表。
   这是规格本身的一处错误，不是实现取舍。

5. **§8.4 的催办没有开窗路径。** 表里写"窗口关闭，且只在没别的东西可投时"；队列为空时
   根本不存在一个可关闭的窗口，催办永远不会触发。实现用 `nudgeDue` 标记开一个只装催办的
   窗口。规格应当补一句。

6. **§8.3 ① 的"先 abort 再 say 立刻生效"没有说清机制。** "abort 立刻关窗投递"可测也实现了
   （控制测试 3 条）；但 abort 之后**新到**的 say 属于下一个窗口，除非再记一个"下一次投递
   不等窗口"的状态。实现加了 `windowImmediate`（被 `abortTurn` 置位，首次成功投递后清除），
   两条测试分别覆盖"abort 时待投的"和"abort 后才到的"。规格如果只想要前者，§8.3 那句话
   需要收窄。

7. **journal 重放要不要等窗口，规格没写。** §8.4 只给"启动简报不等窗口"开了例外；
   实现让重放批次照常等窗口（重启后最多晚 60 s）。如果"启动注入"整体都该无窗口，
   文档需要写明。

8. **"条数只能是安全阀，绝不能是触发器"没有定义溢出行为。** 实现每次投递最多 10 条，
   剩下的重开一个窗口（C 的批量上限测试）。如果"安全阀"指的是"压力大时提前 flush"，
   规格里没有这个阈值；这是一个真实的行为选择，不是实现细节。

9. **`pg_members` 的 `self` 没定义。** 契约写 `{ self, total, matched, members }`，
   但没说 `self` 是 id 还是整行。实现返回调用者的 id（该行同时以 `relation:"self"`
   出现在 `members` 里）。

10. **§7.2 仍把 `pg.steer` 当作适配器认的指令。** 工具面已删 `pg_steer`，但线上命令
    `pg.steer` 仍被接受（不再切断忙碌成员，只入队等窗口）。§7.2 的"`pg.abort` / `pg.steer`
    只认直接上级或人"因此仍然成立，只是它描述的是线上命令，不是工具——文档里这两层没有分开。

---

## 7. 变异扫描之外的洞：同一轮里第二个批次会覆盖第一个的副本

这不是变异扫描的存活项（12 个变异全部被杀），而是读代码 + 一个临时复现脚本发现的
**未被测试覆盖的行为洞**：`src/loop.ts:243` 的 `lastDelivered` 只有一个槽，
`deliverPending` 在每次成功投递时用新批次覆盖它（`src/loop.ts:534`）。

可达场景：一个工具跑得比两个窗口还久。

1. 第一批在窗口 1 关闭时 steer 进这一轮，还在 pi 的队列里；
2. 第二批在窗口 2 关闭时又 steer 进同一轮，也还在队列里；
3. abort 落地，pi 把**两条**都丢掉（2026-11-01 的测量）；
4. 适配器只 requeue `lastDelivered`——第二批。第一批的 journal 已经释放、水位已经推进，
   平台也已经取走，于是它永久消失。

复现（`extra-multibatch-loss.ts` / `extra-multibatch-loss.txt`，用测试用的真实平台 +
`FakeSurface` 驱动，不改 `src/`）：

```
deliveries after batch one: 1
deliveries after batch two: 2
deliveries after abort: 3
0 "[dm:…#1] root: batch one"
1 "[dm:…#2] root: batch two"
2 "[dm:…#2] root: batch two"     ← 第 1 批没有被重投
```

`docs/设计说明.md` §3.4 自己写的是"**每次**成功投递都留一份内存副本"，代码只留最后一份。
建议的修法（需要一条"两批进同一轮再 abort"的测试）：把 `lastDelivered` 变成
`lastDelivered: PendingDelivery[][]`（或保留所有尚未被干净结束确认的批次），
`turn_end(aborted)` 时按投递顺序全部放回队首；干净结束才整体清空。

**这一条我没有改代码**：本阶段是取证，改 `src/` 会让上面的真机证据（HEAD `8d21f37`）
失效并要求重跑；而且按仓库规矩，行为变更必须带一条先红的测试。

---

## 8. 清理

`cleanup.json` 与运行后的 `herdr pane list`：

```
wD:p1E  wD:tD  unknown  yang@yangPC:~
wE:p1   wE:t1  idle     π - PiGroups 实现 - yang
wE:p12  wE:tT  unknown  nvim docs/概念稿.md
wE:p2Q  wE:t1F unknown  nvim .
```

与运行前完全一致，`extraPanes: []`；平台 pid `378076` 已退出（`platformAlive: false`）；
`pgrep` 没有残留的 `PiGroups/src/main.ts` 或探针 pi。临时目录（平台数据、adapter 目录、
scratch、负对照的适配器副本）在收尾时删除。第一次失败的启动（herdr 不接受大写 agent 名）
留下的 tab `wE:t1R` 已单独关闭，它的半成品目录也已删除。

---

## 9. 文件索引

| 路径 | 内容 |
|---|---|
| `driver.mjs` | A/B/C/D 四个真机 case 的完整驱动 |
| `negative-control-requeue.mjs` | B 的负对照（只改 `src/loop.ts` 的 requeue） |
| `A-steer-midtool/` | `probe.jsonl`、`adapter-watch.jsonl`、`session.jsonl`、`timeline.txt`、`summary.json`、`pane.txt` |
| `B-abort-requeue/` | 同上 |
| `B-negative-control-no-requeue/` | 同上（`mutation.txt` 记录 sha256） |
| `C-members-schedule/` | 名册与预约工具结果、会话、时间线 |
| `D-skills-banner/` | 启动 banner 原文 |
| `mutation/` | 12 个补丁、`run-mutations.sh`、`results.txt` 与每次的红测试日志 |
| `extra-multibatch-loss.ts` / `.txt` | §7 的多批次丢失复现 |
| `run.log` / `commands.log` / `env.sh` / `platform.log` | 当次运行的原始记录 |
| `cleanup.json` / `final-panes.json` | 收尾检查 |
