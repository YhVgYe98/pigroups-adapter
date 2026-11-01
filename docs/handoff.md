# 交接文档

> 写于 2026-10-31，更新于 2026-11-01（补 §3.5 真机探针结果、§3.6 第 4 级端到端，改写 §2 / §4 / §7 / §10，补 §8 的版本与发版；同日第二轮探针把第 2 级降为部分通过，并证明第 3 级的 await；第 4 级主链路已在真机上跑通，整级仍是**部分通过**：只跑了 1 个子成员，且判据事后改过两次——两处都在 `de48904` 里，**不在**记录那次 run 的 `3919467` 里，§3.6 原先记错了，本版改正。第四、五轮留痕见 §11，第五轮审阅后的修复见 §12）。
>
> 两个人（或一个人隔几天回来）之间交接用。
> 面向：接手「把 PiGroups 在 herdr + pi 上真机跑起来」这件事的人。
>
> **本文档描述的是 `v0.2.0` 这一对**：平台与适配器都是 `0.2.0`，各有一个未签名的 annotated 标签指向写作时的 HEAD。号住在哪、怎么发下一版、以及本轮实测到的问题，见 §8。

---

## 1. 一句话现状

**两个仓库都已建成、全绿、经过五轮独立评审和变异测试（第四、五轮留痕见 §11，第五轮修复见 §12）；三条 pi 接口假设已于 2026-11-01 在真机（pi 1.4.0 / herdr 0.9.5）上验过：第 1 级通过；第 2 级只对“配合的工具”通过（pi 不会杀一个忽略 abort signal 的工具）；第 3 级只过了 SIGTERM/tui 这一条路径，且这次用 3 s 异步体 + `process.on('exit')` 证明了处理器确实被 await；第 4 级端到端主链路通过（整级仍是部分通过，理由见 §3.6）。** 抓到的真偏离（`pg.abort` 之后没有 turn_end）已由 `abecc76` / `fff2418` 修掉。

**第 4 级不是“全过”，状态统一为“部分通过”。** 第一次真机 run 抓出两处：模型侧没有 `pg_report` 工具（只有 9 个工具，规范也只列了 9 个），以及删除后子 pane 没人关。后者已由 `9453f6d` 修掉并在真机复跑确认；前者是产品缺口，但**不是**第 4 级的判据——那次 run 的判据被改过两次（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说了一句话），两处都在事后单独的 `de48904` 里，**不在**记录那次 run 的 `3919467` 里（`3919467` 连判据那一行都没动，§3.6 原先把它记成“记录 run 的同一个提交”，本版改正）。整级仍是部分通过，因为只跑了 1 个子成员，判据也是事后改的。详见 §3.6 与 §4。

下一步：**先把 `pg_report` 定为“加第 10 个工具”还是保持“汇报=说话”**（它不再是第 4 级的判据，但仍是产品缺口）；补第 3 级剩下的 `ctx.shutdown()` 自调用、print/json 模式、session 落盘；再把第 4 级从 1 个子成员扩到 2 个并验重启/级联。第 2 级的“不配合工具”是 pi 的接口边界，不要再改循环去追。

```
平台仓库  ~/Documents/PiGroups          0.2.0  v0.2.0  56 tests   typecheck 干净  已定稿
适配器    ~/Documents/pigroups-adapter  0.2.0  v0.2.0  78 tests   typecheck 干净  第 1 级通过 / 第 2、3、4 级部分通过
```

两个仓库必须是同一个号，`v0.2.0` 标签记录这一对；本文档描述的就是它。号住在哪、怎么发下一版见 §8。

---

## 2. 两个仓库是什么

### 2.1 `~/Documents/PiGroups` — 平台

一个单体服务：一棵成员树、一条「每个节点拥有一个群」的规则、一个取走即消费的收件箱、一条不透明的指令通道。

| | |
|---|---|
| 版本 | `0.2.0`，标签 `v0.2.0`（annotated、未签名）。`package.json` 是唯一真值：`src/version.ts` 直接 import 它，`GET /v1/health` 与每个响应的 `server_version` 都报这个数，没有第二个常量 |
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（实现伴稿）、`docs/参考/`（原始讨论稿） |
| 代码 | `src/` 2105 行，15 个 HTTP 端点，TypeScript + `node:sqlite`；运行时依赖 `hono`、`@hono/node-server`、`zod` |
| 测试 | `test/` 2681 行，56 个黑盒 HTTP 测试 |
| 运行 | `npm run serve`（`PORT` 默认 7717，`PIGROUPS_DATA`，`PIGROUPS_ADMIN_TOKEN`） |
| 提交 | `master`（数量见 `git log`） |

**它不知道 agent 是什么**：不启动、不唤醒、不判断死活、不带 UI、不提供共享文件空间。这些全部划给适配器。

### 2.2 `~/Documents/pigroups-adapter` — Pi 适配器

一个 **Pi 扩展**。装进一个 pi session，那个 session 就成为一个成员。

