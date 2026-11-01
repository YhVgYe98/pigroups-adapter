# 交接文档

> 写于 2026-10-31，更新于 2026-11-01（补 §3.5 真机探针结果，改写 §4 / §7 / §10）。
> 两个人（或一个人隔几天回来）之间交接用。
> 面向：接手「把 PiGroups 在 herdr + pi 上真机跑起来」这件事的人。

---

## 1. 一句话现状

**两个仓库都已建成、全绿、经过三轮独立评审和变异测试；三条 pi 接口假设已于 2026-11-01 在真机（pi 1.4.0 / herdr 0.9.5）上验过：第 1、2 级通过，第 3 级只过了 SIGTERM 这一条路径，并且抓到一个真偏离（`pg.abort` 之后没有 turn_end）。**

下一步是两件事：**补上那条缺失的 turn_end**（见 §4），**再补第 3 级剩下的 `ctx.shutdown()` 路径**；第 4 级端到端还没碰。

```
平台仓库  ~/Documents/PiGroups          52 tests   typecheck 干净  已定稿
适配器    ~/Documents/pigroups-adapter  38 tests   typecheck 干净  第 1–2 级真机通过
```

---

## 2. 两个仓库是什么

### 2.1 `~/Documents/PiGroups` — 平台

一个单体服务：一棵成员树、一条「每个节点拥有一个群」的规则、一个取走即消费的收件箱、一条不透明的指令通道。

| | |
|---|---|
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（实现伴稿）、`docs/参考/`（原始讨论稿） |
| 代码 | `src/` 2072 行，15 个 HTTP 端点，TypeScript + `node:sqlite`，**无运行时依赖** |
| 测试 | `test/` 2553 行，52 个黑盒 HTTP 测试 |
| 运行 | `npm run serve`（`PORT` 默认 7717，`PIGROUPS_DATA`，`PIGROUPS_ADMIN_TOKEN`） |
| 提交 | 21 个，`master` |

**它不知道 agent 是什么**：不启动、不唤醒、不判断死活、不带 UI、不提供共享文件空间。这些全部划给适配器。

### 2.2 `~/Documents/pigroups-adapter` — Pi 适配器

一个 **Pi 扩展**。装进一个 pi session，那个 session 就成为一个成员。

| | |
|---|---|
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（含 `PiSurface`、`Herdr`、循环、journal、`pg.*` 契约） |
| 代码 | `src/` 2614 行，8 个模块（见下），**无运行时依赖**（只用 `node:*` 和 `fetch`） |
| 测试 | `test/` 2062 行，38 个测试，跑真平台（子进程）+ 假 `PiSurface` + 假 `Herdr` + 假时钟 |
| 提交 | 26 个，`master` |

```
src/extension.ts   Pi 扩展入口：注册 9 个 pg_* 工具，挂 session_start / session_shutdown
src/surface.ts     PiSurface 接口 + 真实实现（pi 事件 → PiEvent 四态）
src/loop.ts        循环：拉取 → 分类 → 注入 → 义务 → 遥测（不 import pi 包）
src/herdr.ts       Herdr 接口 + herdr CLI 实现
src/pgclient.ts    平台 HTTP 客户端（只碰 15 个端点）
src/journal.ts     注入前落盘、投递后提交（按成员分）
src/watermark.ts   注入水位（按成员分，持久化）
src/state.ts       义务表、遥测表、合并窗口
```

**`loop.ts` 不许 import `@earendil-works/pi-coding-agent`。** 这是整个仓库可测的唯一来源。改坏了这一条，测试就退化成"跑一遍真模型看看"。

9 个工具：`pg_say` `pg_read` `pg_spawn` `pg_terminate` `pg_whoami` `pg_abort` `pg_steer` `pg_inspect` `pg_children`。

---

## 3. 已经验证了什么（证据级别）

不是"跑通了"，是按证据强度排序：

### 3.1 三层验证，每层都发现上一层漏掉的东西

| 层 | 手段 | 实际发现 |
|---|---|---|
| 写 | 两个写手隔离并行（一个只碰 `src/`，一个只碰 `test/`，互不看对方目录） | 一次全绿 |
| 审 | 两个 reviewer 分开验收（各自只看一半） | 平台：0 blocking 但 12 处真偏离；适配器：**3 条 blocking** |
| 变异 | 往副本里注入"貌似对但错"的实现 | 平台 16/16 全抓；适配器 12/17，剩下 2 个真洞已补 |

