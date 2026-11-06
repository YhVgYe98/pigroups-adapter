# 修改说明：respawn 与启动锁

本文只覆盖这次确定要改的东西：respawn 启动时自动、运行时手动；用 `endpoint.json` 取代平台启动锁；只有 root 能拉起平台；一个成员只跑一个消费者；平台不可达时不永久停。不重写心跳、消息、投递、身份模型。

## 1. 动机

1. **respawn：启动自动，运行时手动。** session 连上平台后，每个节点自动 ensure 自己的直接子节点；子节点连上后再 ensure 它们自己的，逐层把整棵树拉起来。运行时手动关掉的部分子树，由人/agent 调 `pg_respawn()` 补上。不做周期性的全组织自动拉起。
2. **用 `endpoint.json` 取代平台启动锁。** `.start.lock` 只做三件事：选 id、接纳 0.2 旧库、给还没有记录的首次启动一个 rendezvous。前两件删掉后，只剩“首次启动的端口 rendezvous”；`endpoint.json` 本身就是那个端口记录。
3. **只有 root 能拉起平台，一个成员只跑一个消费者。** 子成员只重连；同一成员的第二个 pane 不成为成员。

不做兼容：`.start.lock` 和 0.2 旧库接纳都删除；旧库由人手动搬到 `platforms/<id>/`。

### 1.1 这些改动顺带关闭的漏洞

- **子会话会变成 root。** 记录路径今天对每个 session 都调 `startOrg`（`extension.ts:169`），而 `startOrgLocked` 在 `whoamiRoot` 失败时会掉进 `bootstrap`（`org.ts:519→559`），用根 token 铸一个新 root。记录路径只做 reattach，`mayBootstrap:false`，有记录的会话不再拿到 `pg_org_start`。
- **同一 session 可能有两个实例。** 消费者租约在 `openMemberSession` 建工具之前获取；第二个进程不注册工具、不 poll、不心跳。
- **平台不可达 20 次后循环永久停止。** 删除该分支；天气类失败持续重试，401/410 仍是判决。
- **启动时 120s 内的死子节点不会被拉起。** 删除 `fresh` 启动门；pane 是唯一的“在跑”证据。

关 pane 保持现状：30 秒扫描只处理平台明确说 `gone` 的成员，不扩大。

## 2. 目标行为

| 场景 | 行为 |
|---|---|
| session 打开 / `/reload` | 自动重连；连上后自动 ensure 直接子节点，逐层向下 |
| 启动 ensure | 先给所有子节点发 `pg.respawn`；一个 settle 窗口（默认 30s）后做一次 `pane list`：在跑只发控制，缺失才启动；`panes === null` 只发控制，不启动 |
| 运行时部分子节点被手动关掉 | 父级/子树根手动 `pg_respawn()`，立即补；不等 settle、不受失败冷却限制 |
| 在子树根或 root 调 `pg_respawn()` | 范围 = 调用者的整棵子树，逐层下发 |
| 同一成员两个 pane | 第二个不成为成员：不注册工具、不 poll、不心跳、不写水位；打印一行要求关掉另一个 |
| 成员被删除 | 平台 `gone`；30 秒扫描关 pane（现状） |
| agent 正常退出 | 心跳停；pane 可能剩 shell；不关、不杀；启动时按 pane 是否存在决定是否新开 |
| root 不在 | root 的直接子节点不重开；树的其他部分照常 |

## 3. 适配器仓库修改

### 3.1 respawn：pane 是唯一的“在跑”证据

判定（自动和手动共用）：

1. `intent:'terminated'` → 跳过；
2. 平台明确 `status:'gone'` → 跳过；`getMember` 失败不等于 gone，继续看 pane；
3. `listPanes()` 返回 `null` → 只发 `pg.respawn`，**绝不启动**；
4. 某个 pane 的 `agent_session.value` 等于子节点的 session 文件 → 只发 `pg.respawn`；
5. 没有这样的 pane → 启动（记录里的 token + session 文件），等它连上，再发 `pg.respawn`。

