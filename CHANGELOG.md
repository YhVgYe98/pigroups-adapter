# 变更日志

只记发生过的事。"修好了"必须能在 `npm test` 里指到一条会变红的测试。

## 版本策略

这是 0.x。数字按本项目的定义，不按 semver 的默认：

| 位 | 什么时候动 |
|---|---|
| patch（`0.x.N+1`） | 修 bug，契约不变：端点、字段、工具名、文档化的行为都不动 |
| minor（`0.X+1.0`） | 契约变化：字段/端点/工具增删、有文档的行为改变、数据迁移、接口新增成员 |

- **一次发布记一对号。** 两个仓库当作一个系统开发，标签记的是**这一对**。两边都动就两边同号（`v0.2.0` = 平台 `SERVER_VERSION` 0.2.0 + 适配器 `ADAPTER_VERSION` 0.2.0）；只有一侧动时只动那一侧，另一侧保持原号——`v0.2.1` 是适配器单独一笔，与平台 0.2.0 配套。适配器的 `v<号>` 里永远是适配器自己的号。
- **版本号只有一个来源**：`src/version.ts` 的 `ADAPTER_VERSION`。`package.json`（和 lockfile）必须与之一致；`test/version.test.ts` 在二者不一致时变红。不要再造第二个数字。
- 0.1.0 只是脚手架留在 `package.json` 里的一个字符串：没有版本常量、没有 tag、没有任何地方报告它。本文件从 0.2.0 开始记账。

---

## v0.3.0（2026-11-01，与平台 0.2.0 配套）

**一次只动适配器的 minor。** 这次改了文档里冻结的 `Herdr` 接口，不是 patch：`close()` 的返回值、`pg_terminate` 的返回字段都变了。平台不动，仍是 `0.2.0`。

### 对 `Herdr` 实现者的变化

- `close(pane)` 从 `Promise<void>` 变成 `Promise<{ forced: boolean }>`。`forced: true` 表示等待 agent 退出的上限到点时，它仍在 `pane list` 里，pane 是强行切掉的；agent 在限内自己退出、pane 已不存在、或 `pane list` 读失败（没有观察到活 agent）都是 `false`。
- `pane_not_found` 仍然是成功，不抛错；返回值同样带上这次等待的 `forced`。
- 所有实现与假实现必须返回这个对象。`AdapterLoop.terminate()` 现在返回 `{ terminated, pane_close_failed, pane_close_forced }`，`pg_terminate` 的答案原样带三个字段；`pane_close_forced` 的每一项是 `{ member, pane }`。祖先删除路径上的 settle/poll 复核如果遇到强制关闭，会打一条 warn。

### 修了什么

- **`sys.terminated` 先切断正在跑的那一轮，再收尾（E）。** 以前 `discardAndShutdown()` 直接丢 journal、停循环、`shutdown()`；pi 的 shutdown 会等正在跑的工具，于是子成员卡在 `bash sleep 40` 里，父进程 5 s 后把 pane 从它还活着的时候切掉。现在终止路径先按 `pg.abort` 同一条规则 `abort()`：设置同一个 `aborting` 守卫，等待以 `ABORT_IDLE_TIMEOUT_MS`（3 s，没有第二个数字）为上限；abort 期间不投递，然后才丢 journal、清队列、停循环、shutdown。abort 是“切断”不是“暂停”：不补提示，被切的那一轮留在 transcript 里，和 §3.2 的 `pg.abort` 一致。测试：`sys.terminated cuts the running turn before discarding the journal and shutting down`；`sys.terminated reaches shutdown at the abort bound when the surface abort never returns`。
- **强制关 pane 不再伪装成干净关闭（F）。** `HerdrCli.close()` 的上限到点时如果 agent 还在 `pane list` 里，照样关 pane，但返回 `forced: true`；`pg_terminate` 把它列进 `pane_close_forced`，而不是只报 `pane_close_failed: []`。真机 `bash sleep 40` 那次“子成员被切断、调用者却只看到成功”的洞因此可见。测试：`close() reports a forced close when the agent is still running at the bound`；`pg_terminate reports a pane close that was forced past a still-running agent`；原来的 clean 用例也断言 `forced: false`。

**测试与变异证明。** 84 → 88 条，`npm run typecheck` 干净。两条行为都做了“撤掉 src 就红”：撤 E 的 abort（回到先丢 journal、直接 stop/shutdown）→ 3 条 `sys.terminated` 里 2 条红，`sys.terminated cuts...` 红在 `timed out after 5000ms waiting for: the termination to cut the running turn`，`...reaches shutdown at the abort bound` 红在 `the termination asks for the cut / 0 !== 1`；撤 F 的 forced 回报（`HerdrCli` 固定回 `false`，loop 不读 `forced`）→ 11 条里 2 条红，`close() reports...` 红在 `a live agent at the bound must not look like a clean close / actual: false, expected: true`，`pg_terminate reports...` 红在 `actual: [], expected: [{ member: …, pane: 'pane-1' }]`。恢复后 88/88。