**只做前两层会以为做完了。** 适配器那一轮三条 blocking 全是变异和评审交叉出来的：
- journal 按目录存、水位按成员存 → 子成员会重放父的批次并删掉父的那份
- `gap` 的回补锚点被当成已注入序号 → 下一条真消息被永久丢弃
- `stop()` 在投递未完成时就返回

### 3.2 平台侧的具体数字

- 52 个黑盒测试，覆盖 15 个端点的全部承诺
- 变异测试 16 个错误实现，**全部被抓**（含幂等查表顺序、名字唯一索引是否为 partial）
- 我自己另写了 17 + 24 + 10 项探针，独立复核过越权路径（成员带 `all=true` 的 8 种写法全部 403）

### 3.3 适配器侧的具体数字

- 38 个测试：真平台子进程 + 假 `PiSurface` + 假 `Herdr` + **注入的假时钟**（所以催办窗口和 stalled 阈值不用 sleep）
- 变异测试 17 个，抓 12 个；存活 5 个里 3 个已被后补测试覆盖，剩 2 个（水位按成员、`flush()` 返回值）已补并有变异证明
- 两轮独立评审：源码侧 3 blocking + 9 should-fix 全部修完；测试侧 11 条覆盖缺口补了 9 条（2 条判定为文档信息不足，明确跳过）

### 3.4 herdr CLI（零成本，已对实机帮助核过）

`herdr 0.9.5`：

| 事实 | 内容 |
|---|---|
| 环境变量 | **`herdr pane split --env K=V`**（"Set an environment variable for the launched process"）。`agent start` **没有** `--env` |
| 等待旗标 | **`--until`**（`idle / working / blocked / done / unknown`），不是 `--state`。**不给 `--timeout` 会无限等** |
| 启动前提 | 目标 pane 必须在**交互式 shell 提示符**上——先起 pane，再 `agent start` |

这三条之前文档是猜的（写错了），代码是对的，已按实机帮助重写 `docs/设计说明.md` §2.2。

### 3.5 真机探针（2026-11-01，pi 1.4.0 / herdr 0.9.5 / node v26.12.1 / deepseek-flash）

**这是新的一层证据，不替代上面三层。** 上面三层证明「代码与它自己的假设一致」；这一层证明**假设本身**在真 pi 上成立。

跑的是一条命令（`probe/run.sh`，未改动）：

```bash
/home/yang/Documents/pigroups-adapter/probe/run.sh
```

它用 `herdr tab create --workspace <ws> --cwd <out> --env ... --no-focus` 建一个**不抢焦点**的 tab
（本次 `wE:tH` / pane `wE:pK`），在 pane 里执行 `pane.sh` 起 pi，命令行是：

```
pi -ne -e <abs>/probe/probe.ts --no-session --no-builtin-tools --no-mcp \
   -ns -np -nc --provider deepseek --model deepseek-flash "Reply with exactly: ready"
```

然后等 P1；等 `probe_sleep` 真进 `execute` 后 1.5 s 写 abort 文件驱动 P2；最后 `kill -TERM`
驱动 P3，检查退出码与 pane 清理。`run.sh` 退出码 `0`，打印 `RESULT: PASS`。

**产物**：`probe/logs/run-20261101T185102.jsonl`（31 行，提交 `ee9d819`）。
同一配置另外还跑过两次完整运行和一次故意的失败运行，结论一致。

**P1（起一轮）—— 成立。** 处理器内 `isIdle` 已是 `true`，`sendMessage` 同步返回，
新 run 是 `custom` run（A3 假通过陷阱被显式排除），全部发生在同一毫秒 831：

```
{"ms":831,"pid":10573,"step":"settled_1","settled":1,"aborted":false,"isIdle":true,"hasPendingMessages":false}
{"ms":831,"pid":10573,"step":"delivered","stage":"p1","idle_in_handler":true,"sendMessage_sync_ms":0}
{"ms":831,"pid":10573,"step":"before_agent_start","messageType":"custom","customType":"probe","content":"This is an automated probe. Reply with the single word pong and nothing else."}
{"ms":831,"pid":10573,"step":"turn_start","run":2,"delivery_stage":"p1","since_delivery_ms":0,"isIdle":false,"hasPendingMessages":false}
```

**P2（切断正在跑的工具）—— 成立。** 工具确实在 `execute` 里（`signalPresent:true`），
跑了 1704 ms 后被外部 abort 打断，`isIdle()` 26 ms 后为 `true`，该 run `aborted:true`：

