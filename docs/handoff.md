# 交接文档

> 写于 2026-10-31，更新于 2026-11-01（补 §3.5 真机探针结果，改写 §4 / §7 / §10；同日第二轮探针把第 2 级降为部分通过，并证明第 3 级的 await；第四轮审阅的留痕见 §11）。
> 两个人（或一个人隔几天回来）之间交接用。
> 面向：接手「把 PiGroups 在 herdr + pi 上真机跑起来」这件事的人。

---

## 1. 一句话现状

**两个仓库都已建成、全绿、经过四轮独立评审和变异测试（第四轮见 §11）；三条 pi 接口假设已于 2026-11-01 在真机（pi 1.4.0 / herdr 0.9.5）上验过：第 1 级通过；第 2 级只对“配合的工具”通过（pi 不会杀一个忽略 abort signal 的工具）；第 3 级只过了 SIGTERM/tui 这一条路径，且这次用 3 s 异步体 + `process.on('exit')` 证明了处理器确实被 await。** 抓到的真偏离（`pg.abort` 之后没有 turn_end）已由 `abecc76` / `fff2418` 修掉。

下一步：**补第 3 级剩下的 `ctx.shutdown()` 自调用、print/json 模式、session 落盘**；第 4 级端到端还没碰。第 2 级的“不配合工具”是 pi 的接口边界，不要再改循环去追。

```
平台仓库  ~/Documents/PiGroups          52 tests   typecheck 干净  已定稿
适配器    ~/Documents/pigroups-adapter  59 tests   typecheck 干净  第 1 级通过 / 第 2 级部分 / 第 3 级部分
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
| 代码 | `src/` 2677 行，8 个模块（见下），**无运行时依赖**（只用 `node:*` 和 `fetch`） |
| 测试 | `test/` 2567 行，59 个测试，跑真平台（子进程）+ 假 `PiSurface` + 假 `Herdr` + 假时钟 |
| 提交 | 39 个，`master` |

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

- 59 个测试：真平台子进程 + 假 `PiSurface` + 假 `Herdr` + **注入的假时钟**（所以催办窗口和 stalled 阈值不用 sleep）
- 新补的 15 条（44 → 59）：`test/surface.test.ts` 新增 3 条（幂等门；该文件共 9 条）、
  `test/surface.abort.test.ts` 10 条（abort/isBusy/shutdown/退订/preview，含 3 s 放弃分支）、
  `test/obligation.test.ts` 新增 2 条（`nudgeOwed` 的 abort 竞态）；三组都做过撤掉源码再跑红的验证
- 变异测试 17 个，抓 12 个；存活 5 个里 3 个已被后补测试覆盖，剩 2 个（水位按成员、`flush()` 返回值）已补并有变异证明
- 本轮另做 3 个反向变异，全被抓：撤 `turnOpen` 门 → `surface.test.ts` 9 条里 2 条红；撤 `abort()` 放弃时的 warn → `surface.abort.test.ts` 1 条红；撤 `nudgeOwed` 的两处 `aborting` 检查 → `obligation.test.ts` 2 条红。恢复后全绿
- 此前的两轮独立评审：源码侧 3 blocking + 9 should-fix 全部修完；测试侧 11 条覆盖缺口补了 9 条（2 条判定为文档信息不足，明确跳过）

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

`probe/run.sh` 用 `herdr tab create --workspace <ws> --cwd <out> --env ... --no-focus` 建一个**不抢焦点**的 tab，
在 pane 里执行 `pane.sh` 起 pi：

```
pi -ne -e <abs>/probe/probe.ts --no-session --no-builtin-tools --no-mcp \
   -ns -np -nc --provider deepseek --model deepseek-flash "Reply with exactly: ready"
