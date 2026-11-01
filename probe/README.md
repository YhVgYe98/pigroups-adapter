# pigroups-adapter 真机探针

这个目录里只有一个目的：在**真实运行的 pi** 上，验证 adapter 依赖的三条 pi 行为。
探针只用 pi 扩展 API，**不 import 仓库 `src/` 里的任何东西**，所以 adapter 被重写后它照样有效。

## 验证对象

| 编号 | 假设 | 若不成立的后果 |
|---|---|---|
| **P1** | 在 `agent_settled` 处理器里调用 `pi.sendMessage(..., { triggerTurn: true })` 真的会启动一个新 run；调用时 `ctx.isIdle()` 已经是 `true` | 投递被判为成功、实际被吞掉：watermark 前进、消息永久丢失，成员再也唤不醒 |
| **P2** | `ctx.abort()` 能切断一个正在跑工具的 turn；`ctx.isIdle()` 在有界时间内变 `true`。**分两种工具**：配合的（从自己的 abort 监听器返回）和忽略 signal 的（`PROBE_IGNORE_SIGNAL=1`） | `pg.abort` 撒谎：控制项被当成已处理，成员楔死在工具里。忽略 signal 的变体就是在量这个边界 |
| **P3** | `session_shutdown` 处理器会运行，其 `await` 在进程退出前完成，退出码为 0 | 退出前的 `pg.report{blocked,'exiting'}` 发不出去，平台只看到进程消失 |

## 前置条件

- `pi` 1.4.0（`pi --version`）
- `herdr` 0.9.5，且 server 在运行（`herdr status`）
- 一个可用模型与凭据。默认继承当前 shell 的 `PI_PROVIDER` / `PI_MODEL`，也可以用
  `PROBE_PROVIDER` / `PROBE_MODEL` 覆盖；不设置就走 pi 自己的默认。
- bash、node（pi 自带）

## 一键运行

```bash
/home/yang/Documents/pigroups-adapter/probe/run.sh
```

它会：

1. 选一个 `PROBE_OUT_DIR`（默认 `mktemp -d`，本次所有产物都在里面）；
2. 用 `herdr tab create --no-focus` 建一个**不抢焦点**的 tab（不动你当前 tab 的分栏几何）；
3. 在 pane 里执行 `probe/pane.sh`，即
   `pi -ne -e probe/probe.ts --no-session --no-builtin-tools --no-mcp -ns -np -nc ...`；
4. 等 P1；看到 `probe_sleep` 真的开始跑之后 `sleep ${PROBE_ABORT_DELAY}` 再 `touch $PROBE_DIR/abort` 驱动 P2；
   `PROBE_IGNORE_SIGNAL=1` 时工具不理会 abort signal，用来量"pi 会不会替你切断"；
5. P2 结束后 `kill -TERM` 给 pi，验证 P3 与退出码；
6. 打印 pane 尾部输出 + 完整 JSONL 日志 + PASS/FAIL 汇总；
7. `trap` 兜底：杀掉残留 pi、`herdr tab close` 关掉自己的 tab（正常路径也会走这里）。

退出码：`0` 全部通过，`1` 有检查失败，`2` 环境/参数问题。

> 探针用的模型必须**真的会按提示调用工具**。P2 失败最常见的原因就是模型没调用 `probe_sleep`，
> 日志里会看到 `settled_3` 但没有 `tool_start`。

## 手工复跑（不用 run.sh）

```bash
# 1) 准备目录
export PROBE_DIR="$(mktemp -d /tmp/pigroups-probe.XXXXXX)"
export PROBE_LOG="$PROBE_DIR/probe.log"
export PROBE_EXT=/home/yang/Documents/pigroups-adapter/probe/probe.ts

# 2) 在一个空闲 pane 里启动（不要用正在工作的 pane）
bash /home/yang/Documents/pigroups-adapter/probe/pane.sh

# 3) 另一个终端跟着日志
tail -f "$PROBE_LOG"

# 4) 看到 "step":"tool_start" + "toolName":"probe_sleep" 之后，触发外部中止
touch "$PROBE_DIR/abort"

# 5) 看到 "step":"idle" 后结束会话（Ctrl+D，或给进程发 SIGTERM）
kill -TERM "$(cat "$PROBE_DIR/pi.pid")"
```

`pane.sh` 会把自己的 pid 写进 `$PROBE_DIR/pi.pid`、把退出码写进 `$PROBE_DIR/exit_code`，
所以驱动中止和收尾都不需要占用终端。