## v0.2.1（2026-11-01，与平台 0.2.0 配套）

**一次只动适配器的 patch。** 端点、字段、工具名都没变，`PiSurface` 与 `Herdr` 的成员没变，`pg_terminate` 的返回形状也没变。四条都是 `docs/handoff.md` §7 里记着的洞（A–D），没有一条是契约变化。`Herdr.close()` 的契约仍然只是“关掉 pane；已经不在的 pane 算成功”；A 加的是实现里的有界等待，`docs/设计说明.md` §2.2 / §5.3 同步写清它等多久、以及 5 s 到点仍会切掉活 agent——那条原本记的是“已知缺口”，不是对调用者的承诺。

- **关 pane 会先等窗格里的 agent 退出（`7ae1adc`）。** `HerdrCli.close()` 每 200 ms 读一次 `herdr pane list`，直到 pane 消失、或它的条目没有 `agent` / `agent_status === 'unknown'`，最多等 `PANE_AGENT_EXIT_TIMEOUT_MS = 5000`，然后才 `pane close`；`pane list` 读失败就落到原来的关闭路径，失败时的行为不变。**这条没有把竞态消掉，只是把它从 0 ms 推到 5 s**：真机上子成员卡在 `bash sleep 40` 里时，5 s 到点仍会关掉一个 `agent=pi working` 的活进程，`pg_terminate` 还是返回 `pane_close_failed: []`（四次 run 3 PASS / 1 FAIL，见 `docs/handoff.md` §3.7）。所以 §7 那一行还是开着的。测试：`close() waits for the pane agent to exit before it runs pane close`。
- **启动时先剪一次死对端的债（`712db53`）。** `init()` 在 `replayJournal()` 之后、`ready` 之前用一份**新读的**名册剪一次。这一份名册比刚读到的历史新，所以 `reconcileObligations()` 刚标上的债也能被它判定；`since >= at` 的守卫只在正常 settle 里保留，startup 这唯一的路径上不适用。**仍漏**：如果死对端的消息还躺在 poll 队列里，第一次 poll 会把它投进来、重新标成欠回复，要等下一次 settle 才再剪。测试：`a member that starts up owing a dead peer has no debt before the first settle`。
- **名册读保留上一份好快照、超时会中止请求、失败退避 5 s（`6ce2789`）。** `PgClient.tree(signal?)` 把 signal 传进请求与 `fetch`；`aliveIds()` 用新的 `withAbort()`，超时 `abort` 请求，不再只是放弃 promise；读失败或答案不是可信名册时保留上一份好快照，并在 5 s 内不再重读；启动仍然强制新读。测试 4 条：坏名册保留快照、退避内不重读、超时真的中止、`tree()` 把 signal 传进 `fetch`。
- **注释回到与代码一致（`e1fcf13`）。** 只改注释：名册读现在也发生在启动、缓存的是上一份好快照而不是实时名册、读失败回退到快照而不是无条件保留每条债。

**测试与变异证明。** 78 → 84 条。四条行为测试都做过“撤掉 src 就红”：A 撤 `src/herdr.ts` → 那条 0 pass / 1 fail；B 撤 `src/loop.ts` → `actual: ["dm:…"]`、期望 `[]`；C 撤 `src/loop.ts` + `src/pgclient.ts` 到 `712db53` → 四条全红（快照被丢、退避内仍重读、超时路径没有 signal、`fetch` 没收到 signal）。恢复后 84/84，typecheck 干净。

**还没关的。** 关 pane 的 5 s 硬上限（§7，真机 FAIL 一次）；`ctx.shutdown()` 自调用已在真机上走过，print/json 模式仍未验；名册退避是固定 5 s，不随失败增长；掉队消息仍会重标已剪的债。

---

## v0.2.0（2026-11-01，与平台 0.2.0 成对）

**变成了什么。** 一个 Pi 扩展：装进一个 session，那个 session 就是成员。拉取平台 → 分类 → 注入 → 记义务 → 上报遥测；9 个 `pg_*` 工具；`herdr` 起子成员、收 pane；journal 先落盘再注入，水位按成员持久化。真机上跑通了第 4 级主链路（整级仍是部分通过，见 `docs/handoff.md` §3.6）。

### 为什么是 minor，不是 patch

0.1.0 之后契约变了，不是修 bug：

- `pg_terminate` 的返回从 `{terminated}` 变成 `{terminated, pane_close_failed}`。删除已经提交，关 pane 失败只进第二个字段，不能把工具变成错误。
- `Herdr` 的错误有了类型（`HerdrCommandError` 带 `code`）；`close()` 把 `pane_not_found` 当成功。接口成员没变，但实现与错误的契约变了。
- `pg_whoami` 的答案多一个 `adapter_version`（`docs/设计说明.md` §5.3 同步）。
- 启动多一行日志：`[pigroups] adapter <version> starting against <url>`（§8）。