```
{"ms":2390,"pid":10573,"step":"tool_enter","tool":"probe_sleep","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","seconds":60,"signalPresent":true,"isIdle":false}
{"ms":4094,"pid":10573,"step":"abort_seen","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","waited_ms":1704,"isIdle":false}
{"ms":4095,"pid":10573,"step":"abort_called","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","abort_sync_ms":1,"abortError":null,"isIdle":false,"hasPendingMessages":false}
{"ms":4097,"pid":10573,"step":"settled_3","settled":3,"aborted":true,"isIdle":true,"hasPendingMessages":false}
{"ms":4120,"pid":10573,"step":"idle","wait_ms":26,"toolReturned":true}
```

**P3（关停处理器被 await）—— 成立，但只在这条路径上。** `kill -TERM` →
`session_shutdown(reason=quit)` → 处理器 251 ms 后结束 → `exit 0`，全程 357 ms，只派发一次：

```
{"ms":4349,"pid":10573,"step":"shutdown_start","shutdown":1,"reason":"quit","targetSessionFile":null,"mode":"tui","isIdle":true}
{"ms":4600,"pid":10573,"step":"shutdown_done","shutdown":1,"waited_ms":251}
```

收尾核对：`pane.sh` 写进 `exit_code` 的是 `0`；探针 tab/pane 已消失，pane 列表与运行前
基线逐字节一致（`wE:pB`、`wE:p1`），`pane current --current` 仍是 `wE:p1 focused=true`，
探针 pid 10573 不在了。

**这一层抓到的唯一真偏离：被 abort 的 run 不发 `agent_before_settle`。** 日志里 P2 那条 run
没有任何 `before_settle`，只有一条 `stopReason:"error"` 的 assistant 消息和一个 `outcome=error`
的 `turn_end`：

```
{"ms":4096,"pid":10573,"step":"assistant_end","stopReason":"error","text":""}
{"ms":4096,"pid":10573,"step":"turn_end","turnIndex":1,"outcome":"error","role":"assistant","stopReason":"error","errorMessage":"This operation was aborted"}
```

适配器把 `agent_before_settle` 当作 turn_end 的唯一来源（`src/surface.ts:129-134`），
所以 **`pg.abort` 之后一条 turn_end 也不会发出**。`run.sh` 的 `P2.8` 把它打成 WARN，不判失败。
结论与待办见 §4、§7。

---

## 4. 真机四级清单（2026-11-01 实测后）

**每一级只验一件事，失败就停在那级。** 一次起三个成员跑完整场景，出错时分不清是 adapter、herdr 还是模型。

| 级 | 验什么 | 失败的后果 | 通过标准 | 状态（2026-11-01） |
|---|---|---|---|---|
| **1** | 在 `agent_settled` 回调里调 `pi.sendMessage(text, {triggerTurn: true})` **能真起一轮** | 整个消息通道静默失效（最致命，所以排第一） | 探针扩展在 idle 时投一句，日志里出现一次新的 `agent_start` | **通过**。`probe/run.sh` → `probe/logs/run-20261101T185102.jsonl` |
| **2** | 一个 `bash sleep 60` 卡住时，外部 `abort()` 能切断并回到 idle | 卡住的成员永远收不到 `pg.abort`，回到"没人能叫停它" | `abort()` 在几秒内 resolve，日志里那轮以 `aborted` 结束 | **通过（工具是探针自己的 `probe_sleep`，不是 `bash`）**。同一日志 |
| **3** | `shutdown()` 后进程真退、session 落盘 | 被删成员留一个僵尸 pane | 进程 exit 0，session JSONL 有结尾 | **部分通过**。同一日志：`exit 0`、SIGTERM→退出 357 ms、处理器被 await。**没调 `ctx.shutdown()` 自调用，也没验 session 落盘**（`--no-session` + 外部 SIGTERM） |
| **4** | 端到端：根 + 2 个子成员、真模型、派活 → 汇报 → 删除 | — | 子成员收到简报、说了一句、根收到 `pg.report`，删除后两个子进程都退出 | **未验证**。一次都没跑；它验的是策略，不是接口 |

三条假设逐条对账（日期 2026-11-01，证据路径 `probe/logs/run-20261101T185102.jsonl`）：