调试时设 `PROBE_ECHO=1`，每行日志会同时镜像到 stderr。

## 第 4 级：端到端（根 + 子成员）

前三级只验 pi 接口；这一级起一个真平台、一个根、一个子成员，验“简报进模型、子能说话、人能读到、删除能收尸”。
整块可以照抄（不需要 `jq`，JSON 字段用 node 取）：

```bash
ADAPTER=/home/yang/Documents/pigroups-adapter
PG=/home/yang/Documents/PiGroups
PORT=7911
MODEL=deepseek/deepseek-flash
DATA=$(mktemp -d)
ADIR=$(mktemp -d)
SCRATCH=$(mktemp -d)
SPAWN_CMD="pi -ne -e $ADAPTER/src/extension.ts --model $MODEL"

# 1. 一次性平台
(cd "$PG" && PIGROUPS_ADMIN_TOKEN=adm PORT=$PORT PIGROUPS_DATA=$DATA node src/main.ts) &
PLATFORM_PID=$!
until curl -sf "http://127.0.0.1:$PORT/v1/health" >/dev/null; do sleep 0.2; done

# 2. 根成员（bootstrap 只在这里用一次）
ROOT=$(curl -sX POST "http://127.0.0.1:$PORT/v1/bootstrap" \
  -H 'content-type: application/json' -d '{"name":"root"}')
ROOT_ID=$(printf '%s' "$ROOT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).member.id))')
ROOT_TOKEN=$(printf '%s' "$ROOT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')

# 3. 根 pane：环境在 pane split 上，spawn 命令必须带 -e
PANE=$(herdr pane split --direction down --no-focus --cwd "$SCRATCH" \
  --env PIGROUPS_URL="http://127.0.0.1:$PORT" \
  --env PIGROUPS_TOKEN="$ROOT_TOKEN" \
  --env PIGROUPS_ADAPTER_DIR="$ADIR" \
  --env "PIGROUPS_SPAWN_CMD=$SPAWN_CMD" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.pane.pane_id))')
herdr agent start root --kind pi --pane "$PANE" --timeout 60000 \
  -- -ne -e "$ADAPTER/src/extension.ts" --model "$MODEL"
herdr agent wait "$PANE" --until idle --timeout 120000

# 4. 让根拉一个子成员，并在群里说一句
herdr agent prompt "$PANE" "Call pg_spawn exactly once: name 'alpha', brief 'You are alpha. Call pg_say once to g:$ROOT_ID with one short line, then stop.' Then stop." \
  --wait --timeout 300000

# 5. 让根删掉 pg_spawn 返回的那个成员
herdr agent prompt "$PANE" "Call pg_terminate with the member id returned by pg_spawn. Then stop." \
  --wait --timeout 120000
```

看什么：

- `herdr pane list` 多出一个 pane，`agent=pi status=working`；`GET /v1/tree`（root token）里
  `alpha` 的 `parent_id` 是 `$ROOT_ID`。
- 根的 transcript / pane 里有 `pg_spawn` 的返回 `{"id":"m_…","name":"alpha"}`。
- 子成员的会话里出现 `INJECTED … [dm:…]`，随后有 `pg_say` 的 `{"conv":"g:…","seq":1}`。
- 人的读法：`adm` 只用于 `POST /v1/humans` 换 human token，消息按会话读：
  ```bash
  HTOKEN=$(curl -sX POST "http://127.0.0.1:$PORT/v1/humans" -H 'Authorization: Bearer adm' \
    -H 'content-type: application/json' -d '{"name":"probe-human"}' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
  curl -s "http://127.0.0.1:$PORT/v1/messages?to=g:$ROOT_ID" -H "Authorization: Bearer $HTOKEN"
  ```
- 删除后：成员 `status:"gone"`；`herdr pane list` 里子 pane 消失；`herdr agent list` 没有它；
  `ps` 没有子 `pi`。
- **第 4 级的状态是“部分通过”，不是“通过”。** 通过标准是“子成员说了一句话（`pg_say`）”，
  不是“根收到模型主动发的 `pg.report`”。这条判据改过（原来要求 `pg.report`），而且 2 个子成员
  的通过标准也在记录那次 run 的提交里降成了“子成员”；两处都记账在
  `docs/handoff.md` §3.6。实际只跑了 1 个子成员，所以别把它读成整级通过。
- **模型侧确实没有 `pg_report` 工具**（`searchTools("pg")` 只有 9 个），只有适配器自发的
  `pg.report{"status":"blocked",…}` 能到根。这是产品缺口（`docs/handoff.md` §7），不是第 4 级
  判据，也不要用它反推 run 失败。