```

然后等 P1；等 `probe_sleep` 真进 `execute` 后 1.5 s 写 abort 文件驱动 P2；最后 `kill -TERM` 驱动
P3，检查退出码与 pane 清理。

**2026-11-01 19:20 跑了三次，产物都在 `probe/logs/`（每次一个目录：`probe.jsonl`、
`runner.txt` 全部输出、`exit_code` 是 pi 的、`run_exit_code` 是 run.sh 的）：**

| 运行 | 目录 | run.sh 退出码 | 结论 |
|---|---|---|---|
| 对照组：工具从自己的 abort 监听器返回 | `run-20261101T1920-control` | 0 | 27 PASS / 0 FAIL（P2.8 是 WARN） |
| 硬变体：`PROBE_IGNORE_SIGNAL=1`，工具忽略 abort signal | `run-20261101T1920-ignore-signal` | 1 | **P2.5、P2.7 失败**（25 PASS / 2 FAIL） |
| 负对照：故意用不存在的模型 | `run-20261101T1920-negative-control` | 1 | 9 FAIL / 16 PASS，验证 runner 会报错并留下产物 |

**P1（起一轮）—— 成立（两组都通过）。** 处理器内 `isIdle` 已是 `true`，`sendMessage` 同步返回，
新 run 是 `custom` run（A3 假通过陷阱被显式排除），全部发生在同一毫秒：

```
{"ms":506,"pid":29363,"step":"settled_1","settled":1,"aborted":false,"isIdle":true,"hasPendingMessages":false}
{"ms":506,"pid":29363,"step":"delivered","stage":"p1","idle_in_handler":true,"sendMessage_sync_ms":0}
{"ms":506,"pid":29363,"step":"before_agent_start","messageType":"custom","customType":"probe","content":"This is an automated probe. Reply with the single word pong and nothing else."}
{"ms":506,"pid":29363,"step":"turn_start","run":2,"delivery_stage":"p1","since_delivery_ms":0,"isIdle":false,"hasPendingMessages":false}
```

**P2（切断正在跑的工具）—— 只对“配合的工具”成立，第 2 级是部分通过。**
对照组里 `probe_sleep` 从自己的 signal 监听器返回：abort 后 2 ms 该 run 以 `aborted:true` 结束，
处理器内 `isIdle=true`。但硬变体（工具不理会 signal）给出的是另一条曲线：

```
{"ms":2150,"step":"tool_enter","tool":"probe_sleep","seconds":60,"signalPresent":true,"ignoreSignal":true,"isIdle":false}
{"ms":3857,"step":"abort_called","abort_sync_ms":0,"isIdle":false}
{"ms":6866,"step":"idle_timeout","wait_ms":3009,"limit_ms":3000,"isIdle":false}
{"ms":62151,"step":"tool_return","why":"timeout","ran_ms":60001,"isIdle":false}
{"ms":62153,"step":"settled_3","settled":3,"aborted":true,"isIdle":true,"hasPendingMessages":false}
```

abort 之后 3009 ms 仍不 idle，工具自己睡满 60 s 才返回，`aborted:true` 的 settle 出现在
abort 之后 **58 296 ms**。结论：**pi 把 `AbortSignal` 交给工具，但不会替你杀掉一个不理会它的工具。**
adapter 的 `abort()` 在 `ABORT_IDLE_TIMEOUT_MS = 3000` 处放弃时，那一轮还在工具里——这是接口边界，
不是循环能修的。`src/surface.ts` 的放弃分支现在会打 warn；第 2 级在 `docs/设计说明.md` 与
本文里都降为**部分通过**。`bash sleep 60` 未验（探针带 `--no-builtin-tools`）。

**18:51 那次的 P2 报 PASS 是假通过。** 那时 `probe_sleep` 从自己的 signal 监听器 resolve（日志顺序
`abort_seen → tool_return → abort_called`），`pane.sh` 又带 `--no-builtin-tools`，`bash sleep 60`
从未加载。它只证明 pi 把 `AbortSignal` 递给了工具、工具自己返回后那一轮会 settle；
不证明 pi 会切断一个不理会它的工具。现在的
对照组保留为“配合的工具”，`PROBE_IGNORE_SIGNAL=1` 的硬变体才是边界；判据也补了
`tool_enter < abort_seen < abort_called`，并把界从 20 s 收到 3000 ms（与 `ABORT_IDLE_TIMEOUT_MS` 同一个数）。

**P3（关停处理器被 await）—— 在 SIGTERM/tui 这一条路径上成立，这次是判别性的。** 处理器里的异步体从 250 ms 改成
3000 ms，并用 `process.on('exit')` 记录退出时刻：

```
{"ms":4614,"step":"shutdown_start","shutdown":1,"reason":"quit","mode":"tui","isIdle":true}
{"ms":7614,"step":"shutdown_done","shutdown":1,"at":1793532053832,"waited_ms":3000}
{"ms":7668,"step":"process_exit","code":0,"at":1793532053886,"shutdown_done_at":1793532053832,"after_shutdown_done_ms":54}
```

`waited_ms ≥ 2500` 证明 3 s 的异步体真的跑完；`process_exit` 在 `shutdown_done` 之后 54 ms 才写，
`exit 0`，SIGTERM→退出 3130 ms，只派发一次。旧的 251 ms 版本做不到这个区分：一个没被 await 的
`setTimeout` 也能让进程活过 `shutdown_done`；那次的 `exit_code` 与 runner 输出没归档，只剩一份末行是
`shutdown_done` 的 JSONL，所以它证明不了 await。19:20 的归档运行才同时有 `exit_code`、
`run_exit_code` 和 `process_exit`。**仍然没验**：`ctx.shutdown()` 自调用、print/json 模式、
session 落盘、以及 shutdown 正在跑的一轮。

**abort 后的 settle 仍能起一轮 —— 成立（对照组与硬变体都通过）。** 这是 P1 没覆盖的路径
（P1 只证明正常 settle）：`settled_3(aborted)` 的处理器里 `sendMessage` 被接受，日志出现
`delivered stage=p3` → `turn_start run=4` → `settled_4`。硬变体在工具超时、run 真正 abort 之后
也通过了这条。这条走的是探针直接调 `pi.sendMessage`，没经过 `surface.deliver`；它证明 pi 接受
这次投递，adapter 的 flush 由 FakeSurface 测试守着。

**18:51 的第一次运行**（提交 `ee9d819`，日志 `probe/logs/run-20261101T185102.jsonl`，31 行）
是 P1 的第一份证据，也第一次看到 **被 abort 的 run 不发 `agent_before_settle`**：
它给的是 `assistant_end stopReason:"error"` + `pi_turn_end outcome=error`
（`errorMessage: "This operation was aborted"`）+ `agent_settled.aborted=true`。
那次的 P3 只有 251 ms，不能证明 await；它的 P2 报 PASS 也是假通过（见上）。
上面 19:20 的运行取代了它在这两条上的证据力。
`abecc76` 因此让 `surface.ts` 在 `agent_settled.aborted === true` 时补发 `turn_end{error}`；
`fff2418` 又加了 `turnOpen` 门，避免 `before_settle` 已经关过的一轮被补第二次。
现在探针的 `P2.8` 对缺失的 `before_settle` 只打 WARN：它描述 pi 的边界，不再是 adapter 的洞。

---

## 4. 真机四级清单（2026-11-01 实测后）

**每一级只验一件事，失败就停在那级。** 一次起三个成员跑完整场景，出错时分不清是 adapter、herdr 还是模型。

| 级 | 验什么 | 失败的后果 | 通过标准 | 状态（2026-11-01） |
|---|---|---|---|---|
| **1** | 在 `agent_settled` 回调里调 `pi.sendMessage(text, {triggerTurn: true})` **能真起一轮** | 整个消息通道静默失效（最致命，所以排第一） | 探针扩展在 idle 时投一句，日志里出现一次新的 `agent_start` | **通过**。`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮（`delivered p3 → turn_start run 4`） |
| **2** | 一个卡住的工具在外部 `abort()` 后回到 idle | 卡住的成员永远收不到 `pg.abort`，回到"没人能叫停它" | `abort()` 在有界时间内 resolve，日志里那轮以 `aborted` 结束 | **部分通过**。配合的工具（从 signal 监听器返回）2 ms 结束；**忽略 signal 的工具不会被 pi 杀掉**，settle 要到 58 296 ms 后才来。证据：`run-20261101T1920-control/` 与 `run-20261101T1920-ignore-signal/` |
| **3** | `shutdown()` 后进程真退、session 落盘 | 被删成员留一个僵尸 pane | 进程 exit 0，session JSONL 有结尾 | **部分通过**。SIGTERM/tui 这条路径已用 3 s 异步体 + `process.on('exit')` 证明 await：`waited_ms=3000`，`process_exit` 在 `shutdown_done` 之后 54 ms，`exit 0`。**没调 `ctx.shutdown()` 自调用，没验 print/json 模式、session 落盘、shutdown 正在跑的一轮** |
| **4** | 端到端：根 + 2 个子成员、真模型、派活 → 汇报 → 删除 | — | 子成员收到简报、说了一句、根收到 `pg.report`，删除后两个子进程都退出 | **未验证**。一次都没跑；它验的是策略，不是接口 |