### 真 bug（真机 run 抓到的，和真机 run 之后逐条走查出来的）

- **一次 settle 投两笔。** settle 反应在决定之前要等平台（读名册、复核 pane）；等待窗口里 `pollOnce() → ingest() → flush()` 这条独立的路可能已经投过一批。反应回来只看 `flush()` 的返回值（空队列）就补一条 nudge，于是一次 settle 两笔投递。修法：跨所有投递路径记一个单调计数，比较反应前后的计数，不看 `flush()` 的返回值。附带：`onSettled` 的订阅挪进构造函数——只绑在 `start()` 上的话，没起定时器就收不到空闲事件，催办和 reminder 一起死。
- **催办饿死队列。** 顺序是"先 nudge 再 flush"时，只要会话还欠着回复，每次 settle 都先催 → 催办自己起一轮 → surface 忙 → 紧随其后的 `flush()` 永远空转 → 新消息永远送不到。而"欠着不吭声"正是催办要治的病：药把病也一起掐了。修法：flush 在前；这次 settle 一笔都没投出去，才 nudge；被压住的消息等下一次 settle。
- **journal 和水位不是按成员分的。** `PIGROUPS_ADAPTER_DIR` 会传给子成员，整棵树共用一个目录，而私聊的会话 id 两端是同一个字符串。一份 journal / 一张水位给整棵树用：子进程能重放父的批次、提交后删掉父唯一的副本，`discard` 还会清掉所有兄弟的待注入批次。修法：`journal/<memberId>/`、`injected/<memberId>.json`，按成员分；水位按会话记（`injected[conv]` = 最大已注入 seq）且落盘；gap 只是"去补读"的锚点，**绝不**推进水位——推进了，`seq === gap.before` 那条就永远不注入。
- **被 abort 的一轮没有 `turn_end`。** pi 的 abort 不走 `agent_before_settle`，直接跳出这一轮；循环一直以为 turn 还开着，父永远收不到"这一轮被切断"。真机探针抓到的。修法：从 `agent_settled(aborted=true)` 补一个 `turn_end`，用 `turnOpen` 保证一轮只有一个结束——`before_settle(completed)` 之后又来 `settled(aborted)`（abort 落在别的扩展的异步边界里）时不能再补第二次。
- **给已删除成员的债还不掉。** 成员被删时它的父还欠它一条回复；平台不撤任何标记，每次发送都是 410 `member_gone`，活着的成员被永远催一条对面没人的会话。修法：一对一债还要求对端在活名册里（`GET /v1/tree`，带缓存）；`terminate()` 和发送时的 410 立刻剪掉。第一版按第一个下划线切会话 id，而成员 id 自己带下划线，守卫从没生效过；现在拿已知的一半分别对上两端，精确匹配。名册还必须可信才剪（数组、字符串 id、含自己），`{"nodes":[]}` 曾经能清掉所有私聊债；比快照新的债不剪（对端可能是在快照之后才创建的）。
- **`terminate` 之后 pane 留在 tab 里。** 删除成员会停掉它的 pi，但它留下的 pane 退回一个 shell，还在 tab 里。修法：`spawn()` 按成员 id 记下 pane，`DELETE` 提交后关；关失败保留映射、报 `pane_close_failed`，`pane_not_found` 算成功。祖先直接删本适配器的直接子成员不走本进程的 `terminate()`，所以 poll/settle 用 `GET /v1/members/{id}` 复核映射（每成员最多 30 秒一次），只关 `status:"gone"`。

### 定死、不再改的接口决定

- **`PiSurface`** 是循环唯一能看到 pi 的地方，`loop.ts` 不 import pi 包——这是全部可测性的来源。`onEvent` 是必需成员（少了它，`stalled` / `error` 无从推导）。`deliver()` 的 resolve 只表示 pi 收下了消息，不表示 run 已经起来（`sendMessage` 是 void，pi 吞掉启动失败）。`abort()` 有 3 秒上限：pi 不会强杀一个忽略 abort signal 的工具，这是实测边界，不是保守值。
- **`Herdr`** 是进程唯一的出口，`loop.ts` 从不直接跑命令。`pane_not_found` 是成功；其他 herdr 失败保留映射等重试，不能把已提交的删除报成失败。
- **`pg.*` 的 `v`** 只认已知版本；更高版本的 `pg.*` 当未知命令原样注入，不按 v1 解释，也不丢。

### 还没做 / 已知边界

- `pg_report` 不是工具：9 个工具，规范也只列了 9 个。"汇报" = `pg_say` 给父发一条 DM。产品缺口，待定。
- 第 4 级仍是部分通过：只跑了 1 个子成员，判据在记录那次 run 的同一个提交里改过两次。
- pane 映射只在内存里，适配器重启就丢；子适配器自己拉起的孙子 pane，本进程从来没有映射。
- "一次 settle 只投一次"不覆盖投递排队分支：留存日志里 `hasPendingMessages` 恒为 false，两笔投递同时排队、turn 中途再投都没有真实样本。
