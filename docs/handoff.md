> **启动协议交接补充（适配器 0.15.0 / 平台 0.7.0，已实现）**：下文是历史记录。当前契约：
> 平台用 `endpoint.json` 的 `wx` claim 做首次启动的端口会合点（无 `.start.lock`），空数据根必须显式
> `PIGROUPS_PLATFORM_ID`，0.2 旧库只人工搬迁；适配器的记录路径不再调 `startOrg`，只有 root 在 loop
> 里 ensure；respawn 启动自动、运行时手动，pane 是唯一“在跑”证据，心跳不判死；一个成员一个
> `consumers/<sha1(token)>.json` 租约。以 `docs/设计说明.md` §8/§12 为准。

# 交接文档


> **启动协议交接补充（适配器 0.14.0 / 平台 0.6.0，已实现）**：下文是历史记录，其中"单个
> `<adapterDir>/org.json`"、"固定端口重启"、"随机选空闲端口"、"health 不答即杀进程"等描述属于当时的行为。
> 现在的契约见《概念稿》§7.4 与《设计说明》§8.2–8.5：
>
> - 平台自己 `listen` 并一直持有，端口就是单实例锁；绑定成功后、打开数据库之前写
>   `platforms/<platform_id>/endpoint.json`（`{platform_id, port, version, pid, updated_at}`）。
> - 适配器只给**起始候选**（`port` 参数；已有组织用 `org.json.url` 或 endpoint 的端口），
>   每轮读 endpoint 发现实际地址，验证 `platform_id` 与正常 health 后才 bootstrap / 重接，
>   并在端口变化后更新 `org.json.url`。
> - 同一平台已经在服务时，新拉起的进程以退出码 `2` 退出；适配器把它当作重接信号。
> - 适配器不再对记录的 pid 发信号；瞬时 health 失败不判成员死亡、不杀平台、不重发 token。
>   没有 `platform_id` 的旧记录只能重接，不能重启。
> - 端口冲突由平台判定：同平台 → 退出 2；确定是别的服务 → 前进一个端口；两次都问不到 → 拒绝启动。
>
> 本轮两仓都有实现与黑盒测试；没有在 live quant 组织上做真机升级验证。

> 写于 2026-10-31，更新于 2026-11-01（补 §3.5 真机探针结果、§3.6 第 4 级端到端，改写 §2 / §4 / §7 / §10，补 §8 的版本与发版；同日第二轮探针把第 2 级降为部分通过，并证明第 3 级的 await；第 4 级主链路已在真机上跑通，整级仍是**部分通过**：只跑了 1 个子成员，且判据事后改过两次——两处都在 `de48904` 里，**不在**记录那次 run 的 `3919467` 里，§3.6 原先记错了，本版改正。第四、五轮留痕见 §11，第五轮审阅后的修复见 §12。**第六轮同日：修 A–D（§13），并把 A 放到真机上复跑四轮——子成员能在 5 s 内退出时成立，卡在长工具里时 `pane close` 仍会切掉活着的 agent（§3.7）。适配器单独发 `v0.2.1`，平台仍是 `0.2.0`（§8）。**第七轮同日：修 E–F（§14），把“先切断正在跑的那一轮，再收尾”写进 `sys.terminated`，并让强制关 pane 不再伪装成干净关闭；上一轮唯一失败的 `bash sleep 40` 真机复跑现在 3/3 PASS，5 s 硬上限不再是常态路径，但仍是兜底（§3.8）。适配器单独发 `v0.3.0`，平台仍是 `0.2.0`（§8）。**第八轮同日：spawn 默认改成自加载本扩展（`pi -ne -e <自身绝对路径>`），启动时对平台 major.minor 只 warn 不拒绝，适配器成为带 `pi` manifest 的包；版本 `0.4.0+platform.0.2.0`（metadata 只记录测试对象，不参与判定）。适配器单独发 `v0.4.0`，平台仍是 `0.2.0`（§8）。**第九轮同日：把 spawn 默认纠回正常 pi（`pi -e <自身绝对路径>`，去掉 `-ne`）。`pg_spawn` 先试过镜像 model/thinking/tools/exclude_tools/extensions/skills/prompt_templates，随后按老板的意见整组删掉，只留原始 `args` 透穿——不知道旗标就读 `pi --help`；适配器 103/103，版本仍是 `0.4.0+platform.0.2.0`。**第十轮同日：`args` 透传在真机上验过——只给 name+brief 的子成员是正常 pi（`pi -e <本扩展>`，无 `-ne`），`args:["--tools","read"]` 真的到 pi（内置工具只剩 `read`，它自己说跑不了 bash），两个 case 都 PASS；附带复现了 `waitReady()` 只等 `idle`、对 `done` 永远超时的既有 bug（§15）。**第十一轮同日：发版。** 版本仍是 `0.4.0+platform.0.2.0`（三处一致），`npm pack` 出 16 个文件，解包副本的 20 条相对 import 全部解析、入口能 import、pi 的 verbose banner 列出解包路径、`--mode json` 的 stderr 打出启动行（退出 0）；标签 `v0.4.0+platform.0.2.0` 打在携带证据的提交上（§8）。**第十二轮（2026-11-02）：按概念稿 v3 换掉投递核心（§16）——一条队列 + 翻滚窗口 + `deliverAs:'steer'`，`isBusy()` 闸门与“一次 settle 只投一次”整条删掉；工具面删 `pg_steer`、加 `pg_members`/`pg_schedule`；遥测与 inspect 带 last 块；两个 skill 进包。真机 A–D 全 PASS（长工具中投递、abort 后重投、名册/预约、skill 被发现），证据 `probe/logs/v3-20261101T173805Z/`；发版证据 `probe/logs/release-0.5.0-20261101T175209Z/`。适配器 `0.5.0+platform.0.2.0`，平台仍是 `0.2.0`（§8）。**第十三轮（2026-11-02）：0.6.0——根自己开组织（§2.4、§3.9）。** 无身份会话只注册 `pg_org_start`：它找平台代码、必要时 detached 起平台、bootstrap 出根、写 `<adapterDir>/org.json`，成功后补注册十个成员工具并当场启动循环；平台比根 session 活得久，下一次会话重接而不是再起一个。真机 5/5 PASS（无身份起根 → 子成员进同一平台 → 杀根后组织仍活 → 新会话重接且只有一个平台进程 → 清理干净），证据 `probe/logs/org-start-20261102T150800Z/report.md`。适配器 `0.6.0+platform.0.2.0`，平台 `210ed07` 未动（§8）。**）
>
> 两个人（或一个人隔几天回来）之间交接用。
> 面向：接手「把 PiGroups 在 herdr + pi 上真机跑起来」这件事的人。
>
> **本文档描述的是 `v0.6.0+platform.0.2.0` 这一对**：平台 `0.2.0`（未签名 annotated 标签 `v0.2.0`，`1d68dd4`，代码停在 `210ed07`）+ 适配器 `0.6.0+platform.0.2.0`（未签名 annotated 标签 **`v0.6.0+platform.0.2.0`**，钉在携带发版证据的提交上，`git rev-parse 'v0.6.0+platform.0.2.0^{}'`）。上一版适配器是 `v0.5.2`（skill 守卫的补丁）；再上一对是 `v0.5.0+platform.0.2.0`，更早的 `v0.4.0` 指向被否掉的那一版（默认带 `-ne`、`pg_spawn` 镜像旗标），都不移动、不删除。这是又一次**单侧发版**：只有适配器动了，所以只有它进号（minor：工具面新增 `pg_org_start`，无身份会话的注册行为改变），平台保持 `0.2.0`（§8）。metadata 只记录这一版验证过的平台，不参与判定。号住在哪、怎么发下一版、以及本轮实测到的问题，见 §8。

---

## 1. 一句话现状

**两个仓库都已建成、全绿、经过五轮独立评审和变异测试（第四、五轮留痕见 §11，第五轮修复见 §12）；三条 pi 接口假设已于 2026-11-01 在真机（pi 1.4.0 / herdr 0.9.5）上验过：第 1 级通过；第 2 级只对“配合的工具”通过（pi 不会杀一个忽略 abort signal 的工具）；第 3 级只过了 SIGTERM/tui 这一条路径，且这次用 3 s 异步体 + `process.on('exit')` 证明了处理器确实被 await；第 4 级端到端主链路通过（整级仍是部分通过，理由见 §3.6）。** 抓到的真偏离（`pg.abort` 之后没有 turn_end）已由 `abecc76` / `fff2418` 修掉。

**第 4 级不是“全过”，状态统一为“部分通过”。** 第一次真机 run 抓出两处：模型侧没有 `pg_report` 工具（只有 9 个工具，规范也只列了 9 个），以及删除后子 pane 没人关。后者已由 `9453f6d` 修掉并在真机复跑确认；前者是产品缺口，但**不是**第 4 级的判据——那次 run 的判据被改过两次（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说了一句话），两处都在事后单独的 `de48904` 里，**不在**记录那次 run 的 `3919467` 里（`3919467` 连判据那一行都没动，§3.6 原先把它记成“记录 run 的同一个提交”，本版改正）。整级仍是部分通过，因为只跑了 1 个子成员，判据也是事后改的。详见 §3.6 与 §4。

下一步：**先把 `pg_report` 定为“加第 10 个工具”还是保持“汇报=说话”**（它不再是第 4 级的判据，但仍是产品缺口）；补第 3 级剩下的 print/json 模式；再把第 4 级从 1 个子成员扩到 2 个并验重启/级联。第 2 级的“不配合工具”是 pi 的接口边界，不要再改循环去追。

**第十二轮（2026-11-02）：投递换成“一条队列 + 翻滚窗口 + steer”。** 概念稿 v3 把“什么时候把东西交给模型”重写成一条队列加一个翻滚时间窗（`PIGROUPS_DELIVERY_WINDOW_MS`，默认 60 s）：第一个入队项开窗，`tick()`（还是那个 5 s 定时器）关窗，整批一次 `sendMessage(…, {triggerTurn:true, deliverAs:'steer'})`。投递不再等空闲，`isBusy()` 闸门与“一次 settle 只投一次”删掉，settle 只剩复核与标记。两条实测边界照实写进代码和文档：交给 pi、还排在长工具后面的 steer 要等工具返回才落盘（+1 ms）；它若在那一刻遇上 abort 会整份消失，所以投递层留内存副本、`turn_end(aborted)` 时重投。工具面删 `pg_steer`，加 `pg_members`（`last_seen_at` 明说只是最近一次鉴权）与 `pg_schedule`（5 s–24 h、最多 8 条、只在内存里）；`pg.attention` / `pg.inspect_result` 带 last 块（最后一条助手正文 + 最后一个完成的工具调用）。两个 skill（`pigroups-org`、`pigroups-message`）随包发布并被 pi 的加载器读出。证据在 `probe/logs/v3-20261101T173805Z/`（§3.3、§16）；仍未合的洞是“同一轮里两批投递遇上 abort 只重投最后一批”（§7）。

**上一轮“关 pane 切掉活 agent”那条已经不再是常态**（§3.8）：根因是 `sys.terminated` 只丢 journal、停循环、`shutdown()`，从不 `abort()`，而 pi 的 shutdown 会等正在跑的工具。`25b8c1b` 让终止路径先按 `pg.abort` 的同一条 3 s 上限切断那一轮，再收尾；`bash sleep 40` 真机复跑从 5031 ms / FAIL 变成 204 ms / PASS（工具在 DELETE 后 3 ms 收到 `Command aborted`，pi 在 close 前 86 ms 已退出）。**仍未关**的是接口边界而非这条竞态：一个完全忽略 abort signal 的工具仍可能拖过 3 s，那时 `Herdr.close()` 会在 5 s 到点强制关 pane 并报 `forced: true`，`pg_terminate` 把它列进 `pane_close_forced`——可见，但不是干净关闭；`pane list` 读失败时仍是“未知”，pane 映射仍只在内存里。§7 那一行已按实际覆盖改写。

```
平台仓库  ~/Documents/PiGroups          0.2.0  v0.2.0  57 tests   typecheck 干净  已发版 v0.2.0
适配器    ~/Documents/pigroups-adapter  0.6.0+platform.0.2.0  v0.6.0+platform.0.2.0  132 tests  typecheck 干净  第 1 级通过 / 第 2、3、4 级部分通过
```

两个仓库按**一次发布记一对号**：两边都动就同号，只有一侧动就只动那一侧；现在这一对是平台 `0.2.0` + 适配器 `0.6.0+platform.0.2.0`。号住在哪、怎么发下一版见 §8。

---

## 2. 两个仓库是什么

### 2.1 `~/Documents/PiGroups` — 平台