| | |
|---|---|
| 版本 | `0.2.0`，标签 `v0.2.0`（annotated、未签名）。`src/version.ts` 的 `ADAPTER_VERSION` 与 `package.json`、lockfile 三处必须相等（`test/version.test.ts` 会红）；`pg_whoami` 的 `adapter_version` 与启动那一行日志都报它 |
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（含 `PiSurface`、`Herdr`、循环、journal、`pg.*` 契约） |
| 代码 | `src/` 2995 行，8 个模块（见下），**无运行时依赖**（只用 `node:*` 和 `fetch`） |
| 测试 | `test/` 3249 行，78 个测试，跑真平台（子进程）+ 假 `PiSurface` + 假 `Herdr` + 假时钟 |
| 提交 | `master`（数量见 `git log`） |

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

### 2.3 接线前提：`PIGROUPS_SPAWN_CMD` 必须带 `-e <extension>`

子成员不是平台创建的，是适配器的 `HerdrCli` 在 pane 里起一个 pi。它执行的就是
`PIGROUPS_SPAWN_CMD`；如果这个值只是 `pi`，`pg_spawn` 仍会建成员、开 pane，但子 pi
没有加载适配器，于是不轮询、不收简报、也没有任何 `pg_*` 工具——表面“spawn 成功”，
实际不是成员。**这是第一次接线最容易错的地方。**

环境变量只能放在 `herdr pane split --env` 上（`agent start` 没有 `--env`）。子成员通过
pane 继承同一组变量，所以它的孙子也走同一个 `PIGROUPS_SPAWN_CMD`。可运行的最小形状：

```bash
ADAPTER=/home/yang/Documents/pigroups-adapter
MODEL=deepseek/deepseek-flash
SPAWN_CMD="pi -ne -e $ADAPTER/src/extension.ts --model $MODEL"

PANE=$(herdr pane split --direction down --no-focus --cwd "$SCRATCH" \
  --env PIGROUPS_URL="$PIGROUPS_URL" \
  --env PIGROUPS_TOKEN="$ROOT_TOKEN" \
  --env PIGROUPS_ADAPTER_DIR="$ADIR" \
  --env "PIGROUPS_SPAWN_CMD=$SPAWN_CMD" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')

herdr agent start root --kind pi --pane "$PANE" --timeout 60000 \
  -- -ne -e "$ADAPTER/src/extension.ts" --model "$MODEL"
```

`$PIGROUPS_URL` / `$ROOT_TOKEN` / `$ADIR` / `$SCRATCH` 由 §8 那套启动与 bootstrap 得到；
完整的一键块见 `probe/README.md` 第 4 级。

`-ne` 是给真机探针用的：不继承用户的全局扩展，只加载 `-e` 指定的适配器（第一次第 4 级
跑没加，root 通过 `pi-intercom` 把一条消息转进了用户的主会话，见 §3.6）。生产里可以去掉
`-ne`，但 `PIGROUPS_SPAWN_CMD` 里的 `-e .../src/extension.ts` 不能少。

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

- 56 个黑盒测试，覆盖 15 个端点的全部承诺
- 变异测试 16 个错误实现，**全部被抓**（含幂等查表顺序、名字唯一索引是否为 partial）
- 我自己另写了 17 + 24 + 10 项探针，独立复核过越权路径（成员带 `all=true` 的 8 种写法全部 403）

### 3.3 适配器侧的具体数字

- 78 个测试：真平台子进程 + 假 `PiSurface` + 假 `Herdr` + **注入的假时钟**（所以催办窗口和 stalled 阈值不用 sleep）
- 新补的 15 条（44 → 59，之后又补 3 条到 62）：`test/surface.test.ts` 新增 3 条（幂等门；该文件共 9 条）、
  `test/surface.abort.test.ts` 10 条（abort/isBusy/shutdown/退订/preview，含 3 s 放弃分支）、
  `test/obligation.test.ts` 新增 2 条（`nudgeOwed` 的 abort 竞态）；三组都做过撤掉源码再跑红的验证
- 第五轮再补 13 条到 75（`obligation` 7、`herdr` 2、`tools` 2、`delivery` 1、`stop` 1），清单与变异证明见 §12
- 版本工作再补 3 条到 78（`test/version.test.ts`：常量与 `package.json`/lockfile 一致、`pg_whoami` 报 `adapter_version`、启动日志那一行）
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

### 3.6 第 4 级端到端（2026-11-01，两次真机运行）

**结论：主链路通过，第 4 级整级是“部分通过”。** 第一次 run 暴露问题
（提交 `191c52d`，证据 `probe/logs/level4-20261101T193132/`）；第二次只复跑失败点
（提交 `9453f6d`，证据 `probe/logs/level4-fix-20261101T193945/`）。环境：pi 1.4.0 /
herdr 0.9.5 / deepseek-flash，一次性平台与临时数据目录。第一次用 1 个根 + 1 个子成员，
不是清单写的 2 个。

**判据改动记录（两处，都是“先改判据、后按新判据算通过”，所以整级不能算全过）：**

