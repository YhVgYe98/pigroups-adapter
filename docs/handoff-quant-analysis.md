# 交接：PiGroups 在 quant 项目里的使用分析 + 下一阶段

> 写于 2026-11-03。上一轮会话上下文已满，这份文档是**唯一**的交接。
> 读完这份，你应该能直接开始干活，不需要再问人。
> 代码仓库：`/home/yang/Documents/pigroups-adapter`（适配器）与 `/home/yang/Documents/PiGroups`（平台）。
> 两个都是 **PUBLIC**：<https://github.com/YhVgYe98/pigroups-adapter>、<https://github.com/YhVgYe98/PiGroups>

---

## 0. 一分钟状态

| | |
|---|---|
| 适配器 | `0.8.0+platform.0.2.0`，tag `v0.8.0+platform.0.2.0`（HEAD 与远端一致），**140/140**，typecheck 干净 |
| 平台 | `0.2.0`，tag `v0.2.0`，**57/57**，这一阶段没动过 |
| 本地已装 | `pi install /home/yang/Documents/pigroups-adapter` → 是个**目录链接**，改代码不用重装 |
| 组织状态 | `quant-lab`：平台仍在 39317 跑（pid 见 `org.json`），**11 个成员里只剩根**，其余被级联删除（见 §3） |

工具链事实（都实测过，别再问）：

- `herdr tab create --workspace <ws> --cwd <dir> --env K=V --no-focus --label <name>`
  **必须给 `--workspace`**，不给就落在"焦点所在"的工作区。
- `herdr agent start <label> --kind pi --pane <pane> -- --session <file>`：`--` 之后是 pi 的参数。
- 恢复某个会话：**`pi --session <绝对路径>`**（不是 `--resume`，那是交互式选择器）。
- 判断"这个 pi 是不是 PiGroups 成员"：`/proc/<pid>/environ` 里有 `PIGROUPS_URL`。
  **根没有** —— 它是 `pg_org_start` 运行时入会的，环境里本来就没有那两个变量。

---

## 1. 这一阶段已经做完的事（别重做）

1. **投递模型重构（概念稿 v3）**：一条队列 + 60 秒翻滚窗口 + `deliverAs:'steer'`；
   删掉 `isBusy()` 闸门与"一次 settle 只投一次"。
2. **两个实验定下的边界**（证据 `probe/logs/steer-20261101T170244Z/`）：
   - `sendMessage` 返回 ≠ 模型看到。长工具期间 steer 要等工具返回（实测 +1 ms 落盘）。
   - **steer 排队中被 abort = 整条消息丢失**（session 文件里 0 次出现）。
   所以：abort 后关窗立即投；被切断那一轮的批次要重投（已实现，见 `unacknowledged`）。
3. **工具面**：删 `pg_steer`；保留 `pg_abort`；加 `pg_members`、`pg_schedule`、`pg_org_start`。
   十个成员工具 + 一个"进门"工具。
4. **根自己开组织**：无身份会话只注册 `pg_org_start`，调它 → 找平台代码、detached 起平台、
   bootstrap、注册其余工具并起循环。记录在 `<adapterDir>/orgs/<key>/org.json`（**按组织名分目录**）。
5. **成员进新 tab**（同一 workspace）、`agent start` 失败会重试、失败**绝不**往 pane 里打字。
6. **就绪判据换成 D1**：平台 `last_seen_at` 非空，不再看 herdr 的 `idle/done`。
   `pg_spawn` **立刻返回**，就绪后台盯，失败才以一行 `[spawn] …` 通知父。
7. **`pg_children` 列表来自平台**（`GET /v1/tree` 里 `parent_id` 是我的），遥测只填状态。
8. 历史清理：全历史 `pgt_` token 已 redact，无 API key 泄漏（两仓都验过）。

---

## 2. 数据在哪里（下一个任务全靠这些）

| 东西 | 路径 |
|---|---|
| 平台数据（quant 组织） | `~/.pigroups-adapter/orgs/quant-lab/platform-data/pigroups.db`（WAL，**只读打开要用 `mode=ro`**） |
| 平台凭据 | `~/.pigroups-adapter/orgs/quant-lab/org.json`（`url`、`token`=根、`admin_token`、`pid`） |
| 成员会话（pi session） | `/home/yang/.pi/agent/sessions/--home-yang-Documents-quant--/*.jsonl`（45 个，68 MB） |
| 根的会话 | 同上，`2026-11-03T05-08-49-548Z_01a19fcf-5d0c-74a4-b224-a2f586870e02.jsonl`（它调过 `pg_org_start`） |
| 探针证据 | 仓库 `probe/logs/`（每个目录一份 `report.md`） |