- **不看心跳、不看 `last_seen`。** 删除 `performRespawn` 开头的 `fresh` 分支（`loop.ts:1375-1390`）。心跳只能说明“循环在喂”，不能证明进程在；也不能证明进程不在。
- **不引入 `agent_running`。** `HerdrPane` 没有 `agent` 字段；捕获的真实 live idle pane 是 `agent_status:'idle'` 且没有 `agent` 键（`test/herdr.test.ts:103-127`），任何 `agent !== undefined` 的谓词都会把活 pane 判成 shell。
- **任何时候都不关 pane。** 没有“关掉 shell 再启动”的分支；shell 留在那里，只有 `gone` 扫描会关。
- **控制早发无害。** `pg.respawn` 是持久化控制行，子节点连上后第一次 poll 消费（`PiGroups/src/feed.ts:100-121`）。

自动路径：

- `init` 第一次成功 `whoami` 后记 `connectedAt`，先给所有直接子节点发 `pg.respawn`；
- 一个 settle 窗口（`respawnGraceMs`，默认 30s，**从 `connectedAt` 算**）结束后，做**一次** `pane list`，按上面的判定启动缺失的子节点；
- 窗口内不启动任何进程；窗口结束后仍 `panes === null` → 只发控制，不启动，等下一次手动/重启；
- 不做周期性重试。
- 残余风险：settle 结束后，如果 herdr 还没把 `agent_session` 归给一个正在恢复的 pane，可能多起一个进程；消费者租约会让它拿不到租约并立即退出，所以是惰性重复。要绝对避免“多起进程”只能加子进程侧锁，不是换 pane 谓词。

手动路径：

- `pg_respawn()`，无参数；范围 = 调用者的子树；
- 同一判定，但**立即执行**，不经过 settle；
- 删除 240s 失败冷却；保留 `respawn/<childId>.lock`（它只挡活着的 holder）；
- 删除 `allowStart` 和工具描述里的 `scope` 参数；控制通道的 `pg.respawn` 仍可带可选 `scope` 供未来定向修复。
- 子节点收到 `pg.respawn` 后对自己的直接子节点重复同一判定；范围由树决定，不靠参数。
- `pg_spawn` 给子进程的 `PIGROUPS_URL` 用 `pg.url`（root ensure 换端口后的当前地址），不是构造时的 `config.url`；session 记录写同一个当前地址。
- 返回形状保持现有 `RespawnResult` 的键（`restarted/alreadyRunning/skipped/failed`），不静默改名。
- `PIGROUPS_AUTO_RESPAWN=0` 只关闭启动自动 pass；手动 `pg_respawn()` 不受影响。

### 3.2 只有 root 启动平台

- 记录路径只 reattach：读 `SessionRecord`，用 `saved.orgUrl` + `saved.token` 建会话；**不调用 `startOrg`**。`startOrg` 只在“平台不在、自己是 root”的 loop 分支里调用。
- 删除记录路径上的 `recoveryVerdict` 和三个 `registerOrgStart` 回退（`extension.ts:161/176/196`）。
- `startOrgLocked` 增加 `mayBootstrap:false`：记录路径不允许 `bootstrap` 铸新 root。
- root 判定：`parentId` 字段存在且为 `null` 才是 root；字段缺失/空白是“未知”，默认**不是** root。
- attach 后用 `whoami.member.is_root` 复核；whoami 只能降级（record 说 root / whoami 说 child → 不再 ensure，警告），不能把 child 升级成 root。
- 有 session 记录的会话（包括 root）都不注册 `pg_org_start`；只有无记录会话可以显式调用。root token 轮换走 env/记录手动操作。
- root 的“平台不在就拉起”放在 loop 的 `PgUnavailable` 分支里，带退避；不要阻塞 `session_start`。

### 3.3 消费者租约