1. “**2 个子成员**”被改成“子成员”。实际只起了 1 个。这不是把结果改到判据上——它就是判据被
   降了一档；要按原清单算通过，还得补第二个子成员。**两处判据改动都在 `de48904`，不在记录
   这次 run 的 `3919467` 里**：`3919467` 只把这一行从“未验证”写成“部分通过”，判据仍原样写着
   “根 + 2 个子成员”与“根收到 `pg.report`”。本节原先把 `3919467` 记成改判据的那个提交，已改正；
   `probe/README.md` 里是同一个错，本次没改（只提交本文档）。
2. `de48904` 把“根收到模型主动发的 `pg.report`”改成“子成员说了一句话（`pg_say`）”。这条改动
   有事实依据：模型侧根本没有 `pg_report` 工具（`searchTools("pg")` 只找到 9 个），而子成员
   确实说了话（`transcripts/alpha.md` 11:32:32.951 → `pg_say` → `{"conv":"g:m_d1becc","seq":1}`）。
   原来那条判据是写判据的人写错了，不是 run 失败；但判据是在结果出来之后改的，所以要写明，
   不能当成“预注册判据下通过”。

因此：**判据不再要求 `pg.report`**（`pg.report` 只是适配器自己在 blocked/exiting 时发的控制项，
是产品缺口，见 §7），**但整级只能记“部分通过”**——只跑了 1 个子成员，且判据在记录 run 的同一
个提交里改过。§1、本节的表格与结论、§4、§7、§9、§10、`probe/README.md` 都写这一个状态。

**第二次 run 的树**：它在 19:39:45–19:40 跑，`9453f6d` 于 19:41:10 提交，所以 run.log 里没有
哈希。事后核对：跑的树就是成为 `9453f6d` 的那棵树，`git show 9453f6d:src/loop.ts | sha256sum`
= `2322bccf870c2ceb669dac1059a79fec91958c5d24b81bd5d76fb1ea92300857`。记录在
`level4-fix-20261101T193945/tree.txt`，驱动命令（事后从证据文件与 root pane 重建）在
`level4-fix-20261101T193945/commands.md`。

| 观察 | 证据 |
|---|---|
| 根按人的方式启动：`herdr pane split` → `herdr agent start root` 返回 `interactive_ready:true`；3 s 内 `GET /v1/members/<root>` 的 `last_seen_at` 前进，说明适配器循环在轮询 | `level4-.../agent-start-root.json`、`journal.md` §1.5 |
| `pg_spawn` 同时建成员和 pane：root transcript 里 `pg_spawn {"name":"alpha",…}` → `{"id":"m_635f7e","name":"alpha"}`，herdr 新增 `wE:pX agent=pi status=working`，平台树里 alpha 挂在根下 | `level4-.../transcripts/root.md`、`herdr-snapshot.json` |
| 接线前提成立：`PIGROUPS_SPAWN_CMD` 带着 `-e .../src/extension.ts`，子成员才会成为成员 | `level4-.../env.sh`、`transcripts/alpha.md` |
| 简报真的进了子成员的模型并引发动作：`INJECTED … [dm:m_635f7e_m_d1becc#1] root: You are alpha…` → 子调 `pg_say` → `{"conv":"g:m_d1becc","seq":1}` | `transcripts/alpha.md` |
| 子成员的群消息人能读到：`GET /v1/messages?to=g:m_d1becc`（人 token）返回 `sender_name:"alpha"`、`seq:1` | `level4-.../after-delete.txt` |
| journal/watermark 按成员分：同一个 `PIGROUPS_ADAPTER_DIR` 下两个 journal，`injected/m_d1becc.json` = 6，`injected/m_635f7e.json` = 5 | `level4-.../adapter-dir/` |
| 删除：根自己调 `pg_terminate` → `{"terminated":["m_635f7e"]}`；成员变 `gone`；`sys.terminated` receipt `delivered`；子 pi 正常退出（pane 末行是 pi 的 resume 提示）；`herdr agent list` 与 `ps` 都没有它 | `after-delete.txt`、`db-inspect.txt` |
| pane 关闭：第一次 run 失败（`wE:pX agent=- status=unknown` 留在 shell）。`9453f6d` 让 `terminate()` 关闭 `spawn()` 记下的 pane；复跑 `wE:p11` 在删除后从 `herdr pane list` 消失 | `level4-fix-.../report.md` |
| `pg.report`：模型侧**没有** `pg_report` 工具（子成员用 `searchTools("pg")` 只找到 9 个），所以子不能用这个控制项汇报；**模型侧的“汇报”是 `pg_say` 说话**，不是不可能汇报（`transcripts/alpha.md` 里子确实说了）。控制通道本身可用——复跑里根收到适配器自发的 `pg.report {"status":"blocked","text":"no output after 3 nudges …"}` | `transcripts/alpha.md`、`level4-fix-.../root-pane-after-delete.txt` |
| 删除后的兜底报告也发不出：`session_shutdown` 的 `reportExiting` 先 `GET /v1/whoami`，`gone` 成员得到 410 `member_gone`（平台的 `PiGroups/src/http.ts:20-23`），适配器在 `reportExiting` 的 catch 里吞掉（`pigroups-adapter/src/extension.ts:91-93`），所以这条路径到不了根 | `PiGroups/src/http.ts:20-23`、`src/extension.ts:91-93`、`level4-.../report.md` |