一个单体服务：一棵成员树、一条「每个节点拥有一个群」的规则、一个取走即消费的收件箱、一条不透明的指令通道。

| | |
|---|---|
| 版本 | `0.2.0`，标签 `v0.2.0`（annotated、未签名）。`package.json` 是唯一真值：`src/version.ts` 直接 import 它，`GET /v1/health` 与每个响应的 `server_version` 都报这个数，没有第二个常量 |
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（实现伴稿）、`docs/参考/`（原始讨论稿） |
| 代码 | `src/` 2105 行，15 个 HTTP 端点，TypeScript + `node:sqlite`；运行时依赖 `hono`、`@hono/node-server`、`zod` |
| 测试 | `test/` 2681 行，57 个黑盒 HTTP 测试 |
| 运行 | `npm run serve`（`PORT` 默认 7717，`PIGROUPS_DATA`，`PIGROUPS_ADMIN_TOKEN`） |
| 提交 | `master`（数量见 `git log`） |

**它不知道 agent 是什么**：不启动、不唤醒、不判断死活、不带 UI、不提供共享文件空间。这些全部划给适配器。

### 2.2 `~/Documents/pigroups-adapter` — Pi 适配器

一个 **Pi 扩展**。装进一个 pi session，那个 session 就成为一个成员。

| | |
|---|---|
| 版本 | `0.6.0+platform.0.2.0`，标签 `v0.6.0+platform.0.2.0`（annotated、未签名；平台仍是 `0.2.0` / `v0.2.0`；上一对是 `v0.5.0+platform.0.2.0`，中间还有 `v0.5.1` / `v0.5.2` 两个适配器补丁，更早的 `v0.4.0` 指向被否掉的那一版，见 §8）。`src/version.ts` 的 `ADAPTER_VERSION` 与 `package.json`、lockfile 三处必须相等（`test/version.test.ts` 会红）；`pg_whoami` 的 `adapter_version` 与启动那一行日志都报它。`+platform.0.2.0` 是 build metadata，只记录测试对象，不是兼容门 |
| 文档 | `docs/概念稿.md`（**权威**）、`docs/设计说明.md`（含 `PiSurface`、`Herdr`、循环、journal、`pg.*` 契约、`pg_org_start`）。包本身是 `pi-package`：`package.json` 的 `pi.extensions` 指向 `./src/extension.ts`、`pi.skills` 指向 `./skills`（两个 skill：`pigroups-org`、`pigroups-message`），`files` 只打包 `src`、`skills`、`README.md`、`CHANGELOG.md`、`docs`（`npm pack` 出 19 个文件） |
| 代码 | `src/` 约 4655 行，11 个模块，**无运行时依赖**（只用 `node:*` 和 `fetch`） |
| 测试 | `test/` 约 5263 行，132 个测试，跑真平台（子进程）+ 假 `PiSurface` + 假 `Herdr` + 假时钟；`test/orgstart.test.ts` 会拿真平台跑 `pg_org_start` 的起/杀/重接 |
| 提交 | `master`（数量见 `git log`） |

```
src/extension.ts   Pi 扩展入口：有身份 → 注册 10 个成员工具并挂 session_start / session_shutdown；
                   无身份 → 只注册 pg_org_start，成功后补注册成员工具并当场启动循环
src/org.ts         开组织：发现平台代码、拉起 detached 平台、bootstrap、org.json、锁与失败清理（不 import pi）
src/surface.ts     PiSurface 接口 + 真实实现（pi 事件 → PiEvent 五态，含 message_end → lastAssistantText）
src/loop.ts        循环：拉取 → 分类 → 投递队列 / 翻滚窗口 → 义务 → 遥测（不 import pi 包）
src/herdr.ts       Herdr 接口 + herdr CLI 实现
src/pgclient.ts    平台 HTTP 客户端（只碰 15 个端点）
src/journal.ts     注入前落盘、投递后提交（按成员分）
src/watermark.ts   注入水位（按成员分，持久化）
src/state.ts       义务表、遥测表、合并窗口
src/version.ts     适配器版本号（唯一来源，与 package.json / lockfile 由测试对齐）
```

**`loop.ts` 不许 import `@earendil-works/pi-coding-agent`。** 这是整个仓库可测的唯一来源。改坏了这一条，测试就退化成"跑一遍真模型看看"。

10 个成员工具：`pg_say` `pg_read` `pg_spawn` `pg_terminate` `pg_whoami` `pg_abort` `pg_inspect` `pg_children` `pg_members(query?)` `pg_schedule(after_seconds, note)`。**无身份会话只拿一个 `pg_org_start`（见 §2.4）；它成功后十个成员工具才出现，`pg_org_start` 仍留在同一会话（pi 不支持注销工具），再调只答 `already_member`。** `pg_steer` 已在 0.5.0 删掉：改方向用 `pg_say`，只有 `pg_abort` 能在长工具期间改变一个成员的行为；线协议上的 `pg.steer` 仍接受，但走投递窗口、不再切断忙碌成员。

### 2.3 接线：默认零配置，`PIGROUPS_SPAWN_CMD` 只是逃生口

子成员不是平台创建的，是适配器的 `HerdrCli` 在 pane 里起一个 pi。0.4.0 起默认命令不再写死成裸 `pi`：`src/extension.ts` 用 `import.meta.url` 取自己被加载的绝对路径，默认是

```
pi -e '<本扩展的绝对路径>'
```

所以操作者不需要记得给 `PIGROUPS_SPAWN_CMD` 加 `-e`。**默认不剥离任何东西**：子成员是一个正常的 pi session，是持久的队友，不是一次性的 subagent；它按正常 pi 启动继承操作者的工具、技能、prompt template、MCP server 与 `AGENTS.md` 等上下文。早期探针里“继承的扩展把消息转进主会话”是测试噪声，操作者已禁用那个扩展；不要为它重新加 `-ne`。父适配器把生效的基础命令传给子成员的环境，孙成员沿用同一条基础命令。

`pg_spawn` **不镜像 pi 的启动参数**。它只接受一段原始 `args: string[]`，按顺序追加在基础命令之后：**`PIGROUPS_SPAWN_CMD` 的基础命令 → `args` 的每一项**。参数是追加，不是字符串拼接。早期版本曾把 model/thinking/tools/exclude_tools/extensions/skills/prompt_templates 逐个翻译成 pi 旗标，已整组删除：多一层翻译没有增加信息，而 pi 的旗标远多于任何一张会维护的表，每加一个旗标都要适配器发版。模型不知道旗标就读 `pi --help`，那是 pi 自己的手册。

`args` **不做消毒**：调用方可以传 `-p`、`--` 或任何改变子进程启动方式的旗标，适配器不拦也不改写——透穿就是契约，选择权在调用方。路径/参数保持为独立 argv，工具 schema 只暴露 `name? / brief / cwd? / args?`，并用 `additionalProperties: false` 拒绝未知参数。命令按 shell 引号规则切词（单引号、双引号、反斜杠），所以路径含空格时仍是一个参数；`pane send-text` 兜底路径把同一条命令交给 shell，也按同样规则解释，并对每个追加元素用同一个 `shellQuote`（空格、`$`、引号、分号不会越界）。

最小形状（手动起的根和子成员一样，都是正常 pi）：

```bash
ADAPTER=/home/yang/Documents/pigroups-adapter
MODEL=deepseek/deepseek-flash

PANE=$(herdr pane split --direction down --no-focus --cwd "$SCRATCH" \
  --env PIGROUPS_URL="$PIGROUPS_URL" \
  --env PIGROUPS_TOKEN="$ROOT_TOKEN" \
  --env PIGROUPS_ADAPTER_DIR="$ADIR" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')

herdr agent start root --kind pi --pane "$PANE" --timeout 60000 \
  -- -e "$ADAPTER/src/extension.ts" --model "$MODEL"
```

如果确实要在基础命令里固定模型（而不是每次 spawn 传参）：

```bash
PIGROUPS_SPAWN_CMD="pi -e '$ADAPTER/src/extension.ts' --model '$MODEL'"
```

显式值完全替换默认值；路径有空格时保留引号。只改这一次 spawn 的旗标应当用 `pg_spawn` 的参数，不必改操作者的基础命令。

### 2.4 quick start：让 agent 自己开一个组织

装包只需要一次（写进 `~/.pi/agent/settings.json` 的就是这一条）：

```bash
pi install /home/yang/Documents/pigroups-adapter
pi list                        # 应看到 pigroups-adapter-pi
```

**根（新路，不需要环境变量）。** 直接起 pi，然后说话：

> 起一个 PiGroups 组织，名字叫 release-2026，然后 …

这个会话启动时没有 `PIGROUPS_URL` / `PIGROUPS_TOKEN`，适配器只注册 `pg_org_start`：不轮询、
不联网、不注册别的工具。模型调它（`name: "release-2026"`）之后：找平台代码（`platform_dir`
→ `PIGROUPS_PLATFORM_DIR` → 适配器旁的 `../PiGroups` → `../../PiGroups`，判据是
`src/main.ts` 存在）→ 必要时 detached 起平台（日志 `<data_dir>/platform.log`）→ 等
`/v1/health` → `POST /v1/bootstrap` → 写 `<adapterDir>/org.json` → 注册十个成员工具并当场启动
循环。**平台进程不随 session 退出**，组织比根活得久。

想先指定平台代码就设 `PIGROUPS_PLATFORM_DIR`；不设就是本仓库旁边的 `../PiGroups`。数据默认在
`PIGROUPS_ADAPTER_DIR`（`~/.pigroups-adapter`）下的 `platform-data`，`org.json` 也在那里。

**成员（旧路，别人给了身份）。** 由人或 `pg_spawn` 把两个变量放进环境：

```bash
PIGROUPS_URL=http://127.0.0.1:7717 PIGROUPS_TOKEN=<member token> \
  pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
```

这个会话启动时就有十个成员工具、**没有** `pg_org_start`，也不需要平台代码。`pg_spawn` 的子成员
自动继承两个变量，树以下不用再配。

**重接。** 再开一个 pi（同一个 `PIGROUPS_ADAPTER_DIR`），同样只看到 `pg_org_start`；调它
（可以不带参数）会读 `org.json`，平台健康且 token 仍有效就回答 `reattached:true`，不启动
第二个平台。根 session 死了、平台还在时也是这样。

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

- 57 个黑盒测试，覆盖 15 个端点的全部承诺
- 变异测试 16 个错误实现，**全部被抓**（含幂等查表顺序、名字唯一索引是否为 partial）
- 我自己另写了 17 + 24 + 10 项探针，独立复核过越权路径（成员带 `all=true` 的 8 种写法全部 403）

### 3.3 适配器侧的具体数字

- 132 个测试：真平台子进程 + 假 `PiSurface` + 假 `Herdr` + **注入的假时钟**（所以催办窗口、stalled 阈值与投递窗口都不用 sleep）
- 新补的 15 条（44 → 59，之后又补 3 条到 62）：`test/surface.test.ts` 新增 3 条（幂等门；该文件共 9 条）、
  `test/surface.abort.test.ts` 10 条（abort/isBusy/shutdown/退订/preview，含 3 s 放弃分支）、
  `test/obligation.test.ts` 新增 2 条（`nudgeOwed` 的 abort 竞态）；三组都做过撤掉源码再跑红的验证