- 文件 `consumers/<sha1(token)>.json`：`{pid, pid_start, at}`；`pid_start` 来自 `/proc/<pid>/stat`。
  新座位用 `wx` 创建（两个进程都看到“空”时只有一个能建）；stale 接管用 temp+rename 并读回校验。
- 在 `openMemberSession` 的 `buildTools` 之前同步获取；三条路径都覆盖：
  - env 路径：扩展加载时，`openMemberSession` 的 `buildTools` 之前；
  - 记录路径：`openMemberSession` 内部、`buildTools`/loop 之前（因此不会再触发任何平台 ensure）；
  - `pg_org_start` 路径：`startOrg` 返回后、`openMemberSession` 之前（这条路径必须先拿到 token 才知道租约键）。
- 拿不到：不注册十二个工具、不建循环、不 poll、不心跳、不写 `injected/`，打一行“this member is already open in another session (pid X); close that pane and /reload”。
- 存活判断：pid 活着且 `pid_start` 匹配；同 pid + 同启动时间 = `/reload`，直接接管；pid 复用/重启后不匹配 → 陈旧，可接管。
- `pid_start` 用 `/proc/<pid>/stat`；读不到时按“无法证明陈旧”处理（拒绝并提示删除租约文件），不做 pid-only 猜测。
- 同 pid 接管只用于旧循环已经停止、但租约文件残留的情况；`stop()` 未完成前 pi 不会加载新扩展，所以不会出现两个循环重叠。
- 租约按 adapter dir 生效；两个 dir 用同一个 token 仍可能各有一个 poller，平台 409 只是兜底，这是已知局限。
- **释放放在 `stop()` 最后**，等当前投递处理完；不是第一行。`/reload` 时 pi 会先等 `session_shutdown`，同 pid 接管是兜底。
- 409 `poll_in_progress` 仍按“让位并报告”处理：有租约后它只可能来自另一个 adapter dir 或旧版本。

### 3.4 循环

- 删除 `CONNECT_FAILURE_LIMIT = 20` 的 `reportBlocked + stop()`；`PgUnavailable` 持续重试，退避上限 30 秒。不保留 blocked 行；不可达只在日志/工具返回里体现。
- 401 仍是判决：投一句“token 失效”，停止。
- 410 / `member_gone` 仍是判决：停止并 shutdown。
- 删除 `runRepairPassInBackground`、`reconcileMembers` 的 dead 列表和 repair 启动路径；保留 `status:'gone'` → `closePane` + 忘记遥测。
- 心跳继续挂在 tick 上，不依赖 turn。

### 3.5 文档

- `docs/设计说明.md` §8.2/§8.4/§12.4/§12.5/§5.4；`docs/概念稿.md` §7.4；两个 skill；README；CHANGELOG。
- 测试计划见 §5。

## 4. 平台仓库修改

### 4.1 `endpoint.json` 保持现有形状

记录仍然是：

```json
{ "platform_id": "p_x", "port": 7717, "version": "0.7.0",
  "pid": 4412, "updated_at": 1730000000000 }
```

**不增加 `state`，不写 `port:null`。** `port` 永远是整数：首次创建时是候选端口，绑定成功后是实际端口。

启动顺序：

1. `resolvePlatform` 解析 id/路径（不再需要锁，也不再需要 `onResolved`）；
2. 读 `endpoint.json`：
   - 有合法记录 → `firstPort = record.port`；绑定前不改写它；
   - 没有记录 → `wx` 创建记录，`port = seedPort`；若 `EEXIST`，重读记录并用它的端口；
   - 文件存在但读不出合法记录 → **报错退出**，要求人工删除，绝不 unlink、绝不猜；
3. `bindPlatformPort` 从 `firstPort` 开始；**每前进到一个新候选，在尝试它之前把记录改为该候选**（`onCandidate`）：
   - 记录是当前候选，第二个 starter 读到同一个端口，继续会合；
   - 记录属于另一个 live pid 时不覆盖它，让绑定和探测裁决；
   - `EADDRINUSE` 时按现有规则探测两次：
     - 任一次同 `platform_id` → 退出 2；
     - 确定是别的服务 → 下一个端口；
