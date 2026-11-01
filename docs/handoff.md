# 交接文档

> 写于 2026-10-31。两个人（或一个人隔几天回来）之间交接用。
> 面向：接手「把 PiGroups 在 herdr + pi 上真机跑起来」这件事的人。

---

## 1. 一句话现状

**两个仓库都已建成、全绿、经过三轮独立评审和变异测试；平台侧已经没有未知数，适配器侧只剩「接口假设未在真机上验证」这一类风险。**

下一步不是写代码，是**按四级清单在真机上验证三个 API 假设**。

```
平台仓库  ~/Documents/PiGroups          52 tests   typecheck 干净  已定稿
适配器    ~/Documents/pigroups-adapter  38 tests   typecheck 干净  待真机
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

---

## 4. 还没验证的：真机四级清单

**每一级只验一件事，失败就停在那级。** 一次起三个成员跑完整场景，出错时分不清是 adapter、herdr 还是模型。

| 级 | 验什么 | 失败的后果 | 通过标准 |
|---|---|---|---|
| **1** | 在 `agent_settled` 回调里调 `pi.sendMessage(text, {triggerTurn: true})` **能真起一轮** | 整个消息通道静默失效（最致命，所以排第一） | 探针扩展在 idle 时投一句，日志里出现一次新的 `agent_start` |
| **2** | 一个 `bash sleep 60` 卡住时，外部 `abort()` 能切断并回到 idle | 卡住的成员永远收不到 `pg.abort`，回到"没人能叫停它" | `abort()` 在几秒内 resolve，日志里那轮以 `aborted` 结束 |
| **3** | `shutdown()` 后进程真退、session 落盘 | 被删成员留一个僵尸 pane | 进程 exit 0，session JSONL 有结尾 |
| **4** | 端到端：根 + 2 个子成员、真模型、派活 → 汇报 → 删除 | — | 子成员收到简报、说了一句、根收到 `pg.report`，删除后两个子进程都退出 |

**第 1–3 级只需要一个探针扩展**，与 PiGroups 无关：它只依赖 `pi.sendMessage`、会话 abort、`ctx.shutdown` 和事件订阅。验的是**接口假设**，不是业务逻辑。

这正对应 `docs/设计说明.md` §2.1 那句话：

> 验不过就回来改**接口**，不要改循环。

第 4 级才烧 token，验的是**策略**（催办阈值、合并窗口、相关性分级），不是接口。

### 探针扩展该长什么样（第 1 级）

放 `~/.pi/agent/extensions/` 或项目的 `.pi/extensions/`，最小版：

```
session_start  → 写一行日志 "start"
agent_settled  → 若还没投过，调 pi.sendMessage('probe: reply with the word pong', {triggerTurn:true})，日志 "delivered"
agent_start    → 日志 "turn started"
agent_end      → 日志 "turn ended"
```

放置方式：`herdr pane split --cwd <dir> --env PROBE_LOG=<path>` → `herdr agent start probe --kind pi --pane <id>`。

**判据**：日志里出现 `delivered` 之后紧跟 `turn started`。只有 `delivered` 没有 `turn started` = `triggerTurn` 不起作用，回来改 `PiSurface.deliver` 的实现。

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
| `agent_settled` 里 `sendMessage` 能否起一轮 | **未验证**，第 1 级 |
| `abort()` 能否切断正在跑的 tool call | **未验证**，第 2 级 |
| `shutdown()` 是否干净 | **未验证**，第 3 级 |
| `herdr agent start` 在真实 pane 里的行为 | 命令行形状已核，**行为未验** |
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
3. 写第 1 级的探针扩展，跑通"`sendMessage` 能起一轮"
4. 只有 1–3 级全过，才碰第 4 级的端到端

**不要**在真机之前改循环。接口假设错了，循环改多少遍都是白改。

---

## 10. 交接清单

- [ ] 两个仓库 `git status` 干净
- [ ] `PiGroups`: 52/52，typecheck 干净
- [ ] `pigroups-adapter`: 38/38，typecheck 干净
- [ ] `grep -c 'pi-coding-agent' pigroups-adapter/src/loop.ts` = 0
- [ ] herdr 版本记下（本机 0.9.5），三个旗标形状与 §3.4 一致
- [ ] 第 1 级探针通过
- [ ] 第 2 级探针通过
- [ ] 第 3 级探针通过
- [ ] 第 4 级端到端跑通，录一份日志