- 第五轮再补 13 条到 75（`obligation` 7、`herdr` 2、`tools` 2、`delivery` 1、`stop` 1），清单与变异证明见 §12
- 版本工作再补 3 条到 78（`test/version.test.ts`：常量与 `package.json`/lockfile 一致、`pg_whoami` 报 `adapter_version`、启动日志那一行）
- 第六轮（A–D）再补 6 条到 84：`test/herdr.test.ts` 1 条（关 pane 前等 agent 退出）；`test/obligation.test.ts` 5 条（启动即欠死对端、坏名册保留上一份好快照、退避内不重读、超时中止请求、`PgClient.tree` 把 signal 传进 `fetch`）。六条都做过“撤掉 src 就红”的验证，数字在 §13
- 第七轮（E–F）再补 4 条到 88：`test/control.test.ts` 2 条（`sys.terminated` 先切断再丢 journal、abort 不回时仍在 3 s 到点收尾）；`test/herdr.test.ts` 1 条（到点 agent 仍在时报 `forced: true`）+ `test/tools.test.ts` 1 条（`pg_terminate` 把强制关闭列进 `pane_close_forced`）。四条都做过“撤掉 src 就红”的验证，数字在 §14
- 第八轮再补 8 条到 96：`test/spawn.test.ts` 3 条（默认自加载、显式 env 获胜、含空格路径不被拆开）；`test/compatibility.test.ts` 3 条（纯判定、支持平台无 warning、不支持平台恰好一条且不重复）；`test/package.test.ts` 2 条（`pi` manifest 指向真实入口、`private` 与打包文件清单）。行为用例都做过“撤掉 src 就红”的验证，数字在 `CHANGELOG.md` v0.4.0
- 第九轮再补 7 条到 103（`b49e410`，当时还是镜像旗标的版本；`1d3e689` 把镜像删掉后仍是 103，spawn 套件 7 → 7，见 §15）：`test/spawn.test.ts` 7 条（默认 `pi -e` 不再带 `-ne`、显式 env 获胜、含空格路径、`args` 按序追加且不注入别的、含 `$`/引号/分号的路径仍是一个 argv、schema 恰好 `name/brief/cwd/args` 且指向 `pi --help`、`command.ts` 只剩切词与引用不再导出旗标镜像）；`test/tools.test.ts` 1 条（`spawnMember` 把原始 argv 传到 pane，并断言无 `args` 时不追加）；`test/herdr.test.ts` 2 条（`agent start --` 后追加 argv、`send-text` 兜底逐个引用）。变异见轮次记录
- 第十二轮（0.5.0）再补 19 条到 122（`8d21f37`）：投递 4、control 3、telemetry 3、members 3、schedule 3、surface 1、工具面 1、另有 2 条落在既有文件；发版前又补 1 条（`poll` 401 的提示必须先于 `stop()` 投出去）到 **123**。变异扫描 12 个**全部被杀**，清单与原文见表：`probe/logs/v3-20261101T173805Z/report.md` §1（窗口恒到期、加回 `isBusy()` 闸门、去掉 `deliverAs:'steer'`、abort 不强制关窗、`turn_end(aborted)` 不复投、`relationOf` 丢 sibling、`pg_schedule` 三条边界、到点预约绕过窗口、`query` 区分大小写、不订阅 `message_end`）。同一轮跑了真机 A–D（§16），基线在跑前跑后都是 `npm test` 全绿、`typecheck` 干净
- 变异测试 17 个，抓 12 个；存活 5 个里 3 个已被后补测试覆盖，剩 2 个（水位按成员、`flush()` 返回值）已补并有变异证明
- 本轮另做 3 个反向变异，全被抓：撤 `turnOpen` 门 → `surface.test.ts` 9 条里 2 条红；撤 `abort()` 放弃时的 warn → `surface.abort.test.ts` 1 条红；撤 `nudgeOwed` 的两处 `aborting` 检查 → `obligation.test.ts` 2 条红。恢复后全绿
- 此前的两轮独立评审：源码侧 3 blocking + 9 should-fix 全部修完；测试侧 11 条覆盖缺口补了 9 条（2 条判定为文档信息不足，明确跳过）
- 第十三轮（0.6.0）再补 7 条到 **132**（`test/orgstart.test.ts`，跑真平台子进程）：无身份只注册 `pg_org_start`、有身份没有它、起组织后成为根且循环在跑、第二个会话重接、候选路径列全、bootstrap 失败杀掉刚起的平台、记录里的 pid 不是本平台时绝不发信号。七条都在旧 `src` 上红过（每次只改一处，表在 `CHANGELOG.md` v0.6.0）。另跑了真机 5/5（§3.9）

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
session 落盘、以及 shutdown 正在跑的一轮。（第六轮已补上其中三条，只剩 print/json，见 §3.7。）

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

### 3.7 关 pane 的真机复跑（2026-11-01，fix A）

**结论：子成员能在 5 s 内退出时成立，卡在一个长工具里时失败。** 这是 §7“关 pane 与子成员
`sys.terminated` 收尾竞争”那一行的复跑，也是 `7ae1adc` 的验收。四次运行各一个目录
（`probe/logs/paneclose-*`）：根由 herdr 起，root `pg_spawn` 出子成员、等它说过话，再
`pg_terminate`；每次只改“DELETE 落地时子成员在做什么”。

| 运行 | 删除时子成员在做什么 | DELETE→`pane close` | 判定 |
|---|---|---|---|
| `paneclose-20261101T205517-idle` | 空闲 | 608 ms | **PASS 8/8** |
| `paneclose-20261101T205921-midturn` | 一轮模型 turn 中 | 4626 ms | **PASS 8/8**（余量 374 ms） |
| `paneclose-20261101T210306-midtool` | `bash sleep 40` 运行中 | **5031 ms** | **FAIL 3/8** |
| `paneclose-20261101T210437-midtool6` | `bash sleep 6` 运行中 | 3825 ms | **PASS 8/8** |

量法：notice 送达用平台 `sys.terminated` 的 `created_at` / receipt 的 `delivered_at`；子 pi 的
生死用 `/proc/<pid>` 每 20 ms 采样；pane 的 agent 状态用 `herdr pane list` 每 40 ms 采样，agent
一消失立刻抓回滚；`pane.close` 用 herdr 服务端日志的微秒时间戳。逐项 PASS/FAIL 由
`probe/paneclose-analyze.mjs` 产出，汇总在 `probe/logs/paneclose-summary.md`。

两个测量细节：`herdr pane list` 报 agent 消失比进程退出晚 22–162 ms（有这一帧的三次运行），
所以正常情况 close 总在 pi 退出之后 20–200 ms；pi 会把自己的 argv 重写成 `pi`，`ps`/`pgrep -f`
认不出来，pid 是用 `herdr pane process-info` + `/proc/<pid>/environ` 的 `HERDR_PANE_ID` 认的。

**PASS 的三次**：pi 先退出、pane 再消失，回滚里有 `To resume this session:`——这句话只在
**非信号**的 shutdown 分支打印（pi 1.4.0 `interactive-mode.js:3465-3478`），所以子成员走的是
`ctx.shutdown()`（本适配器 `sys.terminated` → `discardAndShutdown()` → `surface.shutdown()`），
不是被 SIGHUP 打断。会话 JSONL 每行可解析、以换行结尾，最后一次写入早于进程退出。

**FAIL 的那次**：`13:03:44.335` notice 送达；`13:03:49.340` pane 仍报 `agent=pi working`；
`13:03:49.366` 适配器在 5031 ms 关窗格；`13:03:49.375` 第一次看不到 pi 进程；`13:03:49.389`
herdr 记 `pane session terminated … signal=Hangup`，对 `pane=41` 没有“agent 离开窗格”。会话最后
一条是 `stopReason=toolUse`、没有 toolResult：那一轮被切掉了。修法只是把同一个竞态从 0 ms 推到
5 s，没有消除它。

**#3 与 #4 的对照给出机制**：`sleep 6` 那次工具在删除后 2.5 s **自然结束**（toolResult 写进会话），
之后才有收尾消息与退出。**pi 在 shutdown 时等正在跑的工具，不打断它**——所以“剩余工具时间”
决定你落在 5 s 的哪一边。这同时补上了第 3 级两条原来未验的路径：`ctx.shutdown()` 自调用，以及
shutdown 时正在跑的一轮（#4 等工具跑完才退）。**print/json 模式仍未验。**

**没证明的**：一份模型 turn 就吃掉了 4626/5000 ms（#2），余量并不宽；`pg_terminate` 在 #3 仍返回
`{"terminated":[…],"pane_close_failed":[]}`，调用者看不出子成员被切断；`pane list` 读失败时
`close()` 不等待，直接走关闭（herdr 不可达的情形没有覆盖）。

### 3.8 先切断再收尾的真机复跑（2026-11-01，E–F）

**结论：3/3 PASS。§3.7 唯一失败的 `bash sleep 40` 场景现在 PASS——DELETE 后 3 ms 工具被切断，
118 ms pi 退出，167 ms `pane list` 已看不到 agent，204 ms 才 close。** 这三次 run 是 `25b8c1b`
的验收，只回答“上一轮失败的那个 case 现在怎样”，不重复 §3.5 / §3.6 已验的其它判据。
证据：`probe/logs/terminate-20261101T132033/`（`report.md`、`analysis.txt`、三个 `case*/`）。

**机制，读代码读出来的**：`sys.terminated` 的旧路径是 `discardAndShutdown()`——丢 journal、停循环、
`surface.shutdown(reason)`，**从不 abort 正在跑的那一轮**。pi 的 shutdown 等工具，不等出结果就把
pane 关掉的是父适配器。现在 `discardAndShutdown()` 先设 `aborting`，用与 `pg.abort` 同一个
`cutTurn()`（同一根 `ABORT_IDLE_TIMEOUT_MS = 3000`，没有第二个数字）切断，然后才丢 journal、
清队列、停循环、shutdown；`aborting` 一直保持到 shutdown 结束，中途的 settle 不能插进来投递。

**触发方式**：三个 case 都先让子成员正常起来并 idle；长工具 case 由 root `pg_say` 让它跑
`bash sleep 40`，等真正的 `"type":"toolCall" … "name":"bash"` 写进会话后才 `pg_terminate`。
midturn case 为了确保删除时一轮 **turn 一定在跑**，先从外部直接给子 pane 一个长文生成 prompt，
`herdr agent wait --until working` 确认 working 后再删；所以它和上一轮的 midturn 数字**不是同一个
触发方式**，只能作量级对照。

| case | 上一轮（`7ae1adc`） | 本轮（`25b8c1b`） | 变化 |
|---|---|---|---|
| 空闲 | 608 ms，PASS | **406 ms**，PASS 11/11 | −202 ms |
| 模型 turn 中 | 4626 ms，PASS（余量 374 ms） | **404 ms**，PASS 11/11 | −4222 ms（触发方式不同） |
| `bash sleep 40` 中 | **5031 ms，FAIL**（close 时仍 `agent=pi working`） | **204 ms**，PASS 13/13 | −4827 ms；FAIL → PASS |

`bash sleep 6`（上一轮 3825 ms）本轮没重跑：要回答的是上一轮唯一失败的那个 case。

**FAIL 那次现在的逐项时间线**（子成员 `m_6f8d83`，pane `wE:p1P`，pi pid `145923`）：

```
13:23:22.979  bash sleep 40 toolCall 写入
13:23:25.652  DELETE / sys.terminated（删除前最后一次 pane 采样 = working）
13:23:25.653  notice 送达子成员
13:23:25.655  toolResult: isError=true, "Command aborted"      +3 ms（工具只跑了 2676/40000 ms）
13:23:25.656  最后一条会话写入：stopReason=error，"This operation was aborted"   +4 ms
13:23:25.770  第一次 pid 采样：pi 已退出                       +118 ms
13:23:25.819  pane list 第一次报 pane 在、agent 不在            +167 ms
13:23:25.856  herdr 收到 pane.close                            +204 ms
13:23:25.859  herdr signal=Hangup（pi 退出 89 ms 后，关掉它留下的 shell）
```

上一轮这一个 case 是 5031 ms 到点、close 时仍 `working`、pi 在 close 后才消失、会话最后是悬空的
`stopReason=toolUse`/无 toolResult。现在三件事全部反过来：工具被切断、pi 在 close 前已退出、
会话完整（29 条、0 坏行、行尾换行，最后三条是 `assistant(toolUse)` →
`toolResult("Command aborted")` → `assistant(stopReason=error)`）。三个 case 的回滚都有 pi 的
`To resume this session:` 行，说明走的是 `ctx.shutdown()` 而非信号打断。

**`pg_terminate` 的原文**（三例同形）：

```json
{"terminated":["m_6f8d83"],"pane_close_failed":[],"pane_close_forced":[]}
```

close 等到了正常退出，所以按 F 的语义 `pane_close_forced` 为空是**正确**的，不是把失败吞掉：
如果 abort 没生效、5 s 到点仍关活 agent，这里会出现 `{"member":"m_6f8d83","pane":"wE:p1P"}`。
三个 case 的会话也都完整（idle 27 条 / midturn 21 条 / midtool40 29 条，均 0 坏行）。

**这一层仍然没覆盖的**（不是 E–F 能修的）：

| 没覆盖 | 现在的行为 |
|---|---|
| 一个**忽略 abort signal** 的工具 | `abort()` 是协作式的：pi 不杀它，3 s 后 `abort()` 放弃并打 warn；父适配器仍可能在 5 s 到点强制关 pane。区别是现在会报 `pane_close_forced: [{member, pane}]`，而不是报“成功” |
| `herdr pane list` 读失败 | `close()` 观察不到活 agent，只能报 `forced: false`；这是“未知”，不是干净退出的证明（`docs/设计说明.md` §2.2 / §5.3 已写明） |
| pane 映射丢失 | 映射仍只在内存里：父适配器重启后丢；孙子 pane 本进程从来没有映射。被删的子成员自己会收尾（它的 `sys.terminated` 不经父进程），所以映射丢失伤害的是“关 pane”，不是“停成员” |
| 祖先删除路径上的强制关闭 | settle/poll 复核路径只打一条 warn，没有面向调用者的工具答案（那条路径本来就没有调用者） |

