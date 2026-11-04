## v0.9.0（2026-11-04，与平台 0.2.0 配套）

次版本。这一版把 2026-11-03 那场真实运行的测量结果变成了行为变更，并补上"进程死了怎么接回来"。

- **欠回复改成持久化 flag**（`owed/<memberId>.json`）：投递置、`pg_say` 或新的 `pg_ack` 清。
  旧规则从历史推导，结果是"只能靠说话来清"——两端互相收尾时会把对方的债重新置起来
  （实测 17 次 ack↔ack、14 次撞上催办上限）。`pg_ack(conv, seq?, all?)` 清 flag 但不发消息，
  也不清催办计数：`silent acking` 要能看见"只确认不干活"。
- **`pg.report` 删除**，并进 `pg.attention`：`exiting` → `state:'gone'`；`blocked` / `silent_acking`
  成为两个账本态。一条通道、一套去重、一套窗口。父级的遥测表从"一个子一个状态"改成
  **每个子一张活动状态表**（`states[]`），因为一半的状态是按会话的事实。
- **遥测提醒只一次**，删掉 30 分钟重提；`idle_owed` 上报但不触发注入。`stalled` 吞掉同一回合的
  `slow_turn`。
- **父级只接受直接子发来的 `pg.attention`**（panes ∪ telemetry ∪ roster，miss 时按 TTL 刷一次 roster）；
  非子只当控制行注入，不改状态。
- **新增 `pg_respawn`**：进程死了但成员还在时，用记录里的 session 文件与旧 token 把会话重新打开、
  恢复平台绑定，再让每个回来的成员对它自己的下一层做同一件事。**成员 id 不变**（所以会话 id 不变、
  老对话接着用）；被删的（`gone`）身份不可复原；`intent:terminated` 的永不自动拉起；已在跑的不重启。
  绝不重发 token（重发会踢掉活着的成员）。
- **数据目录迁到 `~/.pi/pigroups`**（自定义 profile 时 `<PI_CODING_AGENT_DIR>/pigroups`），
  旧 `~/.pigroups-adapter` 只对默认路径兼容读一次，显式配置不会被它吞掉。
- **关 pane 不再信内存映射**：每次需要关闭时去 `herdr pane list` 按 `agent_session` 的 session 文件找，
  所以父进程重启过、一个成员有多个 pane、herdr 重启换了 pane id，都能关对。
- 未确认批次：`aborted` 重投、**`error` 丢弃**（31 个重复投递全部追溯到 5 个会话各收到一次 `pg.abort`）。
- 注入给模型的文本全部改成英文。

## v0.8.0（2026-11-02，与平台 0.2.0 配套）

次版本：`pg_spawn` 的语义变了（立刻返回），并且修掉三个真机问题。

- **派生不再阻塞**。`pg_spawn` 在子成员启动后立刻返回 `{id, name}`；就绪（D1，平台的
  `last_seen_at`）由后台盯，超时才往父的上下文里放一行 `[spawn] … never connected`。
  以前父会为一个已经在干活的子成员空转十几秒。
- **成员落在父的 workspace**。`tab create` 不给 `--workspace` 时，herdr 用的是**焦点所在**
  工作区——同一套成员被撒到两个工作区、同名的角色出现两次。现在显式传
  `HERDR_WORKSPACE_ID`（缺失时退回 `HERDR_PANE_ID` 的前缀）。
- **`agent start` 的启动竞态**：新 tab 的 shell 还没出提示符时会失败，现在 250 ms 重试到上限；
  仍失败就报错，不再退化成往 pane 里打字。
- **测试不再泄漏平台进程**：`orgstart` 测试结束时按 `/proc` 里的 `PIGROUPS_DATA` 兜底清理
  （此前一次测试可能留下十几个平台进程占着端口）。

## v0.7.1（2026-11-02，与平台 0.2.0 配套）

补丁，两处真机上看到的问题：

- **`pg_children` 不再返回空**。它原来只列遥测表，而遥测**只报异常**——刚派生出来、正在安静干活的
  子成员没有条目，于是"父刚派完活就查，看到 `[]`"。现在列表来自平台（谁是我直接下级），遥测只
  负责填状态；没报过异常的下级显示 `ok`。