4. 绑定成功 → 改写记录为实际端口（temp + rename，0600）；
5. 打开数据库、挂正式路由；开库前 `/v1/health` 仍答 503 `starting`。

行为：

- **已有记录的重复启动**：绑定失败 → 探测到同平台 → 退出 2；不写记录、不开库。
- **首次启动先创建 claim、随后发现同平台 holder**：保留这份 claim（它是 rendezvous，pid 会随进程退出变成死值），不删、不开库；这与“已有记录不写”是两回事。
- **SIGKILL 后重启**：记录还在，`firstPort = record.port`，回到原端口。
- **两个首次启动**：`wx` 只有一个赢家；输家读记录、绑同一个端口；绑定本身裁决，输家退出 2。若 seed 被别的服务占住，两个 starter 都跟着 `onCandidate` 发布的同一候选前进。
- **0.6.0 的 live 记录**：schema 相同、端口是整数，照常作为候选；探测到同平台 → 退出 2。
- **失败启动**：只删除“自己创建的、且 pid 仍是自己的”记录；已有记录保留，下次继续用那个端口；只有空目录才删。
- **不可读记录**：fail-closed，人工删除；不自动接管。
- **`PORT` 只在没有记录时使用**：已有合法记录时，无效的 `PORT` 不影响启动（记录端口才是第一候选）。

### 4.2 删除

- `platforms/.start.lock` 及 `acquireStartLock`、`stealAbandonedLock`、`lockIsAbandoned`、`readStartLock`、`lockRefusal`、`START_LOCK_*`；
- 0.2 旧库接纳：`adoptLegacyDatabase`、`adoptionTarget`、`adoptionError`、`listHalfAdoptedIds` 及对应测试；
- `newPlatformId` 和“无显式 id 就随机生成”的路径：空数据根必须给 `PIGROUPS_PLATFORM_ID`，否则报错。根上恰好一个平台时仍可无 id 复用；多个仍报错；
- `resolvePlatform` 的 `onResolved` 回调和启动锁条件；
- `singleDirectoryName` 对 `.start.lock` 的保留名检查。

根上存在 0.2 布局的 `pigroups.db` 时启动报错，提示手动搬进 `platforms/<id>/`。

### 4.3 保持不变

- 端口绑定是运行期唯一单例；
- 重复启动退出码 2，不碰数据、不开库；已有记录的 duplicate 不写记录，首次 claim 按 §4.1 保留作为 rendezvous；
- `/v1/health` 开库前 503 `starting`；
- 心跳只写 `heartbeat_at`，不派生状态、不设阈值、不改 `status`；
- `status` 只由创建/删除改变；
- 其余端点、数据库 schema 不变；
- `identifyHolder` 仍按端口 + live pid 判断；记录始终有整数端口，不需要改。它必须忽略**本进程自己的 pre-bind claim**，否则每个被占用的 seed 都会误判成 duplicate。pid 复用导致的误判是已知残余（与 0.6 相同），不在本次范围。

### 4.4 文档

- §11.0 重写为“endpoint 是首次启动的端口 rendezvous，绑定是锁”；§11 布局去掉 `.start.lock`；删除 0.2 接纳段落；§15 决策表同步；§10.2 health 不变。
- 测试计划见 §5。

## 5. 测试计划

### 5.1 原则

- 每条需求至少有一个新增测试；每个被删掉的行为至少有一条“它不会再回来”的回归测试。
- 新行为先写失败断言（红），再实现（绿）；纯粹防误杀的 guard 测试可以先绿，但必须保留。
- 平台启动/竞争用真实子进程、真实端口、真实 SQLite；适配器用 fake herdr + fake clock，不用 sleep 猜测。
- 两仓都跑全量 `npm test` + `npm run typecheck`；新增测试不得 skip。红→绿输出附在提交说明里。