1. **`agent_settled` 里 `sendMessage` 能起一轮 —— 已验证，接口不用改。**
   通过行（原文见 §3.5）是 `delivered`（`sendMessage_sync_ms:0`）紧跟
   `turn_start`（`run:2, delivery_stage:"p1"`），两者都在 ms 831。
   关键是这两个假通过陷阱都被排除：新 run 的 `before_agent_start` 是
   `messageType=custom, customType=probe`（不是被 `sendUserMessage` steer 进 user run），
   且 `settled_1` 里 `isIdle` 已经是 `true`（不是等空闲后才补的投递）。
2. **`ctx.abort()` 能切断正在跑工具的 turn —— 已验证，附带的偏离已修复。**
   通过行是 `{"ms":4120,"step":"idle","wait_ms":26,"toolReturned":true}` 与
   `settled_3` 的 `aborted:true`（`wait_ms` 上限 20 000，
   adapter 自己的上限 `ABORT_IDLE_TIMEOUT_MS` = 3 000，两者都远未触及）。
   **pi 实际行为**：被 abort 的 run **不发 `agent_before_settle`**；它给的是
   `assistant_end stopReason:"error"` + `turn_end outcome=error`
   （`errorMessage: "This operation was aborted"`）+ `agent_settled.aborted=true`。
   **接口已按实测改掉（`abecc76`）。** 原先 `surface.ts` 以 `agent_before_settle` 为 turn_end 的唯一来源，
   于是 `pg.abort` 之后一条 turn_end 也没有：`turnStartedAt` 不清零、`errorNote` 不设、
   上级永远不知道那一轮被切断。现在 `agent_settled.aborted === true` 也会补发一条
   `turn_end{error}`。`PiSurface` 接口没动。
   更值得记的是**为什么以前没测出来**：整个测试套件驱动的是 `FakeSurface`，
   `surface.ts` 里这段真实的 pi 事件映射**一条测试都没有**。补了 `test/surface.test.ts`
   （6 条），并且验证过：把修复撤掉，2 条变红。
3. **`shutdown()` 干净 —— 只验证了一条路径。** 通过行是 `shutdown_start`
   （`reason:"quit", mode:"tui"`）→ `shutdown_done`（`waited_ms:251`），
   退出码 `0`、只派发一次。
   **缺的部分**：`ctx.shutdown()` 自调用、print/json 模式、以及 session 落盘；探针三条都没碰。
   （print 模式下 `SIGTERM` 会 `process.exit(143)`，这是读 pi 1.4.0
   `dist/modes/print-mode.js:40` 得到的，**未实测**。）`extension.ts:42-48` 的
   「先清 `loop` 再 await」顺序本身是对的，且这一次没有双派发。

写修复时会想知道的三条实测细节（都在同一份日志里）：

- **顺序是 `abort_seen → tool_return → abort_called`**，不是 …→`abort_called`→`tool_return`：
  `ctx.abort()` 同步触发了工具自己的 signal 监听器，promise 在 `abort()` 返回前就 resolve 了
  （`abort_sync_ms:1`）。所以不要去断言“先调用后返回”。
- **`tool_execution_end.isError` 是 `false`**（`durationMs:1705`）：pi 没有替换工具结果，
  因为工具在同一个 tick 里自己 resolve 了。别把 `isError=true` 当作 abort 的证据。
- **`turnIndex` 是每条 run 内部的计数**，不是全局：run 1 → 0，run 2 → 0，run 3 → 0 然后 1。
  任何拿 `turnIndex` 当全局回合号的实现都会错。

顺序与误差的说明：`wait_ms:26`、`abort_sync_ms:1`、`since_delivery_ms:0` 里含采样量子
（`isIdle` 每 25 ms 一采、abort 文件每 100 ms 轮询一次），是同一毫秒级的产物，
不要读成“瞬时”。

**第 1–3 级只需要一个探针扩展**，与 PiGroups 无关：它只依赖 `pi.sendMessage`、会话 abort、`ctx.shutdown` 和事件订阅。验的是**接口假设**，不是业务逻辑。

这正对应 `docs/设计说明.md` §2.1 那句话：

> 验不过就回来改**接口**，不要改循环。

第 4 级才烧 token，验的是**策略**（催办阈值、合并窗口、相关性分级），不是接口。

### 探针已经写好并跑过了

`probe/` 目录就是这条清单第 1–3 级的常驻工具，`probe/README.md` 是它的说明书：

```bash
/home/yang/Documents/pigroups-adapter/probe/run.sh   # 0 = 全过，1 = 有失败，2 = 环境问题
```