三条假设逐条对账（日期 2026-11-01，证据在 `probe/logs/run-20261101T1920-*`）：

1. **`agent_settled` 里 `sendMessage` 能起一轮 —— 已验证，接口不用改。**
   通过行（原文见 §3.5）是 `delivered`（`sendMessage_sync_ms:0`）紧跟
   `turn_start`（`run:2, delivery_stage:"p1"`），`since_delivery_ms` 0–1 ms。
   关键是这两个假通过陷阱都被排除：新 run 的 `before_agent_start` 是
   `messageType=custom, customType=probe`（不是被 `sendUserMessage` steer 进 user run），
   且 `settled_1` 里 `isIdle` 已经是 `true`（不是等空闲后才补的投递）。
   **同一个机制在 `aborted:true` 的 settle 里也成立**：`delivered stage=p3` → `turn_start run=4`，
   这是 adapter 在 `pg.abort` 之后 flush 所依赖的路径。
2. **`ctx.abort()` 能切断正在跑工具的 turn —— 只对配合的工具成立，已降为部分通过。**
   对照组（工具从自己的 signal 监听器返回）：`settled_3.aborted:true` 在 abort 后 2 ms，
   处理器里 `isIdle=true`。**但 pi 不会杀掉一个不理会 signal 的工具**：硬变体里
   `idle_timeout` 在 abort 后 3009 ms，工具自己睡满 60 s 才返回，`aborted` settle 在
   **58 296 ms** 后才出现。所以 adapter 的 `abort()` 在 3 s 处放弃是真实边界，
   不是保守值；放弃分支现在打 warn（`src/surface.ts`）。
   **pi 的另一条实际行为**：被 abort 的 run **不发 `agent_before_settle`**；它给的是
   `assistant_end stopReason:"error"` + `pi_turn_end outcome=error`
   （`errorMessage: "This operation was aborted"`）+ `agent_settled.aborted=true`。
   **接口已按实测改掉（`abecc76` + `fff2418`）。** 原先 `surface.ts` 以 `agent_before_settle`
   为 turn_end 的唯一来源，于是 `pg.abort` 之后一条 turn_end 也没有。现在
   `agent_settled.aborted === true` 也会补发一条 `turn_end{error}`，且只在
   `agent_start` 开过、`before_settle` 没关过这一轮时才补（`turnOpen`），避免一轮两个 turn_end。
   **为什么以前没测出来**：整个测试套件驱动的是 `FakeSurface`，`surface.ts` 的真实映射零测试。
   现在 `test/surface.test.ts`（9 条）与 `test/surface.abort.test.ts`（10 条）守着；
   把 `turnOpen` 门撤掉，2 条变红。