**这次证明了什么**：人按 `herdr pane split` + `herdr agent start` 起根 → 适配器轮询 → `pg_spawn`
经 `HerdrCli` 建成员和 pane → DM 简报注入子模型 → 子模型真的调工具说话 → 人 API 能读到 →
`pg_terminate` 删除成员、子进程退出、pane 关闭；共享 adapter dir 下父子各自的水位没有互相踩。
这是第一次把“平台 + 适配器 + herdr + 真模型”串成一条真机链路，而且失败点都有日志。

**这次没有证明什么**：只跑了 1 个子成员（不是 2 个），完整场景只跑了 1 次（第二次只复跑失败点）；没有重启/重放/崩溃；
没有模型主动发出的 `pg.report`（工具不存在），只有适配器自发的控制项；没有验孙子成员、
父适配器重启后关 pane（平台侧那个删除后 500 已在 PiGroups `e03af1a` 修掉）。
一次 run 是样本，不是对所有路径的证明。

**探针隔离的教训**：第一次 run 的 `pi -e extension.ts` 继承了用户全局扩展
（`pi-straw-boss`、`pi-intercom`）；root 把一条消息经 intercom 转进用户主会话，还触发
`balance.mjs after-close wE:pX` 重排了用户的 tab。复跑用 `-ne` 只加载适配器。真机探针必须
隔离，见 §2.3 与 `probe/README.md` 第 4 级。

---

## 4. 真机四级清单（2026-11-01 实测后）

**每一级只验一件事，失败就停在那级。** 一次起三个成员跑完整场景，出错时分不清是 adapter、herdr 还是模型。