### 3.9 根自己开组织（2026-11-02，真机 5/5 PASS）

**判据与证据**：`probe/logs/org-start-20261102T150800Z/report.md`（五个 PASS 的原始文件都在同目录：
`root-answer-org-start.txt`、`tools-before.txt` / `tools-after.txt`、`child-tool-calls.txt`、
`child-before-root-kill.json` / `child-after-root-kill.json`、`reattach-answer.txt`、
`platform-*-reattach.txt`、`pane-diff.txt`）。环境：pi 1.4.0 / herdr 0.9.5 / node v26.12.1 /
`deepseek-flash`；平台 `210ed07` 全程未改，`git status` 干净。平台代码用的是真 checkout（作为
`platform_dir` 参数传进去），适配器目录与平台数据目录是临时的。

| # | 断言 | 结果 |
|---|---|---|
| 1 | 无身份 pi 只有 `pg_org_start`；调它后成为 `http://127.0.0.1:45307` 的根 | PASS（`/proc/<root>/environ` 里没有 `PIGROUPS_URL` / `PIGROUPS_TOKEN`；`whoami.is_root=true`；`org.json` 0600） |
| 2 | 根 `pg_spawn` 出的子成员加入同一个平台并回答 | PASS（子成员 `m_629162`，`pg_say` 返回 `seq:1`，人在群里读到那句话） |
| 3 | 组织比根 session 活得久 | PASS（杀根 pi 后平台 pid 650523 仍健康；子成员 `last_seen_at` 在根死后又前进 23.4 s） |
| 4 | 后来的无身份会话重接，不起第二个平台 | PASS（`reattached:true`，同 URL / 同 pid；前后 `/proc` 扫描都只有一个 `src/main.ts`） |
| 5 | 收尾干净 | PASS（pane 集合与基线相同；没有残留 `src/main.ts`；端口 45307 已关；临时目录已删） |

**这一层暴露的两处文档错**（已在本次发版提交改正，行为未改）：`pg_org_start` 成功后**仍留在
同一会话**里（概念稿 §7 / `pigroups-org` §0 原来说它会消失）；只删 `org.json` **不能**保证不出现
第二个写同一数据库的进程（设计说明 §8.4 原文，已按实际行为重写）。前三次尝试是驱动脚本问题
与一次 provider 连接中断，记录在 `attempts/`；`run.txt` 是未编辑的绿色那一次。

---

## 4. 真机四级清单（2026-11-01 实测后）

**每一级只验一件事，失败就停在那级。** 一次起三个成员跑完整场景，出错时分不清是 adapter、herdr 还是模型。