**DB 表**：`members, humans, conversation_seqs, messages, mentions, inbox, member_cursors, controls, control_receipts`。
**`messages` 列**：`conv_id, seq, sender_id, sender_kind, client_msg_id, body, meta_json, created_at`
（注意：**没有** per-message token 字段，token 只能从 session JSONL 里算）。

**session JSONL 的 token 字段**：每条 assistant `message` 里有
`usage: {input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`。

**已经算出来的第一版数字**（2026-11-03，按文件 mtime 排序）：

```
147,254,387 tok / 366 msgs / 15:01   …01a19fd6-8472  (t3-qr-attack)
124,320,264 tok / 334 msgs / 15:02   …01a19fd8-ac69  (t1-qr-attack)
111,126,502 tok / 329 msgs / 15:01   …01a19fd6-848b
105,417,909 tok / 357 msgs / 21:51   …01a19fd6-…
100,486,078 tok / 316 msgs / 21:52   …
 98,053,748 tok / 294 msgs / 14:56   …
 92,845,895 tok / 281 msgs / 15:02   …
 91,699,380 tok / 256 msgs / 15:01   …
 82,025,287 tok / 281 msgs / 15:02   …
```

**注意**：`366 条消息吃 147M token` ≈ **每条 40 万 token**。这是"上下文膨胀"的强信号，
正是要查的东西。全部 45 个 session 合计 ≈ **1.94B**。

---

## 3. 刚发生的事故（含我的错误，别重复）

用户在 21:5x 让我"把本工作区里 quant 相关的 agent 关掉"。我关了 **wE 里的 3 个 tab**。
之后平台出现**级联删除**：

```
21:51:34  sys.terminated → t3-qr-attack, t3-qd-review
21:53:05  sys.terminated → fw-dev
21:53:06  sys.terminated → t1-lead, t1-qd-dev, t1-qr-attack, t1-qd-stats, t3-lead
21:53:07  sys.terminated → t2-lead
```

**推断**：关 tab → 成员 pi 收到 SIGHUP → `session_shutdown` 里报 `exiting` → 父级判断下级已死 →
`pg_terminate` → 删 lead 时平台级联整棵子树。**没有铁证**：`controls` 表只记"谁被删了"，
**不记"谁发起的删除"**。

**教训（写死，别重犯）**：

1. **不要用 `herdr tab close` 清理成员**——那会触发下级退出报告，可能顺藤摸瓜级联删除。
   要清就删平台上的成员（走 `pg_terminate` 或 `DELETE`），或者先确认没有父级在盯着。
2. **关之前先想清楚谁是父**。三个被关的成员都挂在 lead 下面。
3. 我为此付出了真实代价：用户正在跑的团队没了，**不可恢复**（见 §5 的 respawn 需求）。

---

## 4. 下一个任务：quant 项目 13:00–15:00 的使用分析

用户的原话（要点，不要走样）：

> 1. 先读根 agent 的第一句提示词，看看我让他做什么，然后它拉起了多少 agent
> 2. 13 点到 15 点用了 1.5B token，为什么？统计每个 session 用了多少，**有效产出 vs 浪费**。
>    严重怀疑是 pg 的 bug：**重复注入上下文、却舍弃了有效输出**
> 3. 树状视图：起了哪些 session，各自的对话历史摘要
> 4. 调查这些 session 的 pg 工具调用与**自动注入**的信息，分析 PiGroups 在当前使用中还有什么问题
> 5. **用 subagent 并行**，不同 subagent 用不同读法（只读用户对话 / 只读 pg 注入 / 只读工具调用…），
>    避免串行把上下文撑爆

### 4.1 建议的 subagent 切法（每个只读一种东西）

| subagent | 只读什么 | 产出 |
|---|---|---|
| A | 根的 session：**第一条 user 消息**（用户的原始指令）+ 根的 `pg_spawn` 调用序列 | 用户的意图、根拉起多少/哪些 agent、名字与 cwd |
| B | 所有 session 的 **usage 汇总**（input / cacheRead / output / reasoning）按 session、按时间窗 | 每 session 的 token 表 + 三类占比 |
| C | 所有 session 的 **`custom_message`（pg 注入）** 条目：条数、字节数、是否有重复文本 | 注入总量、重复率、`[conv#seq]` 标记出现的次数 |
| D | 所有 session 的 **assistant 输出**（文本长度、是否为空、`stopReason`） | "有效输出"的度量：多少 token 换来多少实际文字 |
| E | 平台 DB：`messages` 的会话分布、`controls` 的 `pg.attention`/`pg.inspect` 次数 | 组织侧的真实通信量 vs 注入量 |

**关键判据**（回答"浪费在哪"）：

- 同一段文本在同一个 session 里出现 **N 次** → 重复注入（`custom_message` 去重后对比）
- `usage.cacheRead` 远大于 `input` → 长上下文反复重读（正常，但要看总量）
- assistant 消息里 **大量 `stopReason: "error"` / 空 content / `aborted`** → 输出被舍弃
- 注入的字节数 / 模型输出字节数的比值