| 级 | 验什么 | 失败的后果 | 通过标准 | 状态（2026-11-01） |
|---|---|---|---|---|
| **1** | 在 `agent_settled` 回调里调 `pi.sendMessage(text, {triggerTurn: true})` **能真起一轮** | 整个消息通道静默失效（最致命，所以排第一） | 探针扩展在 idle 时投一句，日志里出现一次新的 `agent_start` | **通过**。`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮（`delivered p3 → turn_start run 4`） |
| **2** | 一个卡住的工具在外部 `abort()` 后回到 idle | 卡住的成员永远收不到 `pg.abort`，回到"没人能叫停它" | `abort()` 在有界时间内 resolve，日志里那轮以 `aborted` 结束 | **部分通过**。配合的工具（从 signal 监听器返回）2 ms 结束；**忽略 signal 的工具不会被 pi 杀掉**，settle 要到 58 296 ms 后才来。证据：`run-20261101T1920-control/` 与 `run-20261101T1920-ignore-signal/` |
| **3** | `shutdown()` 后进程真退、session 落盘 | 被删成员留一个僵尸 pane | 进程 exit 0，session JSONL 有结尾 | **部分通过**。SIGTERM/tui 这条路径已用 3 s 异步体 + `process.on('exit')` 证明 await：`waited_ms=3000`，`process_exit` 在 `shutdown_done` 之后 54 ms，`exit 0`。**没调 `ctx.shutdown()` 自调用，没验 print/json 模式、session 落盘、shutdown 正在跑的一轮** |
| **4** | 端到端：根 + 子成员、真模型、派活 → 汇报 → 删除 | — | 子成员收到简报、**说了一句话**（"汇报"就是说话：任务由消息关闭，模型没有也不该有 `pg_report` 工具），删除后子进程与 pane 都消失 | **部分通过（主链路通过；只跑了 1 个子成员）**。`probe/logs/level4-20261101T193132/`：根由 herdr 起、`pg_spawn` 建成员与 pane、简报进子模型、子消息人可读、删除后成员/进程退出都成立；pane 已由 `9453f6d` 修好并在 `probe/logs/level4-fix-20261101T193945/` 复跑确认。**判据被改过两处**（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说话），逐条记在 §3.6：原判据里 `pg_report` 那条是写判据的人写错了，`pg.report` 只有适配器自己在 blocked/exiting 时发；但只跑了 1 个子成员，所以整级不记通过 |

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
| `herdr agent start` 在真实 pane 里的行为 | **已验证**（第 4 级）：root 与 child 都由 `agent start` 起，返回 `interactive_ready:true`，pane 显示 `agent=pi`。**未验**的是失败后的 `pane send-text` 兜底路径 |
| `pg_terminate` 关 pane 只覆盖“本适配器内存里记得的 pane” | 本轮补到三种死亡路径：`spawn()` 按成员 id 记住 pane，`terminate()`（自己删，含平台级联返回的每个 id）关；`pollOnce()`/settle 用 `GET /v1/members/{id}` 复核映射里的每个成员，`status:"gone"` 就关——所以**祖先直接删本适配器的直接子成员**（不经过本进程的 `terminate()`）也会在 TTL 内关掉；`pane_not_found` 视为已关，其他失败记 `pane_close_failed` 并保留映射等重试。**仍漏**：映射只在内存里，父适配器重启后丢失；子成员（孙子）由子适配器拉起，父/根删它时本进程没有映射。要补需持久化/共享 pane map，或平台协作 |
| 模型侧没有 `pg_report` 工具 | **产品缺口，未决，但不再是第 4 级的判据**。规范只列 9 个工具；第 4 级原判据要求“根收到 `pg.report`”，这条已撤回并记账（§3.6）。适配器可自发 `blocked`/`exiting` 控制项，模型不能主动发 `done`/`progress`；模型侧的“汇报”现在定义为说话（`pg_say`）。要么加第 10 个工具并改 `docs/设计说明.md` §5.3，要么保持“汇报=说话” |
| ~~删除后 `GET /v1/control?all=true` 500~~ | **平台侧已修（PiGroups `e03af1a`）**：`sys.terminated` 曾把裸成员 id 写进 `to_json`，而读侧统一 `JSON.parse`——删一个成员就把"解释这次删除的日志"打成 500。**旧库也要能读**：两个读侧改成容错解析（非 JSON 原样返回），`openDatabase` 开库时把非 JSON 的 `to_json` 一次性 `json_quote` 回填——否则 `?to=` 过滤（比较 JSON 形式）会静默漏掉旧行。两块各有测试：`test/legacy-control-target.test.ts` |
| 删除后父的义务表残留 | **本轮已修到这些路径**（`d19a179` + 第五轮）：`terminate()` 丢弃平台级联返回的**每个**成员（不只是参数）的私聊义务；`say()` 收到 410 立刻丢；其余靠 `GET /v1/tree` 名册在 settle 时复核。名册读失败、或返回的不是名册（`{"nodes":[]}`、无 id、不含自己）时**一条不剪**；**债比名册快照年轻**（`since >= at`，即对端可能是在快照之后才创建的）也**不剪**——这两条是本轮补的，之前会误删真债。`test/obligation.test.ts` 守着。**仍漏**：进程启动后第一次 settle 之前，`reconcileObligations()` 仍可能把对端已死的 DM 重新标成欠回复；已剪掉的债可能被一条迟到的消息重新标上（只在下一次名册读成功时再剪）。第 4 级第一次 run 时观察到 `owed:["dm:…"]` 与 3 次 nudge |
| 子成员消失后群会话从人类索引消失 | 平台按概念稿 §3.3 是正确的（群只在有子成员时存在）；但删完后 `GET /v1/conversations` 看不到那个群，只能按已知 `g:<parent>` 读历史。已知限制，未改 |
| 子成员 `gone` 的遥测文案显示 `id（id）` | 小瑕疵，未修：`terminate()` 时 telemetry 没有该成员的名字，回退到 id。不影响状态判断 |
| pane 关闭与子成员自己的 `sys.terminated` 退出竞争 | **已知，未改**：`DELETE` 提交后立刻 `herdr pane close`，可能抢在子 pi 消费完 `sys.terminated`、写完 session 之前把它杀掉。复跑里没有子成员的 receipt/transcript 作为“它先读完通知”的证据。不改的理由：删除已经提交，子成员在平台上已 gone；herdr 没有“等 agent 自己退出”的 wait，硬等一个卡住的 agent 会把 `pg_terminate` 拖到 180 s 命令超时。若要收紧，得先定“谁来证明子进程已退出”，那是设计决定 |
| 真机探针会继承用户的全局 pi 扩展 | 第一次第 4 级 run 踩过：root 通过 `pi-intercom` 把消息转进用户主会话，`pi-straw-boss` 还重排了用户 tab。`probe/README.md` 第 4 级与 §2.3 已要求 `-ne` + 只加载 `-e` 适配器；这是探针纪律，不是产品代码 |
| 消息与 inbox 都没有清理策略 | 已知，无上限增长。规模上来再定 |
| 催办三级的阈值（5 分钟窗口 / 3 次上限 / 30 分钟持续） | 全是拍的数字。第 4 级看到了“3 次后 blocked”真的发生，但没有负载样本校准 |
| `at-most-once`（取走即消费）的丢失代价 | 用 journal 缓解，但没有实测过崩溃频率下的影响 |
| 相关性分级（`mentions_me` / `from_parent`）在真实群里够不够 | 仍未验证。第 4 级只有 1 个子成员、1 个群，样本不够；若不够，才考虑启用门控 |
| 同一个 cwd 的两个成员会互相覆盖文件 | 平台没有文件空间；靠 spawn 时指定 cwd 约束 |

---

## 8. 怎么重跑一切

**先确认你手里是哪一版。** 两个仓库都是 `0.2.0`，各有一个未签名 annotated 标签 `v0.2.0`（平台 `1d68dd4`、适配器 `f340f25`，都指向写作时的 HEAD），`git describe --tags` 两边都应输出 `v0.2.0`；本文档描述的就是这一对。

**号住在哪。** 平台只有一处：`package.json`；`src/version.ts` 直接 import 它，`/v1/health` 与每个响应的 `server_version` 都是这个数，没有第二个常量。适配器两处必须一致：`src/version.ts` 的 `ADAPTER_VERSION` 与 `package.json`（`test/version.test.ts` 也会比对 lockfile）；`pg_whoami` 的 `adapter_version` 与启动那一行日志都报它。**平台的 `package-lock.json` 仍是 `0.1.0`**——生成文件没跟上，真值以 `package.json` 与标签为准，平台的版本守卫不查 lockfile。

**发一次版**（两个仓库同一个号，缺一不可）：

```bash
# 1) 两边的 package.json 改成同一个新号；适配器再 npm install --package-lock-only 让 lock 跟上
# 2) 两边 CHANGELOG.md 各写一条，并写明按 0.x 口径这次是 patch 还是 minor
# 3) 提交，然后各打一个未签名标签（annotated，不要 -s）
git tag --no-sign -a v0.3.0 -m "v0.3.0: adapter 0.3.0 + platform 0.3.0, one release of the pair"
git cat-file -p v0.3.0 | grep -c gpgsig     # 期望 0
```

口径（`CHANGELOG.md` 里也写着）：0.x 阶段按本项目自己的定义，不按 semver 默认——patch（`0.x.N+1`）只修 bug，端点、字段、工具名都不变；minor（`0.X+1.0`）是契约变化：加/删字段、端点、工具，改已记录的行为，数据迁移，新增接口成员。两个仓库一起走到同一个号，标签记录这一对。

**本轮实测到、没修的问题**：平台的变异守卫清单里“只改 `package.json` 看测试变红”这一条按字面做不到（单源，改它不会红；把 `SERVER_VERSION` 写死成 `0.1.0` 才会红，实测 1 条失败），适配器那份按字面有效（`0.2.1` ≠ `0.2.0`，实测 1 条失败）；平台 `CHANGELOG.md` 写 `sys.terminated` 的入队与唤醒都在同一事务——入队确实在（`src/routes/org.ts:82-125`），`wakeMembers` 在事务提交之后（同文件 `:127`）。

**以人身份读全部内容，三步，别想当然**（第 4 级真机跑时踩过）：

```bash
# 1. 管理员 token 只用来换一个人 token；它不是任何读接口的凭据
curl -sX POST localhost:7717/v1/humans -H 'Authorization: Bearer adm' \
  -H 'content-type: application/json' -d '{"name":"me"}'      # -> {human:{id}, token}