3. **`shutdown()` 干净 —— 只验证了一条路径，但这回证明了 await。**
   通过行是 `shutdown_start`（`reason:"quit", mode:"tui"`）→ `shutdown_done`
   （`waited_ms:3000`）→ `process_exit`（`after_shutdown_done_ms:54`, `code:0`），
   SIGTERM→退出 3130 ms、只派发一次。**缺的部分**：`ctx.shutdown()` 自调用、
   print/json 模式、session 落盘、以及 shutdown 正在跑的一轮；探针都没碰。
   （print 模式下 `SIGTERM` 会 `process.exit(143)`，这是读 pi 1.4.0
   `dist/modes/print-mode.js:40` 得到的，**未实测**。）`extension.ts` 的
   「先清 `loop` 再 await」与 pi 1.4.0 源码的 `await emitSessionShutdownEvent` 一致，
   这一次也没有双派发。

写修复时会想知道的三条实测细节（对照组日志）：

- **配合的工具里，顺序是 `abort_seen → tool_return → abort_called`**，不是
  …→`abort_called`→`tool_return`：`ctx.abort()` 同步触发了工具自己的 signal 监听器，
  promise 在 `abort()` 返回前就 resolve 了（`abort_sync_ms:0–1`）。所以不要去断言
  “先调用后返回”。忽略 signal 的工具里，`tool_return` 要等它自己的 60 s 计时器。