| 级 | 验什么 | 失败的后果 | 通过标准 | 状态（2026-11-01） |
|---|---|---|---|---|
| **1** | 在 `agent_settled` 回调里调 `pi.sendMessage(text, {triggerTurn: true})` **能真起一轮** | 整个消息通道静默失效（最致命，所以排第一） | 探针扩展在 idle 时投一句，日志里出现一次新的 `agent_start` | **通过**。`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮（`delivered p3 → turn_start run 4`） |
| **2** | 一个卡住的工具在外部 `abort()` 后回到 idle | 卡住的成员永远收不到 `pg.abort`，回到"没人能叫停它" | `abort()` 在有界时间内 resolve，日志里那轮以 `aborted` 结束 | **部分通过**。配合的工具（从 signal 监听器返回）2 ms 结束；**忽略 signal 的工具不会被 pi 杀掉**，settle 要到 58 296 ms 后才来。证据：`run-20261101T1920-control/` 与 `run-20261101T1920-ignore-signal/` |
| **3** | `shutdown()` 后进程真退、session 落盘 | 被删成员留一个僵尸 pane | 进程 exit 0，session JSONL 有结尾 | **部分通过**。SIGTERM/tui 这条路径已用 3 s 异步体 + `process.on('exit')` 证明 await：`waited_ms=3000`，`process_exit` 在 `shutdown_done` 之后 54 ms，`exit 0`。§3.7 的四次 run 又补上两条：`ctx.shutdown()` 自调用（`sys.terminated` → `discardAndShutdown()`）走通，PASS 的三次都有非信号的 resume 行、会话每行可解析；shutdown 时正在跑的一轮也验了——#4 里 pi 等 `sleep 6` 工具跑完（删除后 2.5 s）才退。**仍没验**：print/json 模式（源码看是 143，未实测）；#3 被 5 s 硬上限切断那次没有正常退出——**§3.8 已补上这条路径**：同是 `bash sleep 40`，现在工具先被切断、pi 在 close 前正常退出 |
| **4** | 端到端：根 + 子成员、真模型、派活 → 汇报 → 删除 | — | 子成员收到简报、**说了一句话**（"汇报"就是说话：任务由消息关闭，模型没有也不该有 `pg_report` 工具），删除后子进程与 pane 都消失 | **部分通过（主链路通过；只跑了 1 个子成员）**。`probe/logs/level4-20261101T193132/`：根由 herdr 起、`pg_spawn` 建成员与 pane、简报进子模型、子消息人可读、删除后成员/进程退出都成立；pane 已由 `9453f6d` 修好并在 `probe/logs/level4-fix-20261101T193945/` 复跑确认。**判据被改过两处**（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说话），逐条记在 §3.6：原判据里 `pg_report` 那条是写判据的人写错了，`pg.report` 只有适配器自己在 blocked/exiting 时发；但只跑了 1 个子成员，所以整级不记通过。**关 pane 的等待已由 §3.7 四次 run 复验：3 PASS / 1 FAIL**（`bash sleep 40` 那次 5 s 到点仍关掉活 agent）；那个 FAIL 已由 E 修掉，并在 §3.8 复跑 3/3 PASS（DELETE → close 204 ms，pi 先退出） |

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
   print/json 模式、session 落盘、以及 shutdown 正在跑的一轮；第四轮探针都没碰。
   **第六轮补上了其中三条**（§3.7）：`ctx.shutdown()` 自调用在四次真机 run 里走了四遍，
   PASS 的三次都有非信号的 resume 行、会话完整（session 落盘）；shutdown 时正在跑的一轮也验了
   （#4 等 `sleep 6` 工具跑完才退）。**只剩 print/json 模式没验。**
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
| 投递只走**翻滚窗口 + steer**；settle 不再是投递触发器（0.5.0 起） | 一个窗口 = 一次打断。逐条投递会把一轮工作切成碎片；忙碌闸门又让消息等到空闲才到，而 pi 自己会 steer | 概念稿 §8.1、设计稿 §2.3 |
| 条数上限（10）只是尺寸阀门，永远不是触发器 | “又攒了两条就投”会退化成逐条投递，窗口就白设了 | 概念稿 §8.1、设计稿 §3.5 |
| 已投的一批留内存副本，`turn_end(aborted)` 时重投 | 实测：排在长工具后面、还没落盘的 steer 遇上 abort 会整份消失 | 概念稿 §8.3 ②、设计稿 §3.4 |
| 催办只在**没有别的可投**的窗口里投 | 反了会饿死队列（催办占满投递通道，新消息永远送不到） | 设计稿 §4.3 |
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

**0.7.0 之后新增的两条风险（2026-11-02）**

| 风险 | 说明 |
|---|---|
| 组织记录按名字分目录 | `<adapterDir>/orgs/<key>/org.json`。**同一个名字 = 同一个组织**；两个根想要两个组织，就得给两个名字。删掉某个组织的目录 = 下一次调用会给它起一个新平台（旧进程若还在，占着端口，会以「端口被占」失败而不是悄悄复用） |
| 就绪判据依赖平台可达 | 子成员起来了但连不上平台时，`pg_spawn` 会等待到顶（120 s）后才报「起来了但没连上」；这条路径按设计就该慢，不要把它当 hang |


| 风险 | 状态 |
|---|---|
| 同一轮里两批投递遇上 abort，只有最后一批被重投 | **未修，本版已知的丢失**。`lastDelivered` 只有一个槽位（`src/loop.ts:243`），第二次成功投递把它覆盖。触发条件是“一轮还没结束、第二个投递窗口又关了”，之后才 abort。复现脚本与输出在 `probe/logs/v3-20261101T173805Z/`（`extra-multibatch-loss.ts`：`#2` 出现两次，`#1` 一次都没有）。修法是把槽位换成“未确认批次表”，配一条新测试；留给人做，别在没测试的情况下顺手改 |
| 概念稿 v3 与实现有十处对不上 | **记录，不改稿**。`docs/概念稿.md` 是权威，但它 §2.2 的术语表还写着“一次 settle 只允许一次投递”（§8.1 已删）；§7.6 的 skill 名字是 `pigroups-member`/`pigroups-lead`，实际发的是 `pigroups-org`/`pigroups-message`；§7 的 `pg_schedule` 写“N 秒后”送达，实测会再多等最多一个窗口；`dm:` 前缀是读侧 id，`pg_say` 只收 `g:<owner>` 或裸成员 id；§8.4 的催办在空队列时会没有窗口可等（实现用 `nudgeDue` 开窗）；§8.3 ① 的“abort 之后再 say 立刻生效”需要额外的 `windowImmediate` 状态；journal 重放要不要等窗口没写（实现等）；“条数是阀门不是触发器”没说溢出怎么办（实现每批 10 条、剩下的重开窗）；`pg_members` 的 `self` 是 id 还是行没写（实现给 id）。逐条见 §16 末尾 |
| 两个 skill 只验了“被发现”，没验“有用” | `pi` 的 `loadSkillsFromDir` 从**打出来的包**里读出两条、0 诊断（`probe/logs/release-0.5.0-20261101T175209Z/skills-load.txt`），真机 banner 也列出过（§16 D）。但没有任何一次 run 用它们跑一个多成员组织：措辞是否让模型少问一句、按“拥有的东西”命名是否真的让 `pg_members` 查得到，都还没有样本 |
| `pg_schedule` 的“N 秒后”其实是“N 秒后 + 最多一个窗口” | 已知且写进工具描述：预约到点只是入队，之后按投递窗口走。实测 10 s 的预约在到点后 8.9 s 才送到（§16 C）。它不是定时唤醒——别拿它当 cron 用 |
| 崩溃后 journal 重放要等一个窗口 | **实现选择，概念稿没写**。启动简报是 `windowless`，重放项不是：重启后最坏 60 s 才到模型。判据是“重放和普通消息一样”，如果“启动注入”整体都该免窗，这条要改，测试里已经能显式关窗 |
| `deliver()` 只确认"pi 收下了"，不确认"run 起来了" | 丢失窗口仍在：`pi.sendMessage` 是 void，pi 吞掉启动失败，而水位与 journal 在 `deliver()` resolve 后立刻推进（`docs/设计说明.md §3.4`）。消息会被记成已注入但那一轮没起来。本轮只把契约写准（`PiSurface` 注释、§3.4、本节都写了"收下 ≠ 起来"），没有加 ack；要收紧只能给 `PiSurface` 加"下一次 `agent_start`"的确认，属于接口设计决定 |
| `details.kind` 写了没人读 | `src/surface.ts` 把它塞进 `pi.sendMessage` 的 `details`，`test/surface.test.ts` 也断言了，但仓库里没有任何读取方。要么定为 UI 契约写进 `docs/设计说明.md`，要么删——产品决定，未做 |
| 投递排队分支没有真实样本（部分已补） | 0.5.0 起“一次 settle 只投一次”这条规则没了，排队行为改由投递窗口统一决定；真机 A 观测到“窗口关时那一轮还在跑长工具”这一种（§16），也就是 steer 真的排在模型的下一次调用之前。**仍没观测**的是两批都还在队列里就同时被投出去的样子；`hasPendingMessages` 在 `src/` 里仍一次没读（它本来也没被实现用过） |
| `ctx.shutdown()` 自调用、print/json 模式下的退出 | **部分已验**。外部 `SIGTERM` 的 tui 路径已证明 await（3 s 异步体、`process_exit.after_shutdown_done_ms ≥ 0`、exit 0、只派发一次）；`ctx.shutdown()` 自调用这条路径在 §3.7 的四次 run 里走了四遍（`sys.terminated` → `discardAndShutdown()` → `surface.shutdown()`），PASS 的三次有非信号的 resume 行、会话完整、进程先于 close 退出；shutdown 时正在跑的一轮也验了（#4 等工具跑完才退）。§3.8 三次再验了 abort → shutdown 这一串：工具先被切断（+3 ms），pi 118 ms 退出，三个会话都以非信号的 resume 行结束。**仍缺**：print/json 模式（源码看是 143，未实测） |
| 一个忽略 abort signal 的工具不会被 pi 杀掉 | **未解决，接口边界**。硬变体：abort 后 3009 ms `idle_timeout`，工具自己 60 s 后返回，aborted settle 晚到 58 296 ms。adapter 的 `abort()` 3 s 后放弃并打 warn；`pg.abort` 对这类成员无法兑现“已切断”。`bash` 内置工具未验 |
| `herdr agent start` 在真实 pane 里的行为 | **已验证**（第 4 级）：root 与 child 都由 `agent start` 起，返回 `interactive_ready:true`，pane 显示 `agent=pi`。**未验**的是失败后的 `pane send-text` 兜底路径 |
| `pg_terminate` 关 pane 只覆盖“本适配器内存里记得的 pane” | 本轮补到三种死亡路径：`spawn()` 按成员 id 记住 pane，`terminate()`（自己删，含平台级联返回的每个 id）关；`pollOnce()`/settle 用 `GET /v1/members/{id}` 复核映射里的每个成员，`status:"gone"` 就关——所以**祖先直接删本适配器的直接子成员**（不经过本进程的 `terminate()`）也会在 TTL 内关掉；`pane_not_found` 视为已关，其他失败记 `pane_close_failed` 并保留映射等重试。**仍漏**：映射只在内存里，父适配器重启后丢失；子成员（孙子）由子适配器拉起，父/根删它时本进程没有映射。要补需持久化/共享 pane map，或平台协作。第六轮的 A 只改了关闭前的等待，没有动映射的生命周期 |
| 模型侧没有 `pg_report` 工具 | **产品缺口，未决，但不再是第 4 级的判据**。规范只列 9 个工具；第 4 级原判据要求“根收到 `pg.report`”，这条已撤回并记账（§3.6）。适配器可自发 `blocked`/`exiting` 控制项，模型不能主动发 `done`/`progress`；模型侧的“汇报”现在定义为说话（`pg_say`）。要么加第 10 个工具并改 `docs/设计说明.md` §5.3，要么保持“汇报=说话” |
| ~~删除后 `GET /v1/control?all=true` 500~~ | **平台侧已修（PiGroups `e03af1a`）**：`sys.terminated` 曾把裸成员 id 写进 `to_json`，而读侧统一 `JSON.parse`——删一个成员就把"解释这次删除的日志"打成 500。**旧库也要能读**：两个读侧改成容错解析（非 JSON 原样返回），`openDatabase` 开库时把非 JSON 的 `to_json` 一次性 `json_quote` 回填——否则 `?to=` 过滤（比较 JSON 形式）会静默漏掉旧行。两块各有测试：`test/legacy-control-target.test.ts` |
| 删除后父的义务表残留 | **已修到这些路径**（`d19a179` + 第五轮 + 第六轮）：`terminate()` 丢弃平台级联返回的**每个**成员（不只是参数）的私聊义务；`say()` 收到 410 立刻丢；其余靠 `GET /v1/tree` 名册在 settle 时复核。名册读失败、或返回的不是名册（`{"nodes":[]}`、无 id、不含自己）时**一条不剪**；**债比名册快照年轻**（`since >= at`，即对端可能是在快照之后才创建的）也**不剪**——这两条是第五轮补的，之前会误删真债。`test/obligation.test.ts` 守着。**第六轮再补两条**：`712db53` 在 `ready` 之前用一份**新读的**名册剪一次（startup 绕过 `since >= at`，因为历史读在这份名册之前），所以“启动后第一次 settle 之前”这段窗口关了；`6ce2789` 读失败保留上一份好快照、超时真的 `abort` 请求、失败退避 5 s。**仍漏**：启动剪完之后，如果死对端的消息还躺在 poll 队列里，第一次 poll 会把它投进来、重新标成欠回复（要等下一次 settle 再剪）；迟到的消息同理。第 4 级第一次 run 时观察到 `owed:["dm:…"]` 与 3 次 nudge |
| 子成员消失后群会话从人类索引消失 | 平台按概念稿 §3.3 是正确的（群只在有子成员时存在）；但删完后 `GET /v1/conversations` 看不到那个群，只能按已知 `g:<parent>` 读历史。已知限制，未改 |
| 子成员 `gone` 的遥测文案显示 `id（id）` | 小瑕疵，未修：`terminate()` 时 telemetry 没有该成员的名字，回退到 id。不影响状态判断 |
| pane 关闭与子成员自己的 `sys.terminated` 退出竞争 | **已修，但不是“已关”。** 根因不在 close 的等待（`7ae1adc`）而在 `discardAndShutdown()`：它只丢 journal / 停循环 / `shutdown()`，从不 abort 正在跑的那一轮，而 pi 的 shutdown 会等工具，于是父进程的 5 s 上限先到。`25b8c1b` 让 `sys.terminated` 先按 `pg.abort` 同一条 `ABORT_IDLE_TIMEOUT_MS = 3000` 切断（同一 `cutTurn()`，没有第二个数字），再丢 journal、停循环、shutdown；abort 期间不投递。`Herdr.close()` 现在返回 `{forced}`，到点 agent 仍在就报 `forced: true`，`pg_terminate` 列进 `pane_close_forced`，不再伪装成 `pane_close_failed: []`。真机（§3.8）：idle 406 ms / midturn 404 ms / `bash sleep 40` **204 ms**，均 PASS，且 close 前 pi 已退出、`pane list` 已看不到 agent；上一轮 FAIL 的 5031 ms 不再重现。**仍不覆盖**：① 一个忽略 abort signal 的工具——`abort()` 是协作式的，3 s 后放弃，pane 仍只能在 5 s 硬上限被切，只是现在**会报** `pane_close_forced`；② `herdr pane list` 读失败——`close()` 观察不到活 agent，报 `forced: false`，这是“未知”不是干净退出；③ pane 映射仍在内存里（父适配器重启就丢，孙子 pane 本进程没有映射，见本表 `pg_terminate` 关 pane 那一行）；④ 祖先删除路径（settle/poll 复核）遇到强制关只打 warn，没有面向调用者的答案 |
| 名册读的三条旧洞（第五轮留档：失败无退避、`ROSTER_TIMEOUT_MS` 只是 race 不是取消、启动/`tick()` 不剪） | **已修（`712db53` + `6ce2789`）**：失败或答案不可信时保留上一份好快照、5 s 后重试；超时用 `withAbort()` 真的 `abort` 请求；启动在 `ready` 前剪一次。**仍漏**：退避固定 5 s，不随失败次数增长；半截响应只能靠“名册必须含自己”整次作废 |
| `pg_spawn` 的 `args` 不消毒 | **有意的取舍**。调用方可以传 `-p`、`--` 等改变子进程启动方式的旗标，适配器不拦也不改写——透穿就是契约（§2.3）。代价是上层模型传错旗标时子成员可能起不来或进入非交互模式；错误由子进程自己的输出暴露，适配器不做预检，也不维护会过期的旗标表（`pi --help` 才是手册） |
| `pg_spawn` 的 readiness 等待等不到 `done` | **已修**。`HerdrCli.waitReady()` 现在发 `herdr agent wait <pane> --until idle --until done --until blocked --timeout <ms>`，这三个正是 herdr 不给 `--until` 时的默认匹配集合；只等 `idle` 时，brief 已投、子成员跑完一轮后 herdr 记的是 `agent_status:"done"`，健康子成员会走满 `SPAWN_READY_MS` 并把 `timed out waiting for agent status` 当错误返回给调用方（§15，真机复现 `probe/logs/spawn-args-20261101T142926/ready-probe/`）。`blocked` 也算启动成功：它是活着的 agent 在等输入/许可，不是没起来；`working` 仍不匹配，spawn 不等一轮跑完。超时与错误文本不变。测试 `waitReady() asks herdr for every started state, not just idle`：假 herdr 与真 binary 一样拒绝只有 `idle` 的形式，并断言完整 argv。撤掉 `src/herdr.ts` 的改动 → 该条红在 `timed out waiting for agent status`；恢复 → 104/104 |
| 手动起的根继承用户的全局 pi 扩展 | **不再是产品问题**：0.4.0 起子成员和手动起的根一样，都是正常 pi，不剥离扩展（§2.3）。第一次第 4 级 run 里 `pi-intercom` 把消息转进主会话、`pi-straw-boss` 重排 tab，是探针环境噪声，操作者已禁用那个扩展；不要为它重新加 `-ne`。探针若仍要隔离，按探针纪律显式加 `-ne`，产品默认不这么做 |
| 消息与 inbox 都没有清理策略 | 已知，无上限增长。规模上来再定 |
| 催办三级的阈值（5 分钟窗口 / 3 次上限 / 30 分钟持续） | 全是拍的数字。第 4 级看到了“3 次后 blocked”真的发生，但没有负载样本校准 |
| `at-most-once`（取走即消费）的丢失代价 | 用 journal 缓解，但没有实测过崩溃频率下的影响 |
| 相关性分级（`mentions_me` / `from_parent`）在真实群里够不够 | 仍未验证。第 4 级只有 1 个子成员、1 个群，样本不够；若不够，才考虑启用门控 |
| 同一个 cwd 的两个成员会互相覆盖文件 | 平台没有文件空间；靠 spawn 时指定 cwd 约束 |
| 平台进程由 agent 起，不归任何 session 所有 | **有意如此，也是新的运维面**（§2.4 / 设计说明 §8.4）。`pg_org_start` 起的是 detached 进程：根 session 退出、pane 关闭、适配器重启都不影响它，`session_shutdown` 明确不碰它。后果：① 跑过一次 `pg_org_start` 的机器会留下一个监听 localhost 的平台进程，没有 session 认领；② pid 会被复用，停之前必须核对 `/proc/<pid>/cmdline` 里的 `src/main.ts`（Linux 上还有 `PIGROUPS_DATA`），适配器当时就是这么做的（`looksLikePlatformProcess`，有变异测试守着；0.14.0 起改为不对记录的 pid 发信号，该函数已删除）；③ 没有 systemd 或退出钩子，机器重启后进程没了，但 `org.json` 与数据目录还在，下一次 `pg_org_start` 用同一个端口 / 数据目录把它拉回来（`reattached:true`）。要停就按 `org.json` 的 pid 停，不要按端口猜 |
| `<adapterDir>/org.json` 是新状态文件 | **有意如此，且是唯一的持久记录**（设计说明 §8.3）。内容是 `{url, token, admin_token, pid, data_dir}`，目录 0700、文件 0600、先写临时文件再 rename。**它含根成员 token 与管理员 token，泄露等于把组织交出去**：不要提交、不要放进共享目录。并发调用靠同目录的 `org.lock` 串行化（死持有者或超过 120 s 视为陈旧） |
| 人删掉 `org.json` 之后 | **不是“重置”，是“失忆”**（§7 上一行、设计说明 §8.4）。适配器失去旧平台的 pid 与端口，**不会**去杀旧进程；而默认数据目录仍是同一个 `<adapterDir>/platform-data`，所以新调用会挑一个空闲端口、起第二个进程写同一个 SQLite 库——两个 URL、一份数据，旧平台继续服务旧 token。要换组织：先停旧 pid（或先调一次 `pg_org_start` 拿回记录再停），或显式给新的 `data_dir`；只删 `org.json` 不够 |

---

## 8. 怎么重跑一切

**先确认你手里是哪一版。** 现在这一对是**平台 `0.2.0` + 适配器 `0.6.0+platform.0.2.0`**：平台有未签名 annotated 标签 `v0.2.0`（`1d68dd4`，代码停在 `210ed07` 未动），适配器有未签名 annotated 标签 `v0.6.0+platform.0.2.0`（钉在携带证据的发版提交上，`git rev-parse 'v0.6.0+platform.0.2.0^{}'`；上一版适配器是 `v0.5.2`，再上一对是 `v0.5.0+platform.0.2.0`，更早的 `v0.4.0` 指向被否掉的那一版，见下面的“标签名带 metadata 的原因”）。这是又一次**单侧发版**：只有适配器动了，所以只有它进号（minor：工具面新增 `pg_org_start`，无身份会话的注册行为改变），平台保持 `0.2.0`。发版提交之后如果还有文档/元数据提交，`git describe --tags` 会带后缀（平台现在就是 `v0.2.0-1-g210ed07`）——**后缀不是新版本**，标签仍钉在发版提交上。

**号住在哪。** 平台只有一处：`package.json`；`src/version.ts` 直接 import 它，`/v1/health` 与每个响应的 `server_version` 都是这个数，没有第二个常量。适配器三处必须一致：`src/version.ts` 的 `ADAPTER_VERSION`、`package.json`、`package-lock.json`（`test/version.test.ts` 会比对 `package.json` 与 lockfile 的两处）；`pg_whoami` 的 `adapter_version` 与启动那一行日志都报它。`+platform.0.2.0` 是 build metadata，只记录发版时验证过的平台，不参与比较；平台以后变了而适配器不用改，就重发同一数字、换 metadata。两边的 lockfile 现在都跟上了各自的 `package.json`（平台在 `210ed07` 重新生成，并加了锁文件漂移测试）。