# 2. 人的"全部指令"视图是 `all` 参数，且只有 /v1/control 有
curl -s 'localhost:7717/v1/control?all=true&limit=50' -H "Authorization: Bearer <human token>"
# 3. 消息没有全量视图：先列会话，再逐个读。`GET /v1/messages` 永远要求 `to`
curl -s localhost:7717/v1/conversations -H "Authorization: Bearer <human token>"
curl -s 'localhost:7717/v1/messages?to=g:m_xxx&limit=50' -H "Authorization: Bearer <human token>"
```

> 这条曾因平台 bug 在删除后 500（`sys.terminated` 的裸 id），已由 PiGroups `e03af1a` 修掉。

```bash
# 平台
cd ~/Documents/PiGroups
npm run typecheck && npm test          # 56 tests，约 2.3 秒

# 适配器（会自己拉起一个平台子进程）
cd ~/Documents/pigroups-adapter
npm run typecheck && npm test          # 78 tests，约 8.3 秒
PIGROUPS_PLATFORM_DIR=~/Documents/PiGroups   # 默认是 ../PiGroups

# 手动起一个平台
cd ~/Documents/PiGroups
PIGROUPS_ADMIN_TOKEN=adm PIGROUPS_DATA=$(mktemp -d) PORT=7717 npm run serve
```

变异测试的脚本没有留在仓库里（都在 `/tmp`）。要重做就看 `docs/设计说明.md` §10 的测试策略，以及本轮交接时列过的 17 个变异点——最值得重跑的是：`flush()` 的返回值、水位是否按成员、`gap` 是否推进水位、`stop()` 是否等待在飞投递。

---

## 9. 接手的第一件事

1. 跑一遍上面两个 `npm test`，确认 56 / 78 全绿（`v0.2.0` 的数）
2. 读 `pigroups-adapter/docs/设计说明.md` §2.1（`PiSurface`）和 §2.2（`Herdr`）——那是真机验证的靶子
3. 重跑 `probe/run.sh`（对照组应 PASS）与 `PROBE_IGNORE_SIGNAL=1 probe/run.sh`（硬变体应 FAIL 在 P2.5/P2.7，这是 pi 的已知边界）
4. 补第 3 级剩下的 `ctx.shutdown()` 自调用、print/json 模式、session 落盘；`pg.abort` 的 turn_end 已修，不要再动
5. 第 4 级主链路已在真机跑过（§3.6），整级是部分通过；补第 2 个子成员、重启/级联、以及判据改动后的完整场景。`pg_report` 不再是第 4 级的判据（§3.6），但“加不加第 10 个工具”仍是产品决定。不要因为主链路通了就勾第 4 级

**不要**在真机之前改循环。接口假设错了，循环改多少遍都是白改。

---

## 10. 交接清单

- [x] 两个仓库 `git status` 干净；都在 `0.2.0`，都有未签名 annotated 标签 `v0.2.0`（平台 `1d68dd4`、适配器 `f340f25`，详见 §8）
- [x] `PiGroups`: 56/56，typecheck 干净（2026-11-01 版本工作实测，约 2.3 s）
- [x] `pigroups-adapter`: 78/78，typecheck 干净（2026-11-01 版本工作实测，约 8.3 s）
- [x] `grep -c 'pi-coding-agent' pigroups-adapter/src/loop.ts` = 0（实测 0）
- [x] herdr 版本记下（本机 0.9.5，`herdr --version` 2026-11-01 复核），三个旗标形状与 §3.4 一致
- [x] 第 1 级探针通过（2026-11-01，`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮）
- [ ] 第 2 级探针**部分通过**（对照组 2 ms 切断；`PROBE_IGNORE_SIGNAL=1` 的硬变体 P2.5/P2.7 失败：pi 不杀忽略 signal 的工具；`bash sleep 60` 未验）
- [ ] 第 3 级探针**部分通过**（SIGTERM/tui 已证明 await 与 exit 0；`ctx.shutdown()` 自调用、print/json 模式、session 落盘、shutdown 正在跑的一轮都未验）
- [ ] 第 4 级端到端**部分通过**（2026-11-01：`probe/logs/level4-20261101T193132/` + `level4-fix-20261101T193945/`；根由 herdr 起、`pg_spawn` 建成员与 pane、简报进模型、子消息人可读、删除后成员/进程/pane 都没了。**只能记部分通过**：只跑了 1 个子成员，且两条判据事后在 `de48904` 里改过（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说话，不在记录那次 run 的 `3919467` 里，见 §3.6）。`pg_report` 工具缺失是产品缺口（§7），不是这一级的判据；重启/级联未验）