- **失败不再往 pane 里打字**。`spawn` 原来在 `agent start` 失败时把整条命令行（含
  `PIGROUPS_TOKEN=…`）`send-text` 进去。如果那个 pane 里已经有 pi 在跑，这行字会直接落进
  某个会话的输入框——人看到的就是"无关文本出现在 pi 里"。现在：pi 启动失败就是失败；只有
  `PIGROUPS_SPAWN_CMD` 指向**非 pi 的包装命令**时才走打字这条路，并且先确认那个 pane 里没有 agent。

## v0.7.0（2026-11-02，与平台 0.2.0 配套）

次版本，因为 `Herdr` 接口多了 `signal` 参数，且成员就绪的判据换了：

- **成员就绪按 D1 判**：等平台的 `last_seen_at` 非空，不再等 herdr 的界面状态。旧实现等
  `idle|done|blocked`，而**拿到长简报的子成员会立刻进入 `working`**，于是 `pg_spawn` 白等
  120 秒后把健康的成员报成失败（真实任务里踩到）。herdr 现在只在超时时用来分辨「进程没起来」
  和「起来了但连不上平台」，报错分两种。
- **子成员放进新 tab**，同一 workspace，不再和操作者挤一页；`pg_terminate` 后 tab 一起消失。
- **多个根 = 多个组织**：记录从 `<adapterDir>/org.json` 改为 `<adapterDir>/orgs/<key>/org.json`，
  key 是组织名（没给名字时按工作目录，或复用唯一已存在的那个）。此前两个根会抢同一个文件，
  第二个直接「重连」到第一个的组织上。
- **Esc 能打断长工具**：pi 的 `execute` 第三个参数是 `AbortSignal`，之前被整个忽略。
  `pg_spawn` 的等待、`pg_org_start` 的等待与 `herdr` 的 `execFile` 现在都听它。

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
- **build metadata 记录测试对象，不参与判定**：`0.4.0+platform.0.2.0` 里的 `+platform.0.2.0` 只说明这一版验证过平台 `0.2.0`。平台以后变了而适配器不用改，就重发同一个数字、换 metadata，不升号。兼容性由平台 major.minor 的启动 warning 与 `pg.*` 的 `v` 字段决定。
- 0.1.0 只是脚手架留在 `package.json` 里的一个字符串：没有版本常量、没有 tag、没有任何地方报告它。本文件从 0.2.0 开始记账。

---

## v0.6.0+platform.0.2.0（2026-11-02，与平台 0.2.0 配套）

**适配器的 minor。** `0.5.2 → 0.6.0`，平台不动（仍是 `0.2.0`）。工具面新增一员，所以按本文件
的版本策略升 minor。

**问题（真机试用 + 上级否决）。** 以前根必须由人装配：人起平台、`POST /v1/bootstrap`、再带
`PIGROUPS_URL` / `PIGROUPS_TOKEN` 启动 pi。没有这两个变量的会话**一个工具都没有**——skill
装着、模型却只能退回 `subagent`，而且没有人当场发现。上一版只加了 skill 守卫（"明说你不是
成员"），这一版把"自己把组织开出来"变成工具。

**根不再需要环境变量。** `PIGROUPS_URL` / `PIGROUPS_TOKEN` 从这一版起只是"别人已经给了你
身份"时的入会方式，不是带队的前提：装上包、起 pi、让 agent 开一个组织，平台由 agent 自己
拉起，`org.json` 由它自己写。人不必先起平台，也不必先知道端口和 token。

**拿身份入会的成员仍然要那两个变量。** 由人（或 `pg_spawn` 的父成员）把 `PIGROUPS_URL` +
`PIGROUPS_TOKEN` 放进环境的会话，启动时就有十个成员工具，**没有** `pg_org_start`；它不需要
平台代码，也不该再开第二个平台。两条路的区别只在这里，之后的工具、循环、投递完全一样。

**新增 `pg_org_start(name?, port?, data_dir?, platform_dir?)`。**

- **只在没有身份的会话里注册。** 有 `PIGROUPS_URL` + `PIGROUPS_TOKEN` 的会话**不注册**它：
  一个已经是成员的会话若能再开一个平台，就会出现两个 poll 抢同一个 token（平台对同成员的
  并发 poll 回 409），或者把原来的组织丢在没有会话可达的地方。这个决定写进了工具描述。
- 没有身份时它是**唯一**的工具：不轮询、不联网、不注册别的工具，直到它被调用。
- 幂等：`<adapterDir>/org.json` 记录 `{url, token, admin_token, pid, data_dir}`；平台还健康、
  token 还能认证就**重接**，不启动第二个平台。并发调用用 `<adapterDir>/org.lock` 串行化。