- 清理：`herdr pane close "$PANE"`（子 pane 若因 bug 残留也一并关）、`kill "$PLATFORM_PID"`、
  `rm -rf "$DATA" "$ADIR" "$SCRATCH"`。

> 必须用 `-ne`，否则 root 会继承你全局安装的扩展。2026-11-01 第一次第 4 级跑就因此把消息
> 经 `pi-intercom` 转进了用户主会话，还让 `pi-straw-boss` 重排了用户的 tab。

> 复跑一个失败点时，把那次 run 的树记下来：`git rev-parse HEAD` 加
> `sha256sum src/loop.ts`。2026-11-01 的 pane 复跑没有在 run.log 里写这两个值，事后补在
> `probe/logs/level4-fix-20261101T193945/tree.txt`（树 = `9453f6d`），驱动命令在
> `commands.md`。`run.log` 本身不改——它是当时打印的。

## 日志格式

`$PROBE_LOG` 是 JSONL，每行一个对象，两个公共字段在前：

```json
{"ms":924,"pid":8792,"step":"delivered","stage":"p1","idle_in_handler":true,"sendMessage_sync_ms":0}
```

- `ms`：相对扩展工厂执行时刻的毫秒数（不是绝对时间）
- `pid`：pi 进程 pid

| step | 触发点 | 关键字段 |
|---|---|---|
| `start` | `session_start` | `mode`（tui/print/json/rpc）、`isIdle`、`hasUI`、`argv` |
| `before_agent_start` | pi 事件 | `messageType`（`user` / `custom`）、`customType` |
| `turn_start` | pi 的 `agent_start` 事件（adapter 把它映射成 turn_start） | `run`、`delivery_stage`、`since_delivery_ms` |
| `before_settle` | `agent_before_settle`（正常 turn_end 的来源；被 abort 的 run 不经过它） | `outcome` |
| `settled_1` / `settled_N` | `agent_settled` | `aborted`、`isIdle`（**在处理器内同步读取**） |
| `delivered` | 从 settle 处理器里 `sendMessage` 之后 | `stage`（p1/p2/p3）、`sendMessage_sync_ms`、`idle_in_handler` |
| `tool_start` / `tool_end` | `tool_execution_start` / `_end` | `toolName`、`isError`、`durationMs` |
| `tool_enter` / `tool_return` | `probe_sleep` 内部 | `why`（aborted/timeout）、`ran_ms`、`ignoreSignal` |
| `tool_signal_ignored` | `PROBE_IGNORE_SIGNAL=1` 且工具拿到了 signal | `toolCallId` |
| `abort_seen` | 工具轮询到 `$PROBE_DIR/abort` | `waited_ms` |
| `abort_called` | 调完 `ctx.abort()` 之后 | `abort_sync_ms`、`abortError` |
| `idle` | `ctx.isIdle()` 变 true | `wait_ms`（相对 abort 调用） |
| `idle_timeout` | 超过 `PROBE_ABORT_WAIT_MS` 仍未 idle | `wait_ms`、`limit_ms` |
| `pi_turn_end` | pi 的 `turn_end` 事件（与 adapter 的 `PiEvent.turn_end` 不是一回事） | `outcome`、`stopReason`、`errorMessage` |
| `assistant_end` | assistant 消息结束 | `stopReason`、`text`（截断） |
| `shutdown_start` / `shutdown_done` | `session_shutdown` 处理器首/尾 | `reason`、`waited_ms`、`at` |
| `process_exit` | `process.on('exit')`，**只在进程真的退出时写** | `code`、`at`、`shutdown_done_at`、`after_shutdown_done_ms` |

## 判据

`run.sh` 的检查项与含义：