---

## 11. 审阅留痕

2026-11-01 第四轮审阅，三个视角，18 条，逐条判过：

| 视角 | 它问什么 | 条数 | 判决 |
|---|---|---|---|
| 阻断 | 哪条“通过”其实不成立 | 2 | **2/2 成立**。P2 是假通过（工具从自己的 signal 监听器返回，`--no-builtin-tools` 又让 `bash sleep` 从未加载）；P3 的 251 ms 体不区分 await。现在用 `PROBE_IGNORE_SIGNAL=1` 硬变体（P2.5 在 3009 ms 记到 `idle_timeout`，P2.7 的 settle 晚到 58 296 ms）和 3 s 异步体 + `process.on('exit')`（`after_shutdown_done_ms=54`）补成真证据 |
| 应修 | 代码、测试、探针哪里不硬 | 10 | **10/10 成立，全部改完**：`turn_end` 幂等门、`nudgeOwed` 的 abort 竞态、`deliver()` 契约措辞、`surface.abort.test.ts` 10 条、P2 的界对齐 3000 ms、4 项装饰性检查改成真断言、归档正/负对照、abort 后 settle 的投递补进探针、mid-turn 投递的措辞（pi 会 steer，不是静默拒绝）、陈旧文本 |
| 备忘 | 这条指控站不站得住 | 6 | **3 条撤回**（“A 循环论证”“26 ms 可当精确值”“新 run 会让 abort 期间的 `isIdle` 为真”），**3 条留档**（`details.kind` 无用例、`hasPendingMessages` 恒为 false、第 3 级残余缺口） |

净结果：没有一条要求改接口。P2 的边界是 pi 的，不是 adapter 的；P3 的实现本来是对的，缺的是证据。每条修法都做了反向变异或真机重跑，数字在 §3.3 与 §3.5。

2026-11-01 第五轮审阅，三个视角，提出 27 条、成立 25 条（下表按定级后计），逐条判过：