### 5.2 需求 → 测试对照

| 需求 | 适配器测试 | 平台测试 |
|---|---|---|
| 启动自动 respawn，逐层 | A1-A5、A8、A9、B7 | P5-P8 |
| 运行时手动 `pg_respawn()` | A5、A6、A7、A8 | — |
| 只有 root 启动平台 | B1-B8 | — |
| 一个成员一个消费者 | C1-C8、A14 | — |
| `endpoint.json` 取代启动锁 | E1、E2 | P1-P18 |
| 平台不可达不永久停 | D1-D3 | — |
| 不做周期自动拉起 | A11、A12 | — |
| 不关活 pane / 不使用 `agent_running` | A2、A4 | — |

### 5.3 适配器新增/修改测试

#### A. respawn 判定与触发

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| A1 | 启动 settle：子节点 30s 前退出，无 pane | settle 内只发控制、不 spawn；settle 后 spawn 一次、等连上、再发控制 | `test/respawn.test.ts` |
| A2 | herdr 恢复中的 live idle pane：`agent_session=sessionFile`、`agent_status:'idle'`、无 `agent` 键 | 视为在跑，只发控制，不 spawn；不调用 `herdr.close` | `test/respawn.test.ts`、`test/herdr.test.ts` |
| A3 | `panes === null` | 只发控制，不 spawn，不 arm 重试；结果 `skipped` 有原因 | `test/respawn.test.ts` |
| A4 | 正常退出留下的 shell：`agent_status:'unknown'`、无 `agent_session` | settle 后 spawn；不关闭 shell；结果 `restarted`，不是 `skipped` | `test/respawn.test.ts` |
| A5 | 手动 `pg_respawn()`：子节点 10s 前退出、无 pane | 立即 spawn；不受 240s 失败冷却限制 | `test/respawn.test.ts` |
| A6 | 手动 `pg_respawn()` 在 settle 窗口内 | 立即 spawn，不等 settle | `test/respawn.test.ts` |
| A7 | `gone` / `intent:'terminated'`；`getMember` 瞬时失败 | gone/terminated 跳过；getMember 失败仍然看 pane，并按结果控制/启动 | `test/respawn.test.ts` |
| A8 | 没有 session 记录的子节点 | 跳过，不 spawn，不猜路径 | `test/respawn.test.ts` |
| A9 | 两层级联：父拉起子，子连上后再拉起孙 | 父等子认证后才发 `pg.respawn`；子收到后启动孙；顺序可断言 | `test/respawn.test.ts` |
| A10 | 结果形状 | 保持现有 `RespawnResult` 的键（`restarted/alreadyRunning/skipped/failed`），不静默改名 | `test/respawn.test.ts` |
| A11 | 启动后子节点死亡，连续 `cycle()` | 不会自动 spawn；只有手动 `pg_respawn()` 才补；30s 扫描不启动 | `test/heartbeat.test.ts`（重写 199/363/392/471） |
| A12 | 30s 扫描：gone / 非 gone | gone → close pane + 忘记遥测；非 gone → 不关、不启动 | `test/heartbeat.test.ts`、`test/telemetry.test.ts` |
| A13 | `PIGROUPS_AUTO_RESPAWN=0` | 启动不自动 ensure；手动 `pg_respawn()` 仍然工作 | `test/respawn.test.ts` |
| A14 | settle 后 live pane 仍无 `agent_session`，被误判为缺失 | 会 spawn 一次；子进程拿不到租约立即退出；不产生第二个 poller/水位 | `test/respawn.test.ts`、`test/startup-repair.test.ts` |