- 找平台代码：`platform_dir` → `PIGROUPS_PLATFORM_DIR` → 适配器仓库旁的 `../PiGroups` →
  `../../PiGroups`；判据是 `src/main.ts`。全找不到时错误列出每一个候选路径与来源。
- 起平台：`node <platform>/src/main.ts`，detached + unref，stdout/stderr 进
  `<data_dir>/platform.log`，env 带 `PORT`、`PIGROUPS_DATA`、生成的 `PIGROUPS_ADMIN_TOKEN`。
  **平台比根 session 活得久**：`session_shutdown` 只停循环，不碰平台。
- 失败清理：bootstrap 失败（或 health 超时）会停掉刚起的平台，不写 `org.json`，错误里带 pid
  与日志路径。记录里的 pid 仍然活着但不答 health 时，先确认它确实是本平台再停；确认不了就
  报错拒绝在同一个数据目录上起第二个进程。
- 成功后构造与普通成员相同的 `PiSurface` / `PgClient` / `Herdr` / `AdapterLoop`，注册其余
  十个工具，并当场启动循环。

**与平台 0.2.0 配套，平台不需要改。** 用到的只有 `GET /v1/health`、`POST /v1/bootstrap`
与既有的 `GET /v1/whoami`，启动环境变量 `PORT` / `PIGROUPS_DATA` / `PIGROUPS_ADMIN_TOKEN`
也都是平台 0.2.0 已经支持的。平台 §10.2 里 `bootstrap` 不校验 admin token，适配器仍把它作为
Bearer 发出去——将来平台加上校验也不用改适配器。`+platform.0.2.0` 只记录验证过的平台
（`210ed07`），不是兼容门。

**接口变化。**

| 接口 | 变化 |
|---|---|
| 工具面 | 新增 `pg_org_start`；**只注册在没有身份的会话里**（成功之后它仍在这个会话里，再调只回答 `already_member`）；用两个环境变量启动的成员会话没有它，仍是十个工具 |
| `PgClient` | 新增 `bootstrap({name?})`（`POST /v1/bootstrap`，平台 §10.2） |
| `src/org.ts` | 新模块：`startOrg`、`findPlatformDir`、`platformCandidates`、`readOrgState`、`OrgStartError`；不依赖 pi |
| `src/extension.ts` | 工厂从"无配置直接 return"改成两条路：有身份 → 十个成员工具 + `session_start` 启动；无身份 → 只注册 `pg_org_start`，成功后补注册并启动 |

**测试。** 125 → 132 条，`npm run typecheck` 干净，`npm test` 132/132。新增七条，全部在旧
`src` 上真红过（每次只改一处 `src`，跑 `test/orgstart.test.ts`）：

| 守的行为 | 只回退哪一处 | 红在哪 |
|---|---|---|
| 无身份会话只有 `pg_org_start` | 工厂恢复成无配置 `return` | "the extension must register pg_org_start" / 工具列表为空 |
| 有身份会话没有 `pg_org_start` | 注册成员工具时不注册 | "the configured surface is still the ten member tools" |
| 开组织后成为根、工具补齐、循环在跑 | 不构造 `AdapterLoop` / 不 `start()` | "the adapter state exists, so start() ran" |
| 第二个会话重接同一个平台 | 跳过 `org.json` 的 health+whoami 分支 | "the URL did not move: no second platform was started" |
| 找不到平台时列全候选 | 错误只报第一个候选 | "the message lists /tmp/…" |
| bootstrap 失败杀掉刚起的平台 | 去掉 catch 里的 `stopChild` | "the platform at http://… is still answering" |
| 记录里的 pid 不是本平台时绝不发信号 | `looksLikePlatformProcess` 直接返回 true | 测试进程自己收到 SIGTERM，整份文件 "test failed" |

**文档与 skill。** `docs/概念稿.md` 把"开组织"写成与"拿环境变量入会"并列的入会路径，并重写
§7.4（开组织不是注册成员）；`docs/设计说明.md` 新增 `pg_org_start` 的步骤、`org.json`、生命周期
与失败模式（§8.2–8.5）；README 的 quick start 改成"装包、起 pi、让 agent 开一个组织"；两个
skill 的守卫改成三态（成员 / 只有 `pg_org_start` / 一个都没有），`pigroups-org` 增加 §0
"根的第一件事"。真机探针另发现两处文档与实现不符——`pg_org_start` 成功后仍留在同一会话里，
以及删 `org.json` 并不阻止第二个进程写同一个库——两处都按实际行为改正（概念稿 §7 末、
设计说明 §8.4、`pigroups-org` §0）。