- **`tool_execution_end.isError` 是 `false`**（对照组 `durationMs:1713`，硬变体 `60001`）：
  pi 没有替换工具结果。别把 `isError=true` 当作 abort 的证据。
- **`turnIndex` 是每条 run 内部的计数**，不是全局：run 1 → 0，run 2 → 0，run 3 → 0 然后 1。
  任何拿 `turnIndex` 当全局回合号的实现都会错。

顺序与误差的说明：`abort_sync_ms:0–1`、`since_delivery_ms:0–1` 是同一毫秒级的产物，
不要读成“瞬时”；`isIdle()` 每 25 ms 采样一次，abort 文件每 100 ms 轮询一次，所以
`wait_ms` 有采样粒度。abort 后探针立刻在 settle 里投 p3 时，轮询会错过那 <25 ms 的空闲窗口，
`run.sh` 因此优先采用 settle 处理器内同步读到的 `isIdle=true`。

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
  abort 后的 settle 走同一判据（`delivered stage=p3` → `turn_start run=4`）。
- **P2**：`tool_enter` 确实出现过（工具真在 `execute` 里），`tool_enter < abort_seen < abort_called`，
  `aborted` settle 在 `PROBE_ABORT_WAIT_MS`（默认 3000）内到达。配合的工具应当场返回；
  `PROBE_IGNORE_SIGNAL=1` 的硬变体**预期失败**，它量的是 pi 的边界。
- **P3**：`shutdown_start` → `shutdown_done` 都出现、`waited_ms` 不小于异步体时长，
  且 `process_exit.after_shutdown_done_ms ≥ 0`、`exit_code` 是 0。

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
| `deliver()` 只确认"pi 收下了"，不确认"run 起来了" | 丢失窗口仍在：`pi.sendMessage` 是 void，pi 吞掉启动失败，而水位与 journal 在 `deliver()` resolve 后立刻推进（`docs/设计说明.md §3.4`）。消息会被记成已注入但那一轮没起来。本轮只把契约写准（`PiSurface` 注释、§3.4、本节都写了"收下 ≠ 起来"），没有加 ack；要收紧只能给 `PiSurface` 加"下一次 `agent_start`"的确认，属于接口设计决定 |
| `details.kind` 写了没人读 | `src/surface.ts` 把它塞进 `pi.sendMessage` 的 `details`，`test/surface.test.ts` 也断言了，但仓库里没有任何读取方。要么定为 UI 契约写进 `docs/设计说明.md`，要么删——产品决定，未做 |
| 投递排队分支没有真实样本 | 留存日志里 `hasPendingMessages` 恒为 `false`：两笔投递同时排队、以及 turn 中途再投都没观测过；`hasPendingMessages` 在 `src/` 里也一次没读。一次 settle 只投一次的规则不覆盖这个场景 |
| `ctx.shutdown()` 自调用、print/json 模式下的退出 | 未验证。外部 `SIGTERM` 的 tui 路径已证明 await（3 s 异步体、`process_exit.after_shutdown_done_ms ≥ 0`、exit 0、只派发一次）；`ctx.shutdown()` 自调用、print/json、session 落盘、shutdown 正在跑的一轮都没验。print 模式据源码是 143（未实测） |
| 一个忽略 abort signal 的工具不会被 pi 杀掉 | **未解决，接口边界**。硬变体：abort 后 3009 ms `idle_timeout`，工具自己 60 s 后返回，aborted settle 晚到 58 296 ms。adapter 的 `abort()` 3 s 后放弃并打 warn；`pg.abort` 对这类成员无法兑现“已切断”。`bash` 内置工具未验 |
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
npm run typecheck && npm test          # 59 tests，约 7.5 秒
PIGROUPS_PLATFORM_DIR=~/Documents/PiGroups   # 默认是 ../PiGroups