#### B. root 与平台启动

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| B1 | 子记录 + 平台离线 | 记录路径不调用 `startOrg`、不 spawn 平台、不注册 `pg_org_start`；只重连 | `test/orgstart.test.ts`、`test/startup-repair.test.ts` |
| B2 | 子记录 + 根 token 失效 | 不 `bootstrap`、不重写 `org.json`、不铸新 root | `test/orgstart.test.ts` |
| B3 | `parentId` 缺失/空白 | 判为未知，不是 root；不 spawn 平台 | `test/records.test.ts`、`test/orgstart.test.ts` |
| B4 | record 说 root，`whoami` 说 child | 降级、警告、停止 ensure；不 spawn | `test/orgstart.test.ts` |
| B5 | record 说 child，`whoami` 说 root | 永远不 ensure；不升格 | `test/orgstart.test.ts` |
| B6 | 无记录会话 vs 有记录会话的 `pg_org_start` | 无记录可用；有记录（root/child）都不可用 | `test/toolsurface.test.ts` |
| B7 | root 的平台 ensure 在 loop 的 `PgUnavailable` 分支 | `session_start` 立即返回；loop 退避后启动平台；不阻塞首轮 | `test/startup-repair.test.ts` |
| B8 | 记录路径使用 `saved.orgUrl` + `saved.token` | 不拿 `org.json` 根 token；不因启动失败换成根身份 | `test/orgstart.test.ts` |

#### C. 消费者租约

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| C1 | env 路径，第二个进程同 token | 不注册十二个工具、不建循环、不 poll/心跳；一行日志 | `test/toolsurface.test.ts`、`test/startup-repair.test.ts` |
| C2 | 记录路径，租约已被另一个活进程持有 | 不进入 `openMemberSession`、不触发平台 ensure、不 spawn 平台 | `test/orgstart.test.ts` |
| C3 | `pg_org_start` 路径，`startOrg` 后租约被占 | 不建工具/循环；平台可留着 | `test/orgstart.test.ts` |
| C4 | `/reload`：同 pid + 同 `pid_start` | 直接接管；工具只注册一次；旧循环已停止 | `test/stop.test.ts`、`test/startup-repair.test.ts` |
| C5 | pid 复用：同 pid、不同 `pid_start` | 视为陈旧，接管成功 | `test/startup-repair.test.ts` |
| C6 | 释放顺序：stop 有在途投递 | 新进程在 stop 完成前拿不到租约；完成后拿到；不是 release-first | `test/stop.test.ts` |
| C7 | 409 `poll_in_progress` | 让位并报告一次，不重试风暴 | `test/heartbeat.test.ts` |
| C8 | 两个 adapter dir 同 token | 记录为已知局限：两个 dir 各自轮询，平台可能交替投递；409 只是兜底 | 文档 + 回归断言 |

#### D. 循环

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| D1 | 连续 25 次 `PgUnavailable` | 循环仍在跑，没有 `blocked` + `stop()`；平台恢复后继续 poll/心跳 | `test/heartbeat.test.ts`、`test/recover.test.ts` |
| D2 | 401 | 投一句 token 失效，停止；不重试 | `test/heartbeat.test.ts`（保留） |
| D3 | 410 / `member_gone` | 停止并 shutdown | `test/heartbeat.test.ts`（保留） |
| D4 | `runRepairPassInBackground` / `reportBlocked` / dead-list | 代码中无引用；typecheck 干净 | `npm run typecheck` + grep |

#### E. 平台接口消费

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| E1 | 读 `endpoint.json` | 整数端口可用；没有 `state` 字段也能读；0.6 记录可用 | `test/orgstart.test.ts` |
| E2 | 平台退出 2（可能在绑定前） | 适配器等 health 就绪后重接，不重新拉起平台 | `test/orgstart.test.ts`、`test/startup-repair.test.ts` |

### 5.4 平台新增/修改测试