---

## v0.5.2（2026-11-02，与平台 0.2.0 配套）

补丁。修一次真实试用暴露的问题：**skill 被加载了，而 `pg_*` 工具没有**（那个会话启动时没有
`PIGROUPS_URL` / `PIGROUPS_TOKEN`，适配器按设计不注册任何工具）。模型于是安静地用 `subagent`
代替了组织——人以为在用 PiGroups，其实没有。

两个 skill 的第一段现在带守卫：看不到 `pg_*` 工具就**明说"这个会话没有加入 PiGroups"**，
不许用 subagent 模拟，不许静默降级。

---

## v0.5.1+platform.0.2.0（2026-11-02，与平台 0.2.0 配套）

**适配器的 patch。** `0.5.0 → 0.5.1`，平台不动，接口与文档化的行为不变——只修一个投递层的 bug。

**丢了什么、什么时候丢的。** 0.5.0 的“abort 兜底”只有一个副本槽位（`lastDelivered`）。同一轮里
两个窗口各投了一批时，第二个成功投递会覆盖第一个；这时 abort，只有最后一批被放回队首。
前一批的 journal 已提交、水位已推进、平台已取走，于是**永久消失**。触发条件是一轮活得比一个
窗口还长（长工具）且中途来了两批消息。第一次测到是 2026-11-01 的 v3 验证
（`probe/logs/v3-20261101T173805Z/extra-multibatch-loss.txt`：`#2` 出现两次，`#1` 一次都没有），
当时按“取证阶段不改 `src/`”记成已知缺口。

**修法。** 槽位换成**未确认批次表**（`unacknowledged: PendingDelivery[][]`，按投递顺序）：

- 每次成功 `deliver` 追加一批；
- `turn_end` 干净结束 → 清空整张表（pi 落盘了）；
- `turn_end` 带 provider error → 保留整张表（没证明落盘就不丢，下一次 abort 一起重投）；
- `turn_end` aborted → 每一批按投递顺序平铺回队首、窗口标成立即到期、绕过水位，和原来的单槽位路径一样；
- 上限 8 批（默认窗口下约八个窗口、最多 80 条），超出丢**最旧**的一批并 `console.warn`——
  不设上限则一个永不结束的回合会让内存无限长大。

**测试。** 123 → 125 条，`npm run typecheck` 干净，`npm test` 125/125。新增两条，都在旧单槽位上真红过：

- `two batches steered into one still-running turn are both re-sent, in delivery order, when that turn is aborted`
  ——旧代码上重投只有 `[dm:…#2] root: batch two`，断言 `batch one must be re-delivered` 红；
- `the unacknowledged list is capped: a turn that outlives the cap loses only the oldest copy`
  ——九批进一轮，abort 后只重投第 2–9 批。

**真机复验。** `probe/logs/requeue-multi-20261101T175812Z/`：60 s 的 bash 工具里两次投递（水位 1 → 2），
`pg.abort` 后 54 ms pi 落盘**一条** `custom_message`，`#1` 在 `#2` 前面；模型正文点名了两个 marker。
清理后 pane 列表与运行前一致。

---

## v0.5.0+platform.0.2.0（2026-11-02，与平台 0.2.0 配套）

**适配器的 minor。** `0.4.0 → 0.5.0`，平台不动（仍是 `0.2.0`）。依据是概念稿 v3（§7 工具面、§8 投递）
与 2026-11-01 的 steer/abort 真机实验（`probe/logs/steer-20261101T170244Z/`）。这一版**改了接口**，
不只是改了行为：

| 接口 | 变化 |
|---|---|
| `PiSurface` | **新增 `lastAssistantText(): string \| undefined`**（由 pi 的 `message_end` 维护） |
| `PiEvent` | `turn_end` 新增 `aborted?: true`。投递层只对这个值做重投；provider error 不算 |
| `DeliverKind` | 新增 `'scheduled'`（`pg_schedule` 的唤醒） |
| `PiLike` | 新增 `on('message_end', …)`；`sendMessage` 的 `deliverAs:'steer'` 从"已声明"变成"真的用" |
| `LoopConfig` | 新增 `deliveryWindowMs`（环境变量 `PIGROUPS_DELIVERY_WINDOW_MS`，默认 60000） |
| `AdapterLoop` | 新增 `members(query?)`、`schedule(afterSeconds, note)`；`InspectResult.last`、`ChildSnapshot.last` 是新字段 |
| `PgClient.tree()` | 返回完整的名册行（`TreeMember`），不再只声明 `id` |