### 4.2 已经把根会话的调用统计出来了（可直接用）

根 `01a19fcf…`：`codemode 139`、`bash 33`、`edit 5`、`write 2`、
`pg_org_start 1`、`pg_children 1`、`pg_members 1`、`pg_schedule 1`。
**根只查过一次 `pg_children`/`pg_members`** —— 这本身说明它没在用组织能力，而是在自己埋头干。

---

## 5. 第四个任务：respawn（复活）工具 —— 用户明确要的

> 从刚才误删后无法复原这一点来看，需要一个 respawn tool：持久化每个 root 拉起的平台的成员的
> session，root session 可以调用工具，递归地拉起所有掉线的 session。

**要做到这件事，必须先解决的事实**：

1. **成员 token 只存哈希**，明文只在创建时返回一次。所以"复活旧身份"**不可能**——
   只能 `POST /v1/members/:id/token`（仅直接父）或新建成员。
2. **成员已 gone 的，`pg_terminate` 之后 `GET /v1/members/:id` 仍可读**（status=gone），
   gone 的名字是否可复用：**未验证**（名字有唯一索引，`fails` 会占用；查 §6 第 1 条时一起确认）。
3. **session 文件在磁盘上**（`~/.pi/agent/sessions/<cwd 编码>/<时间>_<uuid>.jsonl`），
   而成员 id ↔ session 文件的对应关系**没有持久化**——这正是要补的第一件事。

**建议的设计（给下一个人，不必照抄）**：

- 新增 `<adapterDir>/orgs/<key>/members.json`：`{memberId, name, sessionFile, cwd, tabId, createdAt, gone?}`
  —— `pg_spawn` 与 `pg_org_start` 时写入；`pg_terminate` 时标记 gone（**不删**，复活要用）。
- 新工具 `pg_respawn(member?)`：
  - 无参：遍历 `members.json` 里所有 `gone` 或"当前不可达"的成员，按原 cwd、原 session 文件、
    原 `args` 重新拉起；**身份要重建**（旧的 gone 了），因此成员 id 与 token 都会变——
    这件事必须在返回里说清楚，并且 `pg_say` 的收件人也要更新。
  - 有参：只复活一个。
- 判定"掉线"用 D1：`last_seen_at` 超过 N 分钟没有前进 **且** `GET /v1/members/{id}` 仍 alive。
- 这需要平台侧吗？**不需要**：`POST /v1/members` 建新成员、`POST /v1/members/:id/token` 重发，
  都是现有 API。**平台仍然不用改**（这是这条设计的卖点，写进文档）。

---

## 6. 已知问题清单（下一个 session 从这儿接着写）

| # | 问题 | 状态 |
|---|---|---|
| 1 | `controls` 不记录"谁发起了删除" | 待查：`sys.terminated` 的 `payload` 里有 `terminated_by`，但 `controls` 列表里看不到（可能只是没打印） |
| 2 | 关 tab 会触发级联删除 | 待设计：`reportExiting` 是否该报 `exiting`，父级是否该据此 terminate |
| 3 | 成员 ↔ session 文件无持久映射 | 待做（respawn 的前置） |
| 4 | 上下文膨胀：366 条消息 / 147M token | **待分析**（任务 2） |
| 5 | 根几乎不用 `pg_children`/`pg_members` | 待分析：是模型不选，还是工具描述不吸引 |
| 6 | `pg_spawn` 的 `brief` 极长（几百行），是否本身就在烧 token | 待分析 |
| 7 | 一个组织被撒到两个 workspace | 已修（0.8.0 显式 `--workspace`），但**旧组织仍是旧状态** |

---

## 7. 新 session 的第一句话建议这么写

> 读 `/home/yang/Documents/pigroups-adapter/docs/handoff-quant-analysis.md`，
> 然后做 §4（quant 使用分析，用 §4.1 的 subagent 切法），做完再做 §5（respawn 工具）。
> 不要动平台仓库。

---

## 8. 工作规矩（这套流程里验证过有效的）

- **adapter 代码我改；platform 代码只由独立 agent 改**（用户明确定的规矩）。
- 提交一律 `git commit --no-gpg-sign`；tag `git tag --no-sign -a`；**绝不 `git add -A`**。
- 行为改动必须配一条**会红的测试**，并用"只回退 src"证明它红。
- 真机验证优先于推理；**失败且有日志，比一句绿色声明值钱**。
- 我这一阶段犯过的错（都写进过文档，别再犯）：
  1. 把 herdr 的界面状态当成员就绪（错过三次）
  2. 在模板字符串里写反引号导致脚本解析失败，却让提交成功了
  3. 提交信息描述十处、实际只改三处（脚本先挂了）
  4. 用 `herdr tab close` 清理成员 → 触发级联删除（本次事故）