**发一次版：实际走过的步骤**（2026-11-02，先 `v0.5.0`，再按同一套走 `v0.6.0`）。顺序就是下面这样；第 4、5 步没通过就不要打标签：

```bash
cd ~/Documents/pigroups-adapter

# 1) 三处版本号一起走：package.json、src/version.ts 的 ADAPTER_VERSION、lockfile
#    （lockfile 用 npm install --package-lock-only 生成，别手改另一个数字）
#    test/version.test.ts 会在三者不一致时变红

# 2) 全绿才往下走
npm run typecheck && npm test            # 2026-11-02：typecheck 干净，123/123

# 3) 打包，别只看“命令成功”——把文件清单留着
OUT=probe/logs/release-0.5.0-20261101T175209Z
TMP=$(mktemp -d /tmp/pigroups-release.XXXXXX)
npm pack --pack-destination "$TMP"       # 18 个文件：src/ 10 个、skills/ 2 个、docs/ 3 个、根 3 个
tar -tzf "$TMP"/pigroups-adapter-pi-0.5.0+platform.0.2.0.tgz | sort > "$OUT/tarball-contents.txt"

# 4) 解包，证明打出来的那一份能加载（不是只看仓库工作树）
mkdir -p "$TMP/extract" && tar -xzf "$TMP"/pigroups-adapter-pi-0.5.0+platform.0.2.0.tgz -C "$TMP/extract"
node "$OUT/load-proof.mjs" "$TMP/extract/package"      # 11 条检查，全 PASS
#    name/version、pi.extensions 指向真实文件、pi.skills 指向 ./skills 且两个 SKILL.md 都在、
#    src 有模块、20 条相对 import 全部解析、import() 入口后 default 是扩展函数
#    再做一次“pi 真的加载它”：
PIGROUPS_URL=http://127.0.0.1:9 PIGROUPS_TOKEN=x \
  pi -e "$TMP/extract/package/src/extension.ts" --no-session --mode json < /dev/null
#    stderr 必须出现 [pigroups] adapter 0.5.0+platform.0.2.0 starting against …
#    （那行是 extension.ts 在 init() 里打的：能打出来说明整条模块图在 pi 里 import 并执行了；
#      `--mode json` 从 /dev/null 读不到输入就退出，不需要模型，也不需要真平台）
#    再用 pi 自己的加载器读包里的 skill（不经过本仓库的代码）：
node --input-type=module -e "import {loadSkillsFromDir} from '<pi>/dist/core/skills.js';
  console.log(loadSkillsFromDir({dir: process.argv[1], source: 'pigroups package'}))" \
  "$TMP/extract/package/skills"
#    期望两条：pigroups-message、pigroups-org；diagnostics 为空

# 5) 真机检查（这一步不能省）：见 §16 的 A–D（长工具中投递、abort 后重投、名册/预约、skill 被发现）
#    以及 §15 的 spawn 默认与 args 透传。要起 pane/tab 就用一次性 tab，用完核对 pane/tab 集合

# 6) 一次提交收齐 CHANGELOG、文档、证据目录，然后在那个提交上打未签名 annotated 标签
git add CHANGELOG.md docs/handoff.md docs/设计说明.md src/loop.ts src/state.ts \
        test/control.test.ts probe/logs/v3-20261101T173805Z probe/logs/release-0.5.0-20261101T175209Z
git commit --no-gpg-sign
git tag --no-sign -a 'v0.5.0+platform.0.2.0' -m "…"
git cat-file -p 'v0.5.0+platform.0.2.0' | grep -c gpgsig     # 期望 0
git describe --tags                                          # v0.5.0+platform.0.2.0
```

**这一版的标签内容比真机 run 多一处改动。** 真机 A–D 跑在 `4e5a174` 上（`8d21f37` 的代码 + 证据）。发版前发现 `poll` 401 那句“token 失效”在 0.5.0 里发不出去：`stop()` 之后 `deliverPending` 一律答 `stopped`，而旧代码是“先 `stop()` 再入队”（0.4.0 没有这个闸门，所以是这一版引入的静默退步）。修法是把它作为 `windowless` 项**先投、再停**，配一条新测试（`test/control.test.ts`，撤掉 src 就红，见 §16 末尾）。这是一条错误路径，A–D 都没走到；核心投递/重投路径没有改动，真机结论仍然成立。判据是 `npm test` 123/123 全绿、包里的 11 条加载检查全 PASS（`probe/logs/release-0.5.0-20261101T175209Z/`）。

**0.6.0 按同一套步骤。** 判据是 `npm run typecheck` 干净、`npm test` **132/132**、`npm pack` **19 个文件**（`src/` 11 个）、解包副本的入口能 import、`--mode json` 的 stderr 打出 `adapter 0.6.0+platform.0.2.0 starting against …`；真机证据是 `probe/logs/org-start-20261102T150800Z/`（§3.9，5/5 PASS）。标签打在一个同时携带 `CHANGELOG.md`、`docs/`、`src/`、`test/` 与证据目录的提交上；平台 checkout 全程 `git status` 干净。发版前本文件与 `CHANGELOG.md` 的收尾提交也在同一个标签里，所以 `git describe --tags` 是 `v0.6.0+platform.0.2.0`（没有 `-N-g` 后缀）。


**标签名带 metadata 的原因。** `0.4.0` 当天先切过一版（标签 `v0.4.0`，spawn 默认带 `-ne`、`pg_spawn` 镜像七个旗标），那一版的设计当天被否掉，代码也删了。规则是“标签记录发出去的那一版”，所以旧标签不移动、不删除，最终内容用**同一个数字 + build metadata** 重切：`v0.4.0+platform.0.2.0`，再往后是 `v0.5.0+platform.0.2.0`、`v0.5.1`、`v0.5.2` 与当前的 `v0.6.0+platform.0.2.0`。往后每次内容变化按 0.x 口径进号（`0.7.0` 或 `0.6.1`），不要在同一个数字上打第二个标签。

当前这次（0.6.0）是单侧发版：平台不动，适配器 `0.5.2 → 0.6.0`（工具面新增 `pg_org_start`，无身份会话从“没有工具”变成“只有它”，成功后补注册十个成员工具；契约变化，所以是 minor 不是 patch）。

0.5.0 那次也是单侧发版：平台不动，适配器 `0.4.0 → 0.5.0`（投递从“每次 settle 投一次、等空闲”
变成“翻滚窗口 + steer”，`PiSurface`/`PiEvent`/`LoopConfig` 加成员，工具面删 `pg_steer`、
加 `pg_members`/`pg_schedule`，遥测载荷加 last 块，都是契约变化，所以是 minor 不是 patch）；
前三次单侧发版是 `v0.4.0`（`0.3.0 → 0.4.0`，spawn 默认改为自加载本扩展）、
`v0.3.0`（`0.2.1 → 0.3.0`，`Herdr.close()` 的返回值与 `pg_terminate` 的字段变了）与
`v0.2.1`（`0.2.0 → 0.2.1`，patch）。

口径（`CHANGELOG.md` 里也写着）：0.x 阶段按本项目自己的定义，不按 semver 默认——patch（`0.x.N+1`）只修 bug，端点、字段、工具名都不变；minor（`0.X+1.0`）是契约变化：加/删字段、端点、工具，改已记录的行为，数据迁移，新增接口成员。两边都动时两个仓库一起走到同一个号；只动一侧时另一侧保持原号。标签记录的是这一对。

**第十二轮实测到、没修的问题**：概念稿 v3 与实现的十处对不上（§7 第二行、§16 末尾，`docs/概念稿.md` 是权威，没改稿）；同一轮两批投递遇 abort 只重投最后一批（§7 第一行，有复现脚本）；`pg_schedule` 的到点延迟最多一个窗口（§7）。**已修**的是 `poll` 401 那句提示（见上，发版前）。**上一轮实测到、没修的问题**：平台的变异守卫清单里“只改 `package.json` 看测试变红”这一条按字面做不到（单源，改它不会红；把 `SERVER_VERSION` 写死成 `0.1.0` 才会红，实测 1 条失败），适配器那份按字面有效（把 `ADAPTER_VERSION` 改成与 `package.json` 不同的号，实测 1 条失败）；~~平台 `CHANGELOG.md` 那句“入队与唤醒都在同一事务”~~ 已改正为“在删除事务里入队，事务提交后再唤醒”（`210ed07`）；~~平台 `package-lock.json` 还写着 0.1.0~~ 同一次提交重新生成，并加了锁文件漂移测试（`test/version.test.ts`）。

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
npm run typecheck && npm test          # 57 tests，约 1.8 秒

# 适配器（会自己拉起一个平台子进程）
cd ~/Documents/pigroups-adapter
npm run typecheck && npm test          # 132 tests，约 8 秒
PIGROUPS_PLATFORM_DIR=~/Documents/PiGroups   # 默认是 ../PiGroups

# 根的新路（§2.4）：装包、起 pi、让它调 pg_org_start；不需要先起平台，也不需要环境变量