| 视角 | 它问什么 | 条数 | 判决 |
|---|---|---|---|
| 阻断 | 哪条“通过”/“已修”其实不成立 | 4 | **4/4 成立，全部修完**。① `d19a179` 会把 30 秒名册快照之后才建的对端的债当成无人可答；② `e03af1a` 不治已有的库：真机 level-4 库里就是 `to_json='m_635f7e'`，两个读侧仍无条件 `JSON.parse`，`?all=true` 仍 500、`?to=` 仍空；③ 关 pane 失败把已提交的删除报成工具失败（`pane_not_found` 让每次重试都失败；编辑从应修升格）；④ 第 4 级文档同时写“通过”和“部分通过”，两处判据改动没记账（状态已在 §3.6 / §4 统一，这里只记账） |
| 应修 | 代码、测试、探针哪里不硬 | 12 | **12/12 成立，全部修完**。名册要验形（`{"nodes":[]}` 曾清空全部私聊债）；`terminate()` 只剪参数、不剪级联；`stop()` 不等在飞的 settle；一次 settle 能投两次；pane 映射从不与平台对账；关 pane 抢在子成员收尾之前；新测试漏掉新快路径与关闭顺序；债务测试靠 `delay(10)`、“提醒”用例名不副实；复跑没记树；元数据过期；§7 的“已修”写宽；退出报告引错文件 |
| 备忘 | 这条指控站不站得住 | 9 | **9/9 留档，其中 2 条顺手修**。回拨的钟会把名册快照钉住（已按 `now >= at` 修掉）、JSDoc 漂移（已挪回 `nudgeOwed`）；留档未动 7 条：名册读失败无退避、`ROSTER_TIMEOUT_MS` 只是 race 不是取消、启动/`tick()` 不剪（重启后可能先标一个已死的私聊）、掉队消息会重标已剪的债、herdr 命令 180 秒超时、根 pane 不是缺口、平台新测试只覆盖第一页 |

编辑另撤回 2 条：“`de48904` 那句‘这一条当时就是过的’是假”（子成员确实用 `pg_say` 说了话，真缺陷是判据改动没记账，已在 §3.6 记账）；“补一条成员侧控制项测试”（`sys.terminated` 行 `from_id='sys'`，成员视图按 `from_id = principalId` 过滤，成员看不到，测了也是空转）。纠正 2 条：`resolveTree` 的 `pending: true` 打印不是证据（Promise executor 同步赋值，解析后照样打印 true，超时要引 `withTimeout` 与缺失的 `AbortSignal`）；pane 关闭失败从应修升为阻断。

修法都有“撤掉 src 就红”的证明：义务 19/19→18/19（三条各掉一条）、关 pane 失败 5/6、`pane_not_found` 2/2→1/2、pane 对账 5/6、`stop()` 3/3→2/3、投递计数 6/6→5/6；平台回填与容错 2/2→1/2。恢复后适配器 75/75、平台 55/55。改动清单在 §12。

留给人做的是取证和产品决定，不是代码：关 pane 可能抢占子成员的 `sys.terminated` 与会话落盘，只做了文档化，要真机复跑抓子进程收据；pane 映射只在内存、也看不到子适配器自己起的孙成员；`pg_report` 仍是产品决定（已不是第 4 级判据）。其余已知限制见 §7。

---

## 12. 第五轮审阅后的修复（2026-11-01）

这一轮只动 `d19a179` / `9453f6d` / `e03af1a` 这三笔提交留下的洞，没有动接口（`PiSurface`、`Herdr` 的签名不变）。每条行为修复都配了一个“撤掉 src 就变红”的测试；两个仓库最后 `typecheck` + `npm test` 全绿（55 / 75）。

**适配器（`pigroups-adapter`）**

- 义务剪除（§4.1）：`GET /v1/tree` 的 30 秒快照只判断**比快照更老**的债——`since >= 快照.at` 的债不剪，因为对端可能是在快照之后才被创建；名册必须是数组、每个节点有字符串 id、且包含自己，否则整次读作废、一条不剪（`{"nodes":[]}` 曾能清掉所有私聊债）。`terminate()` 剪掉平台级联返回的**每个**成员（原来只剪参数，孙子的债会留着）；`say()` 的 410 也把该成员从缓存名册里删掉。
- settle 的投递纪律（§2.3）：`onSettled` 在等平台时，别的路径可能已经投递；现在按“这次 settle 开始后有没有发生过投递”判断，不再因为 `flushOutcome()` 看到空队列就补 nudge。`stop()` 等待仍在跑的 settle reaction，并在每个 await 之后重查 `stopped`，所以停下来的循环不会再投一笔。
- pane（§5.3）：关 pane 失败不再把已提交的删除报成工具失败；`pane_not_found` 算成功（真机 herdr 的形状：错误信封在 stderr、退出码 1），其他失败进 `pane_close_failed` 并保留映射等重试。`GET /v1/members/{id}` 在每个 `pollOnce()`/settle 里复核映射（每成员 30 秒一次），只关 `status:"gone"`——祖先直接删本适配器的直接子成员也会被收走。
- 文档：§1 / §3.6 / §4 / §7 / §9 / §10 与 `probe/README.md` 的第 4 级状态统一为“部分通过”，并逐条记账两处判据改动；复跑的树与命令记在证据目录（`tree.txt`、`commands.md`）；§7 的“已修”收窄到实际覆盖的路径。

**平台（`PiGroups`）**

- `GET /v1/control` 两个读侧对 `to_json` 容错解析（不是 JSON 就原样返回）；`openDatabase` 开库时把非 JSON 的 `to_json` 用 `json_quote` 一次性回填，`?to=` 过滤因此也能看到旧行。回归测试：`test/legacy-control-target.test.ts`（旧行在开库前写入 → 回填生效；运行中写入 → 容错读取生效）。
- `docs/设计说明.md` 的 `controls.to_json` 注释写明这段历史与修复。