# 手动起一个平台
cd ~/Documents/PiGroups
PIGROUPS_ADMIN_TOKEN=adm PIGROUPS_DATA=$(mktemp -d) PORT=7717 npm run serve
```

变异测试的脚本没有留在仓库里（都在 `/tmp`）。要重做就看 `docs/设计说明.md` §10 的测试策略，以及本轮交接时列过的 17 个变异点——最值得重跑的是：`flush()` 的返回值、水位是否按成员、`gap` 是否推进水位、`stop()` 是否等待在飞投递。

---

## 9. 接手的第一件事

1. 跑一遍上面两个 `npm test`，确认 52 / 59 全绿
2. 读 `pigroups-adapter/docs/设计说明.md` §2.1（`PiSurface`）和 §2.2（`Herdr`）——那是真机验证的靶子
3. 重跑 `probe/run.sh`（对照组应 PASS）与 `PROBE_IGNORE_SIGNAL=1 probe/run.sh`（硬变体应 FAIL 在 P2.5/P2.7，这是 pi 的已知边界）
4. 补第 3 级剩下的 `ctx.shutdown()` 自调用、print/json 模式、session 落盘；`pg.abort` 的 turn_end 已修，不要再动
5. 只有 1–3 级全过，才碰第 4 级的端到端

**不要**在真机之前改循环。接口假设错了，循环改多少遍都是白改。

---

## 10. 交接清单

- [x] 两个仓库 `git status` 干净（2026-11-01：adapter 本轮 7 个提交，HEAD 见 `git log`；PiGroups `8e886ca`）
- [ ] `PiGroups`: 52/52，typecheck 干净（本轮没跑，留待确认）
- [x] `pigroups-adapter`: 59/59，typecheck 干净（2026-11-01 实测，约 7.5 s）
- [x] `grep -c 'pi-coding-agent' pigroups-adapter/src/loop.ts` = 0（实测 0）
- [x] herdr 版本记下（本机 0.9.5，`herdr --version` 2026-11-01 复核），三个旗标形状与 §3.4 一致
- [x] 第 1 级探针通过（2026-11-01，`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮）
- [ ] 第 2 级探针**部分通过**（对照组 2 ms 切断；`PROBE_IGNORE_SIGNAL=1` 的硬变体 P2.5/P2.7 失败：pi 不杀忽略 signal 的工具；`bash sleep 60` 未验）
- [ ] 第 3 级探针**部分通过**（SIGTERM/tui 已证明 await 与 exit 0；`ctx.shutdown()` 自调用、print/json 模式、session 落盘、shutdown 正在跑的一轮都未验）
- [ ] 第 4 级端到端跑通，录一份日志

---

## 11. 审阅留痕

2026-11-01 第四轮审阅，三个视角，18 条，逐条判过：

| 视角 | 它问什么 | 条数 | 判决 |
|---|---|---|---|
| 阻断 | 哪条“通过”其实不成立 | 2 | **2/2 成立**。P2 是假通过（工具从自己的 signal 监听器返回，`--no-builtin-tools` 又让 `bash sleep` 从未加载）；P3 的 251 ms 体不区分 await。现在用 `PROBE_IGNORE_SIGNAL=1` 硬变体（P2.5 在 3009 ms 记到 `idle_timeout`，P2.7 的 settle 晚到 58 296 ms）和 3 s 异步体 + `process.on('exit')`（`after_shutdown_done_ms=54`）补成真证据 |
| 应修 | 代码、测试、探针哪里不硬 | 10 | **10/10 成立，全部改完**：`turn_end` 幂等门、`nudgeOwed` 的 abort 竞态、`deliver()` 契约措辞、`surface.abort.test.ts` 10 条、P2 的界对齐 3000 ms、4 项装饰性检查改成真断言、归档正/负对照、abort 后 settle 的投递补进探针、mid-turn 投递的措辞（pi 会 steer，不是静默拒绝）、陈旧文本 |
| 备忘 | 这条指控站不站得住 | 6 | **3 条撤回**（“A 循环论证”“26 ms 可当精确值”“新 run 会让 abort 期间的 `isIdle` 为真”），**3 条留档**（`details.kind` 无用例、`hasPendingMessages` 恒为 false、第 3 级残余缺口） |

净结果：没有一条要求改接口。P2 的边界是 pi 的，不是 adapter 的；P3 的实现本来是对的，缺的是证据。每条修法都做了反向变异或真机重跑，数字在 §3.3 与 §3.5。