# 手动起一个平台（只是调试手段；正常路径是 agent 自己起）
cd ~/Documents/PiGroups
PIGROUPS_ADMIN_TOKEN=adm PIGROUPS_DATA=$(mktemp -d) PORT=7717 npm run serve
```

变异测试的脚本没有留在仓库里（都在 `/tmp`）。要重做就看 `docs/设计说明.md` §10 的测试策略，以及本轮交接时列过的 17 个变异点——最值得重跑的是：`flush()` 的返回值、水位是否按成员、`gap` 是否推进水位、`stop()` 是否等待在飞投递。

---

## 9. 接手的第一件事

1. 跑一遍上面两个 `npm test`，确认 57 / 132 全绿（`v0.6.0+platform.0.2.0` 这一对的数）
2. 按 §2.4 真起一次组织（不用环境变量）：装包 → 起 pi → 让它开一个组织 → `pg_spawn` 一个子成员 → 杀掉根 pi，确认组织还在；再开一个 pi，用同一个 `PIGROUPS_ADAPTER_DIR` 调 `pg_org_start`，应回 `reattached:true` 且 `/proc` 里只有一个 `src/main.ts`
3. 读 `pigroups-adapter/docs/设计说明.md` §2.1（`PiSurface`）和 §2.2（`Herdr`）——那是真机验证的靶子；开组织那条路看 §8.1–8.6
4. 重跑 `probe/run.sh`（对照组应 PASS）与 `PROBE_IGNORE_SIGNAL=1 probe/run.sh`（硬变体应 FAIL 在 P2.5/P2.7，这是 pi 的已知边界）
5. 补第 3 级剩下的 print/json 模式；`pg.abort` 的 turn_end 与 `ctx.shutdown()` 自调用都已验，不要再动
6. 第 4 级主链路已在真机跑过（§3.6），整级是部分通过；补第 2 个子成员、重启/级联、以及判据改动后的完整场景。`pg_report` 不再是第 4 级的判据（§3.6），但“加不加第 10 个工具”仍是产品决定。不要因为主链路通了就勾第 4 级
7. ~~真机补 0.4.0 的零配置接线~~ **已验（第十轮，§15）**：不设 `PIGROUPS_SPAWN_CMD`，`pg_spawn` 只给 name+brief 的子成员是正常 pi（`pi -e <本扩展>`，无 `-ne`），能跑 `read`、能 `pg_say`；`args:["--tools","read"]` 也真的透到 pi 了

**不要**在真机之前改循环。接口假设错了，循环改多少遍都是白改。

---

## 10. 交接清单

- [x] 两个仓库 `git status` 干净；**这一对是平台 `0.2.0`（`v0.2.0`，`1d68dd4`，代码 `210ed07`）+ 适配器 `0.6.0+platform.0.2.0`（**`v0.6.0+platform.0.2.0`**，`git rev-parse 'v0.6.0+platform.0.2.0^{}'`）**，都是未签名 annotated 标签（详见 §8）。单侧发版：只有适配器进了 minor 位；上一版 `v0.5.2`、上一对 `v0.5.0+platform.0.2.0` 与被否掉的 `v0.4.0` 都不移动
- [x] `PiGroups`: 57/57，typecheck 干净（2026-11-01 重测，约 1.8 s）
- [x] `pigroups-adapter`: 132/132，typecheck 干净（2026-11-02 本轮重测，约 8 s）
- [x] `grep -c 'pi-coding-agent' pigroups-adapter/src/loop.ts` = 0（实测 0）
- [x] herdr 版本记下（本机 0.9.5，`herdr --version` 2026-11-01 复核），三个旗标形状与 §3.4 一致
- [x] 第 1 级探针通过（2026-11-01，`probe/logs/run-20261101T1920-control/`；abort 后的 settle 也能起一轮）
- [ ] 第 2 级探针**部分通过**（对照组 2 ms 切断；`PROBE_IGNORE_SIGNAL=1` 的硬变体 P2.5/P2.7 失败：pi 不杀忽略 signal 的工具；`bash sleep 60` 未验）
- [ ] 第 3 级探针**部分通过**（SIGTERM/tui 已证明 await 与 exit 0；§3.7 又验了 `ctx.shutdown()` 自调用、session 落盘、shutdown 正在跑的一轮；§3.8 验了 abort → shutdown 这一串；print/json 模式仍未验）
- [x] 真机验证 0.5.0 的投递（第十二轮，§16）：A 长工具中投递不等空闲（适配器在工具结束前 50.363 s 投递，pi 在工具返回 +1 ms 落盘）、B abort 后重投（55 ms 后重新注入并落盘；去掉重投的负对照复现 LOST）、C 名册/预约（6 行、四种关系；10 s 预约到点后 8.9 s 送达）、D 两个 skill 被 pi 发现。证据 `probe/logs/v3-20261101T173805Z/`
- [x] 0.5.0 发版检查（第十二轮，§8）：三处版本号一致、`npm test` 123/123、`typecheck` 干净、`npm pack` 18 个文件、解包副本 11 条加载检查全 PASS、`pi --mode json` 打出 `0.5.0+platform.0.2.0` 启动行、pi 的技能加载器从包里读出两条 skill。证据 `probe/logs/release-0.5.0-20261101T175209Z/`
- [x] 真机验证 0.6.0 的“根自己开组织”（第十三轮，§3.9）：无身份只有 `pg_org_start` → 成为根 → 子成员进同一平台 → 杀根后组织仍活 → 新会话重接且只有一个平台进程 → 收尾干净，5/5 PASS。证据 `probe/logs/org-start-20261102T150800Z/`
- [x] 0.6.0 发版检查（§8）：三处版本号一致、`npm test` 132/132、`typecheck` 干净、`npm pack` 19 个文件、真机 5/5（上一条）
- [x] 真机验证 0.4.0 的 spawn 默认（第十轮，§15）：根不设 `PIGROUPS_SPAWN_CMD`，只给 name+brief 的子成员能跑 `read`、能 `pg_say` 并被人读到；`args:["--tools","read"]` 的子成员工具只剩 `read`。证据 `probe/logs/spawn-args-20261101T142926/`（主）与 `…142109/`（佐证）。**同时抓到既有 bug**：`pg_spawn` 对健康的子成员报 `timed out waiting for agent status`（§7、§15）；当时未修，后续轮已修
- [ ] 第 4 级端到端**部分通过**（2026-11-01：`probe/logs/level4-20261101T193132/` + `level4-fix-20261101T193945/`；根由 herdr 起、`pg_spawn` 建成员与 pane、简报进模型、子消息人可读、删除后成员/进程/pane 都没了。**只能记部分通过**：只跑了 1 个子成员，且两条判据事后在 `de48904` 里改过（2 个子成员 → 子成员；根收到 `pg.report` → 子成员说话，不在记录那次 run 的 `3919467` 里，见 §3.6）。`pg_report` 工具缺失是产品缺口（§7），不是这一级的判据；重启/级联未验。关 pane 的等待另在 §3.7 复验 3 PASS / 1 FAIL，FAIL 那次已由 E 修掉并在 §3.8 复跑 3/3 PASS）

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

留给人做的是取证和产品决定，不是代码：关 pane 可能抢占子成员的 `sys.terminated` 与会话落盘，第五轮只做了文档化——**第六轮已复跑**，结论是 5 s 内成立、长工具下仍 FAIL，见 §3.7。pane 映射只在内存、也看不到子适配器自己起的孙成员；`pg_report` 仍是产品决定（已不是第 4 级判据）。其余已知限制见 §7。

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

---

## 13. 第六轮：A–D 修复与关 pane 的真机复跑（2026-11-01）

这一轮修 §7 / §11 留档的几处，没有动接口（`PiSurface`、`Herdr` 的成员不变，`pg_terminate` 的返回形状也不变）。四条各一笔提交；每个行为修复都配一条“撤掉 src 就红”的测试。适配器 78 → 84，`typecheck` 干净，全绿后单独发 `v0.2.1`（平台仍是 `0.2.0`）。

**A — 关 pane 前等窗格里的 agent 退出（`7ae1adc`）**
`HerdrCli.close()` 每 200 ms 读 `herdr pane list`，等到 pane 消失、或它的条目没有 `agent` / `agent_status === 'unknown'`，再 `pane close`，上限 `PANE_AGENT_EXIT_TIMEOUT_MS = 5000`；`pane list` 读失败则不等待，直接走原来的关闭路径（失败时的行为不变）。测试 `close() waits for the pane agent to exit before it runs pane close`。撤 `src/herdr.ts` → 该文件 3 条里 1 条红（`pane close must happen after the wait, got ["pane close wE:pX"]`）；恢复 → 3/3。真机复跑见 §3.7：**3 PASS / 1 FAIL**，FAIL 是 `bash sleep 40`，5 s 到点仍切掉活 agent，所以 §7 那一行仍然开着。

**B — 启动时先剪一次死对端的债（`712db53`）**
`init()` 在 `replayJournal()` 之后、`ready` 之前读一份**新**名册剪一次；startup 这一条路径绕过 `since >= at`（历史读在这份名册之前，所以它比刚标上的债新），正常 settle 的守卫不变。测试 `a member that starts up owing a dead peer has no debt before the first settle`；撤 `src/loop.ts` → 该条红（`actual: ["dm:…"]`，期望 `[]`）；恢复 → 那个提交上 `obligation.test.ts` 20/20。**仍漏**：消息还躺在 poll 队列里时，第一次 poll 会把它投进来、重新标债，要等下一次 settle 再剪。

**C — 名册读的保留、取消与退避（`6ce2789`）**
`PgClient.tree(signal?)` 把 signal 传进请求与 `fetch`；`aliveIds()` 用新的 `withAbort()`，超时 `abort` 请求而不是只放弃 promise；读失败或答案不可信时保留上一份好快照并退避 5 s；启动强制新读。四条测试（坏名册保留快照、退避内不重读、超时真的中止、`tree()` 传 signal）；把 `src/loop.ts` + `src/pgclient.ts` 恢复到 `712db53` → 四条全红（快照被丢、退避内仍重读、超时路径没有 signal、`fetch` 没收到 signal）；恢复 → 4/4，全仓 84/84。`delivery` / `stop` 里原有的名册测试只改成“第一次读是健康的，settle 那一次是被押住的那次”，断言没有放松。

**D — 注释与代码对齐（`e1fcf13`）**
§4.1 的注释块在 `pruneUnanswerableDms` 上方、§4.3 的在 `nudgeOwed` 上方（这一处早在 `cdd01b9` 就修好了）；这一笔只改 A–C 弄错的注释：名册读现在也发生在启动、缓存的是上一份好快照而不是实时名册、读失败回退到快照而不是无条件保留每条债。纯注释，没有行为测试。

**真机（`1a4c0fe`）**：四次 `paneclose-*` run + 分析器 + 说明，只动 `probe/`，没有 `src/` / `test/` 变更，所以不涉及变异证明。数字与 FAIL 的原始行在 §3.7。

**没有做的**：§7 的行按实际覆盖范围收窄，没有把没修好的写成修好——A 那一行仍然开着（5 s 硬上限）；`pg_report`、pane 映射的生命周期、print/json 模式也都没动。

---

## 14. 第七轮：E–F 与先切断再收尾的真机复跑（2026-11-01）

这一轮动了两处**契约**（不是修 bug）：`Herdr.close()` 的返回值与 `pg_terminate` 的返回字段。所以它是
minor，适配器 `0.2.1 → 0.3.0`，平台保持 `0.2.0`，标签 `v0.3.0`。两条行为修复各配一条“撤掉 src 就红”
的测试；适配器 84 → 88，`typecheck` 干净，全绿后发版。

**E — 终止前先切断正在跑的那一轮（`25b8c1b`）**

根因：`discardAndShutdown()` 在 `sys.terminated` 上丢 journal、停循环、`surface.shutdown(reason)`，
**从不 abort 正在跑的那一轮**；pi 的 shutdown 等工具而不是切断它，于是子成员卡在 `bash sleep 40`
里，父适配器 5 s 到点把 pane 从活 agent 底下关掉（§3.7）。

现在终止路径先设 `aborting`，走与 `pg.abort` 同一个 `cutTurn()`（同一个
`ABORT_IDLE_TIMEOUT_MS = 3000`，没有第二个数字），再丢 journal、清队列、停循环、shutdown；
`aborting` 一直保持到 shutdown 结束，所以中途的 settle 不能插进来投递。abort 是“切断”不是“暂停”：
不补提示，被切的那一轮留在 transcript 里，与 §3.2 的 `pg.abort` 一致。

测试：`sys.terminated cuts the running turn before discarding the journal and shutting down`、
`sys.terminated reaches shutdown at the abort bound when the surface abort never returns`。
变异证明：把 `discardAndShutdown()` 恢复成“先丢 journal、直接 stop/shutdown”→ `test/control.test.ts`
里 3 条 `sys.terminated` 用例 1 pass / 2 fail；`cuts...` 红在
`timed out after 5000ms waiting for: the termination to cut the running turn`，`reaches shutdown...`
红在 `the termination asks for the cut / 0 !== 1`；恢复后 3/3 绿。

**F — 强制关 pane 不再伪装成干净关闭（`25b8c1b`）**

`Herdr.close(pane)` 从 `Promise<void>` 变成 `Promise<{ forced: boolean }>`：等待到点时 agent 仍在
`pane list` 里就是 `true`。`pane_not_found` 仍是成功，返回值同样带这次等待的 `forced`。
`AdapterLoop.terminate()` 返回 `{terminated, pane_close_failed, pane_close_forced}`，
`pg_terminate` 原样序列化三个字段，`pane_close_forced` 每项是 `{member, pane}`；祖先删除路径上的
settle/poll 复核遇到强制关闭打一条 warn。

测试：`close() reports a forced close when the agent is still running at the bound`、
`pg_terminate reports a pane close that was forced past a still-running agent`；原有的 clean `close()`
用例现在也断言 `forced: false`。变异证明：让 `HerdrCli` 永远返回 `forced: false`、`loop.closePane()`
忽略 `forced` → `test/herdr.test.ts` + `test/tools.test.ts` 11 条里 9 pass / 2 fail；
`close() reports...` 红在 `a live agent at the bound must not look like a clean close / actual: false,
expected: true`，`pg_terminate reports...` 红在 `actual: [], expected: [{ member: …, pane: 'pane-1' }]`；
恢复后 11/11 绿。

**文档**：`docs/设计说明.md` §2.2 写清 `close()` 的新返回值与 `forced` 的三种 `false` 来源；§3.2
写 `sys.terminated` 的“先切断再收尾”；§5.3 写 `pg_terminate` 的三字段答案、三条 pane 死亡路径中
第三条的 `pane_close_forced`，以及仍然存在的两个缺口。

**真机（`d2ba2be`）**：三个 case（idle / midturn / `bash sleep 40`）3/3 PASS，证据在
`probe/logs/terminate-20261101T132033/`。上一轮 FAIL 的 `bash sleep 40`：工具在 DELETE 后 3 ms
被切断（`Command aborted`），pi 118 ms 退出，`pane list` 167 ms 看不到 agent，204 ms 才 close，
`pg_terminate` 报 `pane_close_forced: []`（正确——close 等到了正常退出）。只动 `probe/`，无
`src/` / `test/` 变更，数字见 §3.8。

**没有做的**：`abort()` 仍是协作式的——忽略 signal 的工具拖过 3 s 时 pane 仍会在 5 s 被强制关，
现在至少会报出来；`pane list` 读失败仍是“未知”，报 `forced: false`；pane 映射仍只在内存里；
祖先删除路径上的强制关闭只有 warn，没有工具答案。

## 15. 第十轮：`pg_spawn` 的 `args` 透传真机验证（2026-11-01）

这一轮没有动 `src/` / `test/`：`1d3e689` 已经把镜像旗标整组删掉，`pg_spawn` 只剩
`name`/`brief`/`cwd`/`args`，本轮只把它放到真机上验，并记录撞到的东西。适配器仍是
`0.4.0+platform.0.2.0`，平台仍是 `0.2.0`；证据在
`probe/logs/spawn-args-20261101T142926/`（主记录，run B）与
`probe/logs/spawn-args-20261101T142109/`（run A）。

**两个 case 都 PASS。** 真机条件：pi 1.4.0 / herdr 0.9.5 / node v26.12.1 /
`deepseek/deepseek-flash`，一次性平台 `0.2.0`（端口 41777 / 41778），**全程未设
`PIGROUPS_SPAWN_CMD`**（root 的 `/proc/<pid>/environ` 里没有它，所以走的是默认），
root 用 `-ne -e` 隔离（它是探针会话，允许）。

| case | 观测 | 结果 |
|---|---|---|
| 1 只给 `name`+`brief` | root 的 toolCall 实参只有这两个键；子成员 `m_303c16` 的启动行是 `pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts`（pane 回滚第 1 行）；收到 brief、调 `read`、`pg_say` 到 `g:`，human API 读到 `probe-one: read the manifest`；启动 banner 的 `[Extensions]` 有 11 项（只有 `extension.ts` 是适配器放的），内置工具 15 项 | PASS |
| 2 `args:["--tools","read"]` | root 的实参原文含该数组；启动行是 `pi -e …/src/extension.ts --tools read`；子成员 `m_5572fc` 的 `builtinTools=read`（唯一）、`toolCalls=(none)`、`touch …/bash-ran` 不存在，拒绝原文见报告 §3.4 | PASS |

**启动行怎么读到（三条事实，别再走弯路）**：herdr 把启动命令**打进 pane 的 shell**，
shell 会回显，所以子 pi 退出后 `herdr pane read <pane> --source recent-unwrapped --lines 400`
第一行就是完整启动行；pi 启动时 `process.title = "pi"`，`/proc/<pid>/cmdline` 与
`herdr pane process-info` 只剩 `["pi"]`；`herdr agent start` 的返回里本来有 `argv`，但
`HerdrCli.spawn()` 把它丢掉了——要把它变成证据需要适配器落盘，属产品决定。

**继承有可见证据，不是推测**：同一个 pi，只多一个 `-ne` 作对照——对照 banner 的
`[Extensions]` 只有 `extension.ts`、内置工具只有 `read,bash,edit,write`；不隔离的子成员是
11 项扩展、15 项工具（`pi-web-access` 的 `web_search`/`fetch_content`、`pi-subagents`、
`rpiv-todo`、`rpiv-ask-user-question`、`pi-intercom`、`herdr-agent-state`、`pi-straw-boss`）。
`[Skills]` 两种都列全，**不能**当 `-ne` 的证据。本轮子成员没有调用 `intercom`，也没有消息
漏进用户主会话；这只证明"这一轮没漏"。

**新抓到的既有 bug（第十轮未修，后续轮已修，见 §7 与报告 §5.1）**：两次 `pg_spawn` 都返回
`isError=true`、正文 `timed out waiting for agent status`，各白等 120 s，而子成员当场就在
正常工作。根因是 `HerdrCli.waitReady()` 只发 `--until idle`；pi 跑完一轮后 herdr 记的是
`agent_status:"done"`，`--until idle` 匹配不到。`ready-probe/` 三次复现：未跑过任何一轮时
`--until idle` 立即返回；`done` 状态下 `--until idle` 8 s 超时、`--until done` 与
`--until idle --until done` 立即返回。

**后续修复没有动接口**：`waitReady()` 重复 `--until idle --until done --until blocked`（与
herdr 默认匹配集合一致；`blocked` 是活着的 agent 在等输入/许可，不是启动失败），保留
`--timeout` 与原错误文本。测试 `waitReady() asks herdr for every started state, not just idle`
的假 herdr 像真 binary 一样拒绝单状态形式，并断言完整 argv。本轮没有重跑真机 spawn；argv
形状对照的是 `herdr agent wait --help`，行为由假 herdr 守住。

**另一个值得记的边界**：`--tools` 是允许清单，会把适配器自己的 `pg_*` 工具一起挡掉。case 2
的子成员因此无法 `pg_say` 回复 `pg_spawn` 发的那条 brief 私聊，欠账提醒每 ~2 s 注入一次
（`你在这些会话还有未回复的消息：dm:… #1`），子成员永远不 `idle`。这是调用者选择旗标的
后果，不是 bug；但"收窄 `--tools` 的成员只能听、不能说"要写进下一版文档。