它只用 pi 扩展 API、不 import 仓库 `src/`，所以 adapter 重写后照样有效。判据仍然是：

- **P1**：`delivered` 之后紧跟一次 `turn_start`，且那次 run 的 `before_agent_start` 是
  `messageType=custom` + 自己的 `customType`。**只看这一条**——`sendUserMessage` 也能让新 run
  起来，只有 `custom` 才证明是 `sendMessage(..., {triggerTurn:true})` 起的。
- **P2**：`tool_enter` 确实出现过（工具真在 `execute` 里），`idle` 的 `wait_ms` 有界，
  该 run 以 `settled_N aborted:true` 结束。
- **P3**：`shutdown_start` → `shutdown_done` 都出现，且 `exit_code` 是 0。

失败的样子也要认得：模型没调工具时日志里只有 `settled_3` 没有 `tool_start`，
`run.sh` 会说 P2 无法判定，而不是“通过”。

---

## 5. 关键设计决定索引（要改之前先看这里）

| 决定 | 为什么 | 在哪 |
|---|---|---|
| 群是树的纯函数，群不建表 | 可见性一次查表，无授权残留 | 概念稿 §4.2 |
| 没有权限系统，只有结构后果 | 有权限就要回答"谁授予/谁收回/过期怎么办" | 概念稿 §4.3 |
| 名册对所有人可见，群聊只对父+子 | 结构与会话分离 | 概念稿 §4.4 |
| 消息按会话编号，不暴露全局序号 | 全局号泄漏"我看不到的会话有多少流量" | 设计稿 §3.4 |
| `poll` 取走即消费，不分离 fetch/ack | 简单；代价是 adapter 必须自己做 journal | 设计稿 §6.1 |
| 一次 settle 只投一次，**flush 在前、nudge 只在其没投时才跑** | 反了会饿死队列（催办占满投递通道，新消息永远送不到） | 设计稿 §2.3 不变量 2 |
| 催办合并成一次投递 | 一次 settle 一次投递；醒一次就该看到全部欠账 | 设计稿 §4.3 |
| 注入水位与 journal 都**按成员**分 | 父与子共用 `PIGROUPS_ADAPTER_DIR`，`dm:<a>_<b>` 两端同一个字符串 | 设计稿 §3.1 §3.4 |
| `gap` 不推进水位 | 它的锚点 `before` 可能正好是下一条真消息的 seq | 设计稿 §3.4 |
| 阻塞回合到成员开口才结束 | 否则父每问一句就收到一串重复 `blocked` | 设计稿 §4.3 |
| 遥测边沿触发、只向上一级 | 周期上报会淹上级；跨层要逐级转达 | 概念稿 §6 |
| 不做心跳 | 能打心跳的适配器就能直接报告退出 | 概念稿 §4.5 |
| 没有 yes/no 相关性门控 | 平台的 `mentions_me` / `from_parent` 已经够用；门控在小队里净亏 | 概念稿 §7 |
| 不做命令拦截 | 不属于这个插件 | 概念稿 §7 |
| 人的 API 与成员同一套 | 独立通道 = 把 UI 职责搬进平台 | 概念稿 §6 |
| 人能读全部指令（`all=true`） | 否则"上级到底命令了什么"无从追查 | 设计稿 §7.3 |

---

## 6. 工作规矩（这两条踩过坑）

**① 隔离是硬规矩。** 写 `src/` 的不许读 `test/`，写 `test/` 的不许读 `src/`。这不是洁癖——测试写手曾找到一个"只有读过实现才写得出来"的诱惑，靠隔离挡住了。**但查 bug 的时候相反**：我这轮三次亲自下场读两边，因为"同一段文本在时序里出现两次"这种证据只有同时看两边才拿得准。**隔离是给"写"用的，不是给"查"用的。**

**② 提交只 `git add` 自己拥有的路径。** 我曾经用 `git add -A` 把测试写手正在写的 1133 行卷进了自己的 docs commit。两个仓库都设了 `commit.gpgsign=false`，提交一律写 `git commit --no-gpg-sign`。

---

## 7. 已知的开放风险