| ID | 测试 | 断言 | 文件 |
|---|---|---|---|
| P1 | 空数据根、无 `PIGROUPS_PLATFORM_ID` | 启动失败、明确报错；不随机生成 id | `test/platforms.test.ts` |
| P2 | 恰好一个已有平台、无 id | 复用它；绑定它的记录端口 | `test/platforms.test.ts` |
| P3 | 多个平台、无 id | 报错，不猜 | `test/platforms.test.ts` |
| P4 | 根上有 0.2 `pigroups.db` | 报错；不搬迁、不打开、不改文件 | `test/platforms.test.ts` |
| P5 | 无记录首次启动 | `wx` 创建带 seed 端口的记录；绑定前记录已存在；每前进一个候选在绑定前更新；绑定后改写为实际端口 | `test/platforms.test.ts`、`test/platform-startup.test.ts` |
| P6 | 两个首次启动（同数据根、同 id） | 只有一个绑定并服务；另一个退出 2；只有一个记录；没有两个进程开同一个库 | `test/platforms.test.ts` |
| P6b | 两个首次启动、seed 被别的服务占住 | 两者跟着 `onCandidate` 发布的同一候选前进；只有一个服务；记录是赢家的 pid/端口 | `test/platforms.test.ts` |
| P7 | 两个首次启动、不同 `PORT` | 都以记录端口为 rendezvous；一个退出 2；不会各绑一个端口 | `test/platforms.test.ts` |
| P8 | 已有记录 + SIGKILL | 重启回到记录端口 | `test/platforms.test.ts` |
| P9 | 0.6 记录 + live pid + 静默端口 | 退出 2；不写记录、不开库 | `test/platforms.test.ts` |
| P10 | 记录不可读（垃圾/半写） | 退出 1，提示人工删除；文件不 unlink、不接管 | `test/platforms.test.ts` |
| P11 | 已有记录的重复启动 | 记录字节/mtime 不变；不开库；退出 2 | `test/platforms.test.ts` |
| P11b | 首次 claim 发现同平台 holder | claim 保留（端口 rendezvous）；不开库；退出 2 | `test/platforms.test.ts` |
| P12 | 失败启动 | 只删除自己创建、且 pid 仍是自己的记录；已有记录保留；空目录才删 | `test/platforms.test.ts`（或清理函数单测） |
| P12b | 已有记录 + 无效 `PORT` | 记录端口仍生效；启动成功；不因 seed 无效而拒绝 | `test/platforms.test.ts` |
| P13 | 记录形状/权限/目录 | 键集仍是 `platform_id/port/version/pid/updated_at`；0600；目录仍只有 `endpoint.json`、`pigroups.db`、`server.log` | `test/platforms.test.ts`、`test/platform-startup.test.ts` |
| P14 | 开库前 health | `503 {status:'starting'}`；开库后正常 | `test/platform-startup.test.ts`（保留） |
| P15 | 端口探测：同平台 / 别的服务 / 两次静默 | 同平台 → 退出 2；别的服务 → 下一个端口；两次静默 → 下一个端口 | `test/platforms.test.ts`（保留，适配新记录） |
| P16 | `.start.lock` 不再创建 | 启动后目录里没有 `.start.lock` | `test/platform-startup.test.ts`、`test/platforms.test.ts` |
| P17 | 测试 harness `startServer` | 仅在没有 `platforms/*` 时 mint 默认 id；显式 id 仍生效；重启测试稳定 | `test/harness.ts` + 所有调用点 |
| P18 | 0.2 数据库 schema 测试（非接纳） | 保留 `platforms.test.ts:422-471`、`platform-identity.test.ts:50`；不要一起删 | `test/platforms.test.ts`、`test/platform-identity.test.ts` |

### 5.5 删除/重写清单

适配器：

- `test/respawn.test.ts:87,161`：旧的“fresh 就不 spawn”断言；删除，换成 A1/A5。
- `test/heartbeat.test.ts:199,363,392,471`：旧的周期 repair 断言；重写成 A11/A12（不自动补）。
- 断言 `CONNECT_FAILURE_LIMIT`、`reportBlocked`、`runRepairPassInBackground` 的测试：删除。
- 旧的 `agent_running`/shell-close 相关断言（如果有）：删除，换成 A2/A4。