`package.json` 的 `pi` 也变了：`skills: ["./skills"]`，`files` 增加 `skills`。

### 投递：一条队列 + 翻滚窗口 + steer

- **一条队列。** 聊天消息、未知控制项、子成员遥测汇总、催办、预约唤醒、启动简报全进同一个队列。
- **翻滚时间窗。** 第一个 `windowed` 项开窗；`tick()`（已有的 5 秒定时器，没有第二个定时器）发现
  `now - windowStart >= 60000` 时，整批**一次** `deliver`。窗口长度可配。
- **不再等空闲。** `deliver` 走 `pi.sendMessage(…, {triggerTurn:true, deliverAs:'steer'})`。
  `isBusy()` 闸门和"一次 settle 只投一次"整条删掉；settle 不再是投递触发器，它只做名册/pane
  复核、跑一次 `tick()`、标记催办。
- **例外只有三个，都还在同一条队列里**：启动简报不等窗口；abort 之后立刻关窗把排队的东西投出去，
  并把下一批也标成"立即投"——否则"先 abort 再 say"里那条 say 要白等一个窗口；`poll` 401 的
  "token 失效"提示必须在 `stop()` 之前投出去（停下之后一律拒投，见下）。
- **条数只是尺寸阀门。** 一个窗口最多 10 条，剩下的重新开窗、等下一个窗口；条数永远不会触发投递。
- **催办只在安静的窗口投。** settle 只标 `nudgeDue`；队列里有真实消息时，消息就是唤醒。
- **实测边界写进代码注释，不粉饰**：`sendMessage` 返回 = 排队，不是被看到；一条 steer 排在一个
  长工具后面，要等工具返回（+1 ms 才落盘）。所以投递延迟 = 窗口剩余 + 当前工具剩余。
- **abort 丢失的兜底。** 已经交给 pi、但还排在长工具后面的 steer，遇到 abort 会整份 session 文件里
  一次都不出现。现在每次成功投递留一份内存副本（**只留最近的一批**，一个槽位）；`turn_end(aborted:true)`
  时放回队首并立刻重投（绕过水位——水位已推进），干净结束才丢，provider error 结束保留（没证明
  落盘就不丢）。重复注入由正文里的 `[会话#序号]` 兜住；崩溃丢副本最多少一次重投。

### 工具面

- **删掉 `pg_steer`。** 改方向用 `pg_say`；只有 `pg_abort` 能在长工具期间改变一个成员的行为。
  线协议里的 `pg.steer` 仍兼容，但它**不再先 abort**，而是和普通项一样走投递窗口。
- **新增 `pg_members(query?)`。** 平台名册：id、名字、`parent_id`、`parent_name`、`relation`
  （`self|parent|child|sibling|peer`）、`child_count`、`last_seen_at`，外加 `total`/`matched`。
  `query` 只按名字做大小写不敏感子串；`total: 23, matched: 0` 让模型知道是筛错了而不是没人。
  工具描述明说 **`last_seen_at` 是最近一次鉴权，不是存活**。
- **新增 `pg_schedule(after_seconds, note)`。** 一次性唤醒：5 秒–24 小时，最多 8 条待触发，只在
  进程内；到点入投递队列（`[scheduled] note`），**不绕过窗口**；重启即失。
- **`pg_children` / `pg_inspect` 带 last 块。** 最后一条助手正文（截断到 500 字）与最后一个完成的
  工具调用（名字、参数预览、`ok`）。子成员的 `pg.attention` 也带同一块——父终于能在 `pg_abort`
  之前看到子成员最后一轮在做什么（概念稿 §8.5）。

### 两个 skill

`skills/pigroups-org/SKILL.md`（怎么带组织：写不需要追问的简报、按名字起名/找人、读遥测、
何时 inspect/abort/terminate、何时自己干、不要轮询）与 `skills/pigroups-message/SKILL.md`
（怎么说话：任务由消息关闭、用前缀里的会话 id 认会话、`mentions` 只覆盖自己的群、一对一可对任何人、
不要轮询、不要复述对方已知的事）。两个都在 `package.json` 的 `pi.skills` 里注册，并随包发布。