| 检查 | PASS 条件 | 失败意味着 |
|---|---|---|
| P1.0–P1.2 | 种子 run settle；处理器内 `isIdle=true`；`delivered` 已记录 | settle 里读到的仍是 busy → adapter 的 `isBusy()` 闸门把投递推迟 5 s 或永久挂起 |
| P1.3–P1.5 | 出现第二个 `agent_start`，且它**在** `delivered` 之后，`before_agent_start.messageType=custom` | 新 run 没起来，或这次 run 是被别的输入起的（A3 假通过陷阱） |
| P1.6 | `since_delivery_ms` 存在且 ≤ 1000 | 缺失（不再静默跳过）或起 turn 明显延迟 |
| P2.2 | `probe_sleep` 真的开始执行 | 模型没调工具，P2 无法判定 |
| P2.3–P2.4 | 工具看到外部 abort 文件；`abort_sync_ms ≤ 1000` | 中止请求进不去，或 `ctx.abort()` 自己阻塞 |
| P2.3b | `tool_enter` 行号 < `abort_seen` < `abort_called` | abort 发生在工具开始之前，日志不能证明切的是这个 turn |
| P2.5 | `ctx.isIdle()` 在 `PROBE_ABORT_WAIT_MS`（默认 3000，等于 `ABORT_IDLE_TIMEOUT_MS`）内变 true | 工具退出后会话仍不 idle → `pg.abort` 无法兑现 |
| P2.6 | `tool_execution_end` 在 `PROBE_RESULT_TIMEOUT`（默认 90 s，够工具自己 60 s 超时）内出现 | pi 没有结束工具的执行记录 |
| P2.7 | `agent_settled.aborted=true` 在 `PROBE_ABORT_WAIT_MS` 内出现 | abort 没有真正结束这条 run；晚到的 settle 不能让 `pg.abort` 变诚实 |
| P2.8 | `agent_before_settle` 报 `outcome=aborted` | **见下面“实测发现”**：pi 在 abort 时不发这个边界，只给 WARN；adapter 已改从 `agent_settled.aborted` 收尾 |
| P2.9–P2.11 | abort 后的 settle 里 `sendMessage` 被接受，随后出现 `turn_start` #4、#4 的 `delivered` 在它之前、且该轮会 settle | adapter 在 `pg.abort` 之后 flush 的路径没有把成员唤醒 |
| P3.1–P3.2 | `session_shutdown` 被派发；`SHUTDOWN_SETTLE_MS`（默认 3000）的异步体真的跑完（`waited_ms` 不小于 2500） | 处理器没跑，或它的 promise 没被 await（250 ms 的 timer 无法区分这两种） |
| P3.2b | `process_exit` 存在，且 `after_shutdown_done_ms ≥ 0`、`exit_at ≥ shutdown_done_at` | 进程在处理器完成前就退出了 |
| P3.3–P3.5 | 退出码 0；SIGTERM→退出 ≤ 6 s；进程消失 | 退出被拖死或进程残留 |
| P3.6 | `session_shutdown` **恰好**派发一次 | 0 次＝没派发，2 次以上＝双派发（teardown + dispose）会把 `'exiting'` 报告发两遍 |

## 本机实测（2026-11-01 19:20，pi 1.4.0 / herdr 0.9.5 / node v26.12.1 / deepseek-flash / mode=tui）

三次运行都留在 `probe/logs/`，每次一个目录：`probe.jsonl`（扩展写的 JSONL，扩展运行时叫 `probe.log`）、
`runner.txt`（`run.sh` 的全部 stdout/stderr）、`exit_code`（pi 的退出码）、
`run_exit_code`（`run.sh` 自己的退出码）。

| 运行 | 目录 | `run_exit_code` | 结果 |
|---|---|---|---|
| 对照组（工具从自己的 signal 监听器返回） | `run-20261101T1920-control` | 0 | PASS，27 项全过 |
| 硬变体（`PROBE_IGNORE_SIGNAL=1`，工具忽略 signal） | `run-20261101T1920-ignore-signal` | 1 | FAIL：P2.5、P2.7 |
| 负对照（故意用不存在的模型） | `run-20261101T1920-negative-control` | 1 | FAIL，证明 runner 会报失败并留下产物 |

- **P1 成立（两组都通过）**：`agent_settled` 处理器里 `ctx.isIdle()` 已经是 `true`；
  `sendMessage` 同步返回 `0 ms`；`before_agent_start` 以
  `messageType=custom, customType=probe` 出现，`turn_start` 在 0–1 ms 后到达。
  也就是说投递确实起了新 run，且 run 在 settle 派发结束后才启动。
- **P2 只对“配合的工具”成立，第 2 级因此是部分通过。** 对照组：abort 后
  `settled_3.aborted=true`，处理器里 `isIdle` 已是 `true`（相对 abort 2 ms）；
  硬变体：`tool_enter ignoreSignal:true`，abort 后 3009 ms 记录 `idle_timeout`，
  工具自己睡满 60 s 才 `tool_return why=timeout`，`settled_3 aborted:true` 出现在
  abort 之后 **58 296 ms**。也就是说 **pi 把 `AbortSignal` 交给工具，但不会替你杀掉一个
  不理会它的工具**——adapter 的 `abort()` 在 3 s 处放弃时，那一轮还在工具里。
  这正是 `src/surface.ts` 的放弃分支现在要打 warn 的原因。