| 风险 | 状态 |
|---|---|
| ~~`pg.abort` 之后没有 turn_end~~ | **已修（`abecc76`）**：`agent_settled.aborted === true` 时补发 `turn_end{error}`（`fff2418` 起只在没有 `before_settle` 关过这一轮时补，避免一轮两个 `turn_end`），`test/surface.test.ts` 守着。但**`surface.ts` 的 pi 事件映射整体此前零测试**，是这次才发现的盲区——以后改这个文件，先看那个测试文件 |
| `deliver()` 只确认"pi 收下了"，不确认"run 起来了" | 丢失窗口：`pi.sendMessage` 是 void，pi 吞掉启动失败，而水位与 journal 在 `deliver()` resolve 后立刻推进（`docs/设计说明.md §3.4`）。消息会被记成已注入但那一轮没起来。要收紧只能给 `PiSurface` 加"下一次 `agent_start`"的确认，属于接口设计决定，未做 |
| `ctx.shutdown()` 自调用、print/json 模式下的退出 | 未验证。只验了外部 `SIGTERM` 的 tui 路径（exit 0、处理器被 await、只派发一次）；print 模式据源码是 143（未实测） |
| `herdr agent start` 在真实 pane 里的行为 | 命令行形状已核，**行为未验**；探针是在 pane 里直接跑 `bash pane.sh` 起 pi，没走 `agent start` |
| 消息与 inbox 都没有清理策略 | 已知，无上限增长。规模上来再定 |
| 催办三级的阈值（5 分钟窗口 / 3 次上限 / 30 分钟持续） | 全是拍的数字，需要真实负载校准 |
| `at-most-once`（取走即消费）的丢失代价 | 用 journal 缓解，但没有实测过崩溃频率下的影响 |
| 相关性分级（`mentions_me` / `from_parent`）在真实群里够不够 | 未验证。若不够，才考虑启用门控 |
| 同一个 cwd 的两个成员会互相覆盖文件 | 平台没有文件空间；靠 spawn 时指定 cwd 约束 |

---

## 8. 怎么重跑一切

```bash
# 平台
cd ~/Documents/PiGroups
npm run typecheck && npm test          # 52 tests，约 2 秒

# 适配器（会自己拉起一个平台子进程）
cd ~/Documents/pigroups-adapter
npm run typecheck && npm test          # 38 tests，约 5 秒
PIGROUPS_PLATFORM_DIR=~/Documents/PiGroups   # 默认是 ../PiGroups

# 手动起一个平台
cd ~/Documents/PiGroups
PIGROUPS_ADMIN_TOKEN=adm PIGROUPS_DATA=$(mktemp -d) PORT=7717 npm run serve
```

变异测试的脚本没有留在仓库里（都在 `/tmp`）。要重做就看 `docs/设计说明.md` §10 的测试策略，以及本轮交接时列过的 17 个变异点——最值得重跑的是：`flush()` 的返回值、水位是否按成员、`gap` 是否推进水位、`stop()` 是否等待在飞投递。

---

## 9. 接手的第一件事

1. 跑一遍上面两个 `npm test`，确认 52 / 38 全绿
2. 读 `pigroups-adapter/docs/设计说明.md` §2.1（`PiSurface`）和 §2.2（`Herdr`）——那是真机验证的靶子
3. 重跑 `probe/run.sh`，确认第 1–2 级仍然 PASS（一条命令，十秒级）
4. 先补 §4 里那条 `pg.abort` 没有 turn_end 的洞，再补第 3 级剩下的 `ctx.shutdown()` 路径
5. 只有 1–3 级全过，才碰第 4 级的端到端

**不要**在真机之前改循环。接口假设错了，循环改多少遍都是白改。

---

## 10. 交接清单

- [x] 两个仓库 `git status` 干净（2026-11-01：adapter `ee9d819`，PiGroups `8e886ca`）
- [ ] `PiGroups`: 52/52，typecheck 干净（本轮没跑，留待确认）
- [x] `pigroups-adapter`: 38/38，typecheck 干净（2026-11-01 实测，7.5 s）
- [x] `grep -c 'pi-coding-agent' pigroups-adapter/src/loop.ts` = 0（实测 0）
- [x] herdr 版本记下（本机 0.9.5，`herdr --version` 2026-11-01 复核），三个旗标形状与 §3.4 一致
- [x] 第 1 级探针通过（2026-11-01，`probe/logs/run-20261101T185102.jsonl`）
- [x] 第 2 级探针通过（同上；探的是自定义工具 `probe_sleep`，不是 `bash sleep 60`）
- [ ] 第 3 级探针通过（只过了 SIGTERM/tui 一条路径；`ctx.shutdown()`、print/json 模式、session 落盘都未验）
- [ ] 第 4 级端到端跑通，录一份日志