### 测试与变异证明

- **103 → 123 条**，`npm run typecheck` 干净，`npm test` 123/123。新增 19 条：
  `delivery` +4（窗口合并、忙碌时 steer、abort 重投、provider error 保留副本）、`control` +3
  （abort 关窗、abort 后 say、steer 不再 abort）、`telemetry` +3（last 块、截断、父侧汇总）、
  `surface` +1（`message_end`）、`members` +3、`schedule` +3、`toolsurface` +1（十个工具、没有
  `pg_steer`）。发版前再补 1 条（到 123）：`poll` 401 的提示必须先于 `stop()` 投出去——0.5.0 的
  `stopped` 闸门让旧写法永远发不出去，而且是静默的。
  改写的是行为真的变了的那些：投递不再等空闲、settle 不再投递、催办按窗口、遥测的 gone 仍等窗口、
  journal 重放也走窗口。
- **变异证明（只回退 src，保留测试，全部当场红过）：**
  1. 把 `isBusy()` 闸门加回 `deliverPending` → `a busy member still receives the window batch` 与
     条数阀门用例红。
  2. 去掉 `deliverAs:'steer'` → `deliver … as a steer` 红。
  3. 删掉 abort 之后的 `flushOutcome(true)` + `windowImmediate` → `control` 三条红（abort 关窗、
     abort 后 say、abort+steer 同批）。
  4. 把 `turn_end` 的 aborted 分支改成只丢副本 → `a batch delivered into an aborted turn …` 红。
  4b. 把"只有干净结束才清副本"改成"任何非 abort 结束都清" → `a batch delivered into a
      provider-error turn is kept …` 红。
  5. 让重投走 `enqueue`（被水位挡下）→ 同一条红。
  6. 把 `pg_steer` 工具加回去 → `toolsurface` 红。
  7. 把 `pg.steer` 的"忙就先 abort"加回去 → `pg.steer no longer cuts a busy member` 红。
  8. `pg_members` 的 query 改成大小写敏感 → `a query filters by name, case-insensitively` 红。
  9. `pg.attention` 不带 last → `telemetry` 两条红；`inspectSelf` 不带 last → `tools` 红。
  10. 去掉 `message_end` 订阅 → `surface` 的 last 用例红。
  11. `pg_schedule` 的下界改成 0 → 边界用例红；让 due 的 wake 带 `windowless` → `a due wake …
      waits for the delivery window` 红。
  12. 三个版本号改一个 → `version` 红；删掉 `pi.skills` → `package` 红。
  13. 把 401 的处理改回"先 `stop()` 再入队" → `a 401 from poll hands the model the token line before
      the loop stops` 红在 `timed out after 5000ms waiting for: the token line to reach the model`。

### 已知边界（不是这一版能修的）

- **窗口让重放和唤醒都慢一拍。** 崩溃恢复的 journal 批次、到点的 `pg_schedule`、以及遥测汇总，
  都按窗口走（启动简报除外）。这是"一条队列"的直接代价，不是遗漏。
- **确认边界没有收紧。** `deliver` 返回仍只表示 pi 收下了（D2）；这一版只是把"abort 会丢"这一种
  实测到的丢失补上了。
- **副本只有一个槽位。** 同一轮里两个窗口各投了一批、然后 abort，只有最后一批会被重投。触发条件
  是"一轮还没结束、第二个窗口又关了"。修法是把槽位换成未确认批次表，需要一条新测试；这一版没做，
  记在 `docs/handoff.md` §7。
- **`dm:` 不是发送地址。** 注入前缀里的 `dm:<a>_<b>` 只能用于 `pg_read` 认会话；说话要发给对方
  的成员 id。skill 里写清了，工具 schema 没有改（平台契约就是这样）。

---

## v0.4.0+platform.0.2.0（2026-11-01，与平台 0.2.0 配套）

**一次只动适配器的 minor。** `PIGROUPS_SPAWN_CMD` 的默认值变了，这是操作者可见的行为变化，所以 `0.3.0 → 0.4.0`；平台不动，仍是 `0.2.0`。版本串带 build metadata `+platform.0.2.0`：**它只记录这一版在哪个平台上验过，不参与任何判定**——兼容性由启动 warning 和 `pg.*` 的 `v` 字段决定，平台以后变了而适配器不用改，就重发同一个数字、换 metadata。