- **P3 成立，而且是判别性的**：`session_shutdown` 的异步体是 3000 ms；
  `shutdown_done.waited_ms=3000`；`process_exit` 在 `shutdown_done` 之后 54 ms 才写，
  `after_shutdown_done_ms ≥ 0`，`exit 0`，SIGTERM→退出 3130 ms，只派发一次。
  250 ms 的旧探针做不到这个区分：一个没被 await 的 `setTimeout` 也能让进程活到 357 ms。
- **abort 后的 settle 仍能起一轮**：`settled_3(aborted)` 里 `sendMessage` 被接受，
  日志出现 `delivered stage=p3` → `turn_start run=4` → `settled_4`。这补上了 P1
  只覆盖“正常 settle”的空缺；硬变体也通过了 P2.9–P2.11（工具超时、run 真正 abort 之后）。
- **实测发现（与 adapter 旧假设不符）**：被 abort 的 run **不会**产生
  `agent_before_settle`（pi 在 `_agentRunAbortRequested` 为真时跳过该边界），
  取而代之的是一条 `stopReason: "error"` 的 assistant 消息
  （`errorMessage: "This operation was aborted"`）和 `pi_turn_end` `outcome=error`。
  adapter 已改从 `agent_settled.aborted` 补发 `turn_end`（`abecc76`，`fff2418` 加了
  幂等门），所以 `P2.8` 的缺失只打 WARN：它描述的是 pi 的边界，不再是 adapter 的洞。

## 已完成的一次运行（2026-11-01 18:51，历史记录）

> 这一节保留当时的日志原文。它的 P3 只有 251 ms，**不能证明处理器被 await**；
> 判别性的版本见上一节的 19:20 运行。它的 P2 也只测了配合的工具。

不是“应该能过”，是一次真实运行的记录。环境：pi 1.4.0、herdr 0.9.5、node v26.12.1、
`deepseek / deepseek-flash`、`mode=tui`。

```bash
PROBE_OUT_DIR=/tmp/probe-run/run-20261101T185102 \
  /home/yang/Documents/pigroups-adapter/probe/run.sh
```

- pane `wE:pK`（不抢焦点的 tab `wE:tH`，workspace `wE`），探针 pi pid `10573`
- `run.sh` 退出码 **0**，`RESULT: PASS`；墙钟 18:51:02 → 18:51:10
- 日志：`probe/logs/run-20261101T185102.jsonl`（31 行，提交 `ee9d819`）。
  `run.sh` 自己把日志写在 `$PROBE_OUT_DIR/probe.log`，仓库里这一份是拷进来的样本。

**P1**：`sendMessage` 在 settle 处理器里同步返回，新 run 是 `custom` run，同一毫秒：

```
{"ms":831,"pid":10573,"step":"settled_1","settled":1,"aborted":false,"isIdle":true,"hasPendingMessages":false}
{"ms":831,"pid":10573,"step":"delivered","stage":"p1","idle_in_handler":true,"sendMessage_sync_ms":0}
{"ms":831,"pid":10573,"step":"before_agent_start","messageType":"custom","customType":"probe","content":"This is an automated probe. Reply with the single word pong and nothing else."}
{"ms":831,"pid":10573,"step":"turn_start","run":2,"delivery_stage":"p1","since_delivery_ms":0,"isIdle":false,"hasPendingMessages":false}
```

**P2**：工具在 `execute` 里跑了 1704 ms 后被切断，`isIdle()` 26 ms 后为 `true`：

```
{"ms":2390,"pid":10573,"step":"tool_enter","tool":"probe_sleep","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","seconds":60,"signalPresent":true,"isIdle":false}
{"ms":4094,"pid":10573,"step":"abort_seen","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","waited_ms":1704,"isIdle":false}
{"ms":4095,"pid":10573,"step":"abort_called","toolCallId":"call_00_ET_PcLSoFCf8aWxDsKulWtR3909","abort_sync_ms":1,"abortError":null,"isIdle":false,"hasPendingMessages":false}
{"ms":4097,"pid":10573,"step":"settled_3","settled":3,"aborted":true,"isIdle":true,"hasPendingMessages":false}
{"ms":4120,"pid":10573,"step":"idle","wait_ms":26,"toolReturned":true}
```