**清理**：两次 run 造出来的 pane/tab 全部关掉，最终 pane 集合
`wD:p1E wE:p1 wE:p12 wE:p1J`、tab 集合 `wD:tD wE:t1 wE:tT wE:tW` 与基线一致（只剩 boss 的）；
平台进程已停、端口不再应答；子成员的会话（默认启动行不带 `--session-dir`）复制进日志目录后
从 `~/.pi/agent/sessions/` 删除；平台仓库只被读过/跑过，未改。

**发版（第十一轮）。** 两个 case 都 PASS 之后才切：三处版本号仍是 `0.4.0+platform.0.2.0`，
`npm test` 103/103、typecheck 干净，`npm pack` 出 `pigroups-adapter-pi-0.4.0+platform.0.2.0.tgz`
（16 个文件；shasum 记在证据目录的 `NOTE.md`，不写进文档——`docs/` 也在 tarball 里，写进来 shasum 就变了）。解包副本的证据在
`probe/logs/release-0.4.0-plat0.2.0-20261101T224511/`：20 条相对 import 全部解析、入口 `default`
是扩展函数；pi 的 `--verbose` banner 在 `[Extensions] → path` 列出解包副本的入口，`--mode json`
的 stderr 打出 `[pigroups] adapter 0.4.0+platform.0.2.0 starting against http://127.0.0.1:9`
（退出 0，不需要模型）。标签 `v0.4.0+platform.0.2.0` 打在携带这份证据的提交上；
早先的 `v0.4.0` 指向被否掉的那一版（`-ne` + 旗标镜像），不移动。起的那个 herdr tab 是先关
pane 后自动消失的（再 `tab close` 得到 `tab_not_found`，预期），pane/tab 集合回到基线，
没有残留 `pi -e …` 进程；两次 pi 都没建会话（`--no-session`）。发版流程写成可复跑的步骤在 §8。

---

## 16. 第十二轮：0.5.0 的投递窗口、名册与预约（2026-11-02）

这一轮按**概念稿 v3**（§7 工具面、§8 投递）换掉投递核心，动的是接口，不只是行为；
接口清单写在 `CHANGELOG.md` 的 v0.5.0 一节。`probe/logs/v3-20261101T173805Z/report.md`
是这一轮的全部证据，下面是它的摘要；`probe/logs/release-0.5.0-20261101T175209Z/`
是发版那一次的打包与加载证据。

**改了什么**

- **一条队列 + 翻滚窗口。** 聊天消息、未知控制项、遥测汇总、催办、预约唤醒、启动简报全进
  `pending`。第一个 `windowed` 项开窗；`tick()`（原有的 5 s 定时器，没有第二个）在
  `now - windowStart >= deliveryWindowMs` 时把整批**一次**投出去。条数上限 10 只是尺寸阀门：
  超出的部分重开一个窗口等下一次，永远不会因为“又攒了 10 条”提前投。
- **投递是 steer，不等空闲。** `deliver` 走 `pi.sendMessage(…, {triggerTurn:true,
  deliverAs:'steer'})`；`isBusy()` 闸门与“一次 settle 只投一次”删掉。settle 只剩名册/pane
  复核、跑一次 `tick()`、标记催办。
- **三个例外，都在同一条队列里。** 启动简报 `windowless`；abort 之后强制关窗，并把下一批标成
  `windowImmediate`（否则“先 abort 再 say”里的 say 要白等一个窗口）；`poll` 401 的提示在
  `stop()` 之前以 `windowless` 项投出。
- **abort 丢失的兜底。** 实测：已交给 pi、还排在长工具后面的 steer，遇上 abort 会整份
  session 文件里一次都不出现。所以每次成功投递留一份内存副本；`turn_end(aborted:true)` 放回
  队首并绕过水位重投；干净结束丢掉；provider error 保留。
- **工具面。** 删 `pg_steer`（线协议仍收，走窗口、不再切断忙碌成员）；加 `pg_members(query?)`
  （id/名字/父/关系/子数/`last_seen_at`，并明说后者只是最近一次鉴权）与
  `pg_schedule(after_seconds, note)`（5 s–24 h、最多 8 条、内存里、到点入队）。
- **last 块。** `PiSurface.lastAssistantText()` 由 pi 的 `message_end` 维护；
  `pg.attention` 与 `pg.inspect_result` 带 `last: { text?, tool?: {name, preview, ok} }`
  （正文截断 500 字，工具预览沿用 200）。
- **两个 skill**：`skills/pigroups-org/SKILL.md`（怎么带组织）、
  `skills/pigroups-message/SKILL.md`（怎么说话），`package.json` 的 `pi.skills` 指向
  `./skills`，`files` 也加了它。

**真机 A–D（`probe/logs/v3-20261101T173805Z/`，pi 1.4.0、herdr 0.9.5、deepseek-flash）**

| 项 | 结果 |
|---|---|
| A 长工具中投递 | **PASS**。子成员在 `bash sleep 60`；适配器的注入水位在工具结束前 **50.363 s** 写下（证明它没等空闲），pi 在工具返回 **+1 ms** 落盘，模型 0.8 s 后引用。总延迟 = 9.2 s 窗口 + 50.4 s 工具 |
| B abort 不丢队列里的消息 | **PASS（单批）**。abort 后 55 ms 重新投递并落盘；同一次运行把 `requeueLastDelivered()` 从副本里拿掉，复现 `custom=0, mentions=0` 的 **LOST**，与 `probe/logs/steer-20261101T170244Z/e2-…` 一致。所以 PASS 是重投带来的，不是 pi 的恩赐 |
| C `pg_members` / `pg_schedule` | **PASS**。成员侧看到 `self=m_344e7f, total=6, matched=6`，四种关系齐全，`last_seen_at` 对从未鉴权的成员是 `null`；10 s 的预约在到点后 8.9 s 以 `[scheduled]` 送到（等窗口），模型随即回答 |
| D 两个 skill | **PASS**。pi 的 `[Skills]` 列表里同时出现 `pigroups-org`、`pigroups-message` |
| 清理 | pane 集合与基线一致（`extraPanes: []`）；平台进程退出；没有残留的探针 pi |

**变异扫描**：12 个 src 变异，**0 存活**（清单在 `report.md` §1）。每个都是“只改 `src/`
的临时副本、测试树不动”，跑完丢弃；基线与每次恢复后 `npm test` 全绿。

**发版前补的一处**（不在 A–D 里）：`poll` 401 的“token 失效”提示在 0.5.0 里发不出去——
`stop()` 之后 `deliverPending` 一律答 `stopped`，而代码是“先停再入队”。现在改为先以
`windowless` 项投出、再 `stop()`；`test/control.test.ts` 有一条，撤掉 src 就红（超时等不到
那条投递）。这是**本版引入的静默退步**，不是 0.4.0 的旧账。

**概念稿 v3 的十处矛盾/空白**（`docs/概念稿.md` 是权威，本轮没改稿；实现做了取舍，接手时以这里为准）：

1. §2.2 术语表还写“一次 settle 只允许一次投递”，§8.1 已删掉这条。
2. §7.6 的 skill 名字是 `pigroups-member`/`pigroups-lead`，实际发的是 `pigroups-org`/`pigroups-message`（概念稿 §13.1 与派发任务书都这么写，实现跟的是后者）。
3. §7 的 `pg_schedule` 写“N 秒后”送达；实际是“N 秒后 + 最多一个窗口（+ 当时的工具剩余）”，工具描述已照实写。
4. §8 让成员“用注入前缀里的会话 id 说话”对私聊不成立：`dm:<a>_<b>` 是读侧 id，`pg_say` 只收 `g:<owner>` 或裸成员 id。message skill 里写了一张对照表。
5. §8.4 的催办在**空队列**时没有窗口可等；实现用 `nudgeDue` 开一个安静窗口。
6. §8.3 ① 的“abort 之后再 say 立刻生效”需要额外的 `windowImmediate` 状态，正文没写。
7. journal 重放要不要等窗口没写；实现让重放走窗口（重启后最坏 60 s）。
8. “条数是阀门、不是触发器”没说溢出怎么办；实现每批 10 条、剩下的重开窗。
9. `pg_members` 的 `self` 没定义；实现返回调用者的 id（`members` 里还有一行 `relation:'self'`）。
10. §7.2 还把 `pg.steer` 当适配器命令讲；工具已删，线协议仍兼容。

**仍未合的口**：同一轮里两批投递遇上 abort，只重投最后一批（§7 第一行）。本轮**没有**
修它——修法需要把单槽位换成未确认批次表，并配一条新测试；A–D 与变异扫描都在当前实现上，
发版前不引入未经真机的行为改动。