**关于两个标签。** `0.4.0` 当天先切过一版（标签 `v0.4.0`，spawn 默认带 `-ne`，`pg_spawn` 镜像 pi 的七个启动旗标）。那一版的设计被否掉了：镜像整组删除、`-ne` 也去掉。所以最终内容用同一个数字重切，标签带上 metadata：**`v0.4.0+platform.0.2.0`**。旧标签不移动、不删除（它记录的是被否掉的那次尝试），对外认这一版就看新标签；`git describe --tags` 现在是 `v0.4.0+platform.0.2.0`。

### 操作者得到什么

- **零配置 spawn。** `PIGROUPS_SPAWN_CMD` 不再默认成裸 `pi`。`src/extension.ts` 用 `import.meta.url` 取自己被加载的绝对路径，默认 `pi -e '<绝对路径>'`。忘掉 `-e` 不会再得到一个“建了成员、开了 pane、但不说话”的空子进程。`PIGROUPS_SPAWN_CMD` 仍是逃生口，显式值完全替换默认（连空格路径的引号一起）。命令按 shell 引号规则切词（`src/command.ts`），路径含空格时仍是一个参数；`pane send-text` 兜底把同一条命令交给 shell，追加的每个 `args` 元素也按同一规则加引号。
- **子成员是一个正常 agent，不是被剥过皮的 worker。** 默认命令**不剥离任何东西**——`-ne` 只出现在被否掉的旧设计里。子成员按正常 pi 启动，继承操作者的扩展、技能、prompt template、MCP server 与 `AGENTS.md` 等上下文——它就是坐在 pane 里的另一个你，只是带着 `pg_*` 工具和成员身份。第一次第 4 级 run 里某个全局扩展把消息转进了主会话，那是探针环境噪声（操作者已禁用那个扩展），不值得为它牺牲整套继承。
- **`pg_spawn` 只透穿，不镜像。** 参数集合是 `{ name?, brief, cwd?, args?: string[] }`，`args` 是原始 pi argv 尾巴，按顺序追加在基础命令之后：**基础命令 → 每一项 `args`**，不是字符串拼接。`model` / `thinking` / `tools` / `exclude_tools` / `extensions` / `skills` / `prompt_templates` 这层镜像整组删掉了：多一层翻译没有增加信息，而 pi 的旗标远多于任何一张我们会维护的表——每加一个旗标都要适配器发版。模型不知道怎么写旗标就去读 **`pi --help`**，那才是 pi 的手册，不是这个 schema。
- **`args` 不消毒。** 调用方可以传 `-p`、`--` 或任何改变子进程启动方式的旗标，适配器不拦也不改写——透穿就是契约，选择权在调用方。代价要说清：`--tools read` 这类允许清单也会把适配器自己的 `pg_*` 工具挡掉，于是那个成员**只能听、不能说**（真机 case 2 就是这样，它自己也这么解释）。传错旗标时子进程可能起不来或进入非交互模式，错误由子进程自己的输出暴露，适配器不预检。
- **启动兼容性 warning。** 平台答完后，`platformCompatibilityWarning()` 把 `who.server.version` 的 major.minor 与 `SUPPORTED_PLATFORM_MINORS = ['0.2']` 比较：不在列表只打一条 warning（同时写平台版本和适配器版本）然后继续，匹配则什么都不打。判定是纯函数，`init()` 只调用一次；平台不可达不在这里 warn，交给循环的退避/上报。
- **pi 包清单。** `package.json` 有 `pi.extensions = ["./src/extension.ts"]`、`keywords: ["pi-package"]`、`description`、`license`、`repository`，`files` 只留 `src` / `README.md` / `CHANGELOG.md` / `docs`；仍是 `private: true`、无运行时依赖。

### 真机验过什么（2026-11-01，pi 1.4.0 / herdr 0.9.5 / node v26.12.1）

一次性平台 `0.2.0`，端口 41777 / 41778，**全程未设 `PIGROUPS_SPAWN_CMD`**，所以走的就是上面的默认。两个 case 都 **PASS**，证据在 `probe/logs/spawn-args-20261101T142926/report.md`（主，run B）与 `probe/logs/spawn-args-20261101T142109/`（run A）：