注意顺序是 `abort_seen → tool_return → abort_called`：`ctx.abort()` 同步触发了工具自己的
signal 监听器，promise 在 `abort()` 返回前就 resolve 了。这条 run 也**没有** `before_settle`
（见上面“实测发现”）。

**P3**：`kill -TERM 10573` → `session_shutdown(reason=quit)` → 处理器 251 ms → `exit 0`，
全程 357 ms，只派发一次：

```
{"ms":4349,"pid":10573,"step":"shutdown_start","shutdown":1,"reason":"quit","targetSessionFile":null,"mode":"tui","isIdle":true}
{"ms":4600,"pid":10573,"step":"shutdown_done","shutdown":1,"waited_ms":251}
```

收尾：探针 tab/pane 已关闭，pane 列表与运行前基线一致（`wE:pB`、`wE:p1`），
`pane current --current` 仍是 `wE:p1 focused=true`，pid 10573 已不在。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PROBE_LOG` | 必填 | JSONL 输出路径；未设置时扩展只打一行 stderr，然后什么都不注册 |
| `PROBE_DIR` | 必填（P2） | 外部 abort 触发文件所在目录；未设置则 P2 跳过（日志 `p2_skipped`） |
| `PROBE_ABORT_WAIT_MS` | `3000` | abort 之后等 `isIdle()` 的上限；等于 adapter 的 `ABORT_IDLE_TIMEOUT_MS` |
| `PROBE_IGNORE_SIGNAL` | `0` | `1`＝`probe_sleep` 忽略 abort signal（硬变体）；`0`＝从 signal 监听器返回（对照） |
| `PROBE_SHUTDOWN_SETTLE_MS` | `3000` | `session_shutdown` 里故意 `await` 的毫秒数；太短就无法区分 await |
| `PROBE_ECHO` | 未设置 | `1` 时把每行日志镜像到 stderr |
| `PROBE_PROVIDER` / `PROBE_MODEL` | 继承 `PI_PROVIDER` / `PI_MODEL` | 传给 pane 里 pi 的 `--provider` / `--model` |
| `PROBE_SEED_PROMPT` | `Reply with exactly: ready` | 触发第一个 run 的种子提示 |
| `PROBE_ABORT_DELAY` | `1.5` | 工具开始后多久写入 abort 文件（秒） |
| `PROBE_SEED_TIMEOUT` / `PROBE_P1_TIMEOUT` / `PROBE_P2_TIMEOUT` | `120` | 各阶段等待模型的秒数 |
| `PROBE_ABORT_TIMEOUT` | `ABORT_WAIT_MS/1000 + 5` | 等 `idle` 的秒数 |
| `PROBE_TRIGGER_TIMEOUT` | `15` | 等工具看到 abort 文件的秒数 |
| `PROBE_RESULT_TIMEOUT` | `90` | 等 `tool_end` / `aborted` settle 的秒数（要盖过工具自己的 60 s） |
| `PROBE_RUN4_TIMEOUT` / `PROBE_SETTLE4_TIMEOUT` | `30` / `60` | 等 abort 后新 run 与其 settle 的秒数 |
| `PROBE_SHUTDOWN_TIMEOUT` | `20` | 等 `shutdown_done` 与退出的秒数 |
| `PROBE_OUT_DIR` | `mktemp -d` | 产物目录；`probe/logs/` 下的归档就是把它指到那里 |

## 已知限制

- 只在 **interactive（tui）模式**下验证。`print` / `json` 模式下 `ctx.shutdown()` 的行为不同，
  本探针不覆盖；探针自己也不会调用 `ctx.shutdown()`，它用外部 `SIGTERM` 触发 `session_shutdown`。
- P2 默认测的是**配合**的自定义工具；`PROBE_IGNORE_SIGNAL=1` 才是忽略 signal 的硬变体。
  `bash` 内置工具不在默认探针里（`pane.sh` 带 `--no-builtin-tools`），所以
  `bash sleep 60` 的杀子进程行为**未验**；已验的是自定义工具：pi 不会强杀它。
- 采样有粒度：abort 文件每 100 ms 轮询一次，`isIdle()` 每 25 ms 采样一次，所以 `wait_ms`
  有大约 25 ms 的量化误差。
- 探针不写会话文件（`--no-session`），不会污染 `~/.pi` 下的历史记录。
- `probe_sleep` 最多睡 60 s：如果 runner 一直不写 abort 文件，P2 会在 60 s 后自然结束，
  日志里是 `tool_return why=timeout`，不会永远挂住。