平台：

- `test/platform-startup.test.ts` 的 `.start.lock` 测试（43-175、292-308）；`test/platforms.test.ts` 的 lock 测试（585、670、687、1047、1088、1229、1299、1540、1665）；`test/harness.ts` 的 `startLockPath`/`writeStartLock`：删除。
- 0.2 接纳测试（`platforms.test.ts:563,595,646,884,907,947,971,1305`、`platform-startup.test.ts:309` EXDEV）：删除；0.2 数据库 schema 测试保留（P18）。
- 退出码断言：重复启动统一为 2；不要把 `1 | 2` 当宽松断言。
- 记录形状断言：schema 不变，继续校验精确键集；创建用 `wx` 时显式 0600。

### 5.6 红→绿证据

必须能展示的红：

- **A1/A5**：当前 `fresh` 先于 pane（`loop.ts:1375-1390`），30s 前退出的子节点不 spawn；改后 settle 到期 spawn。
- **A2**：当前不会关 pane，但新增“live idle 无 agent 键”的 fixture 证明 `agent_running` 方案会误杀；改后只发控制。
- **B1/B2**：当前记录路径调用 `startOrg`，`whoamiRoot` 失败会 `bootstrap`（`org.ts:519→559`）；改后不调用、不铸 root。
- **C1**：当前 env 路径在扩展加载就注册工具，第二个进程也能轮询；改后不注册。
- **D1**：当前第 20 次 `PgUnavailable` 就 `stop()`；改后第 25 次仍在跑。
- **P1/P4/P10**：当前会生成 id / 接纳旧库 / 用 seed 继续启动；改后分别报错、拒绝、拒绝。
- **P6/P7**：删除 `.start.lock` 后、但还没加 `wx` 记录创建时，两个 starter 会各绑一个端口；加上记录创建后只有一个服务。用这个顺序展示红→绿。

其余是 guard/回归测试：先绿，改动后必须仍绿。

### 5.7 验收

- 适配器：`cd /home/yang/Documents/pigroups-adapter && npm run typecheck && npm test`。
- 平台：`cd /home/yang/Documents/PiGroups && npm run typecheck && npm test`。
- 新增测试不得 skip；全量套件数量只增不减（删掉的旧测试单独说明）。
- live quant（需用户授权）：停平台 → 升级 → 打开 root，确认自动 attach + 自动拉起子树 → 手动关一个子节点，在父级调 `pg_respawn()` → 确认立即补、没有周期自动补。
- 红→绿输出按 docs/src/test 分车道提交；测试证据不进生产代码。

## 6. 本次不做

- 不做周期性的全组织自动拉起；启动时的逐层自动 respawn 保留；
- 不自动关闭正常退出 agent 的 shell pane；
- 不自动杀卡死的平台；
- 不做 0.2 兼容、不做 `.start.lock` 兼容；
- 不新增 `pg_*` 工具；成员工具仍是 12 个；
- 不改平台心跳语义、不改 `status` 状态机、不改 HTTP API/数据库 schema；
- 没有 session 记录的子节点仍然无法被 respawn（既有局限）；
- 两个 adapter dir 用同一个 token 仍可能各有一个 poller（租约按 dir 生效，409 兜底）；
- 平台 `identifyHolder` 的 pid 复用误判（与 0.6 相同）。

## 7. 发布与升级

- 平台：**0.7.0**（删除 `.start.lock` 与 0.2 接纳，空根要求显式 id；endpoint schema 不变）。
- 适配器：**0.15.0+platform.0.7.0**；`SUPPORTED_PLATFORM_MINORS` 增加 `0.7`；`package.json`、lockfile、`version.ts` 同步。
- live quant：停平台 → 升级平台并启动（记录用原端口重写）→ 打开 root session，确认自动 attach 并自动拉起子树 → 手动关掉一个子节点，在父级调 `pg_respawn()` 验证运行时补拉。旧库（0.2 布局）需先手动搬。