| case | 观测 |
|---|---|
| 只给 `name`+`brief` | root 的 toolCall 实参只有这两个键；子成员启动行是 `pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts`（pane 自己的回滚，不是 `/proc` 猜的；pi 启动会把 `process.title` 改成 `pi`，`/proc/<pid>/cmdline` 只剩 `pi`）；它收到 brief、调 `read`、`pg_say`，human API 读到那句话 |
| `args:["--tools","read"]` | 启动行是 `pi -e …/src/extension.ts --tools read`；子成员的 `builtinTools` 只剩 `read`，`toolCalls` 为空，`touch` 的标记文件不存在，它用自己的话解释“没有 bash 工具所以跑不了” |

“继承”是**看见的**，不是推的：不隔离的子成员启动 banner 列 11 个扩展（只有 `extension.ts` 来自适配器）、会话启用 15 个内置工具；同一台机器上用 `-ne` 的对照只列 `extension.ts` 与 `read,bash,edit,write`。`-ne` 会关掉发现但保留显式 `-e`，所以这份对照同时证明“`-e` 生效”和“没有加 `-ne`”。

另有一种比真机更省事的打包证明，随标签一起提交：`probe/logs/release-0.4.0-plat0.2.0-20261101T224511/`。tarball `pigroups-adapter-pi-0.4.0+platform.0.2.0.tgz`（16 个文件；shasum 记在该目录的 `NOTE.md`——tarball 里装着这份 `CHANGELOG.md`，把 shasum 写进来就会改掉它）解包后：20 条相对 import 全部解析到包内文件、入口 `default` 是扩展函数；再用 pi 直接加载解包副本，verbose banner 的 `[Extensions] → path` 列出那份 `src/extension.ts`，`--mode json` 的 stderr 打出 `[pigroups] adapter 0.4.0+platform.0.2.0 starting against …`（退出 0）——说明整条模块图在 pi 里真的 import 并执行了。

### 测试与变异证明

- **96 → 103 条**，`npm run typecheck` 干净，`npm test` 103/103。新增的 7 条在 `b49e410`（当时是镜像旗标 + 子成员不剥离的覆盖）；`1d3e689` 删掉镜像后总数不变：spawn 套件 7 → 7。删掉三条（逐旗标映射、空旗标时什么也不加且可复现、旧的封闭 schema）；留下并把宿主字符用例改成空格/`$`/引号/分号；新增两条：schema 恰好是 `name`/`brief`/`cwd`/`args` 且指向 `pi --help`、`command.ts` 只剩引号与切词不再导出旗标镜像。
- 删镜像的变异：只把 `src/command.ts`、`src/extension.ts` 退回 HEAD（保留测试），两条新用例立刻红——`the pg_spawn schema is exactly name, brief, cwd and args…` 的 actual 是 11 个参数（`exclude_tools` … `tools`）、`the command module exposes quoting only…` 的 actual 是 `['SPAWN_THINKING_LEVELS','shellQuote','spawnFlagArgs','splitCommand']`。恢复后两条复绿。
- 0.4.0 原有的变异也留着：撤掉自加载默认 → `the child starts without the operator’s global extensions` 红；换回朴素按空白切词 → 空格用例红在“4 段而不是 1 段”；删掉启动 warning 的调用 → 不支持平台用例红在 `exactly one warning, got []`；让支持版本也命中 warning → 2 条红；改三处版本号之一 → 各自 1 条红（`package.json must say what src/version.ts says` / `the lockfile carries the same version`）。

### 没做的（都记在 `docs/handoff.md` §7）

- **`pg_spawn` 对健康的子成员报错。** 两次真机调用都返回 `isError=true` / `timed out waiting for agent status`（134 s、124 s），而子成员当场正常工作。根因是 `HerdrCli.waitReady()` 只发 `--until idle`，pi 跑完一轮后 herdr 记的是 `agent_status:"done"`；`--until idle --until done` 立即返回。修法短，但是行为改动 + 一条测试，留给下一轮。
- **收窄工具会连 `pg_*` 一起收窄**：`--tools` 是允许清单，`args:["--tools","read"]` 的成员只能听、不能说。这是调用者的选择，文档写清，不改实现。
- 平台兼容性只是 warning；`SUPPORTED_PLATFORM_MINORS` 仍要随实际验证过的平台手动扩展。`ctx.shutdown()` 的 print/json 模式路径仍未实测（TUI/SIGTERM 与 `sys.terminated` 自调用都验过）。

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
