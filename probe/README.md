# pigroups-adapter 真机探针

这个目录里只有一个目的：在**真实运行的 pi** 上，验证 adapter 依赖的三条 pi 行为。
探针只用 pi 扩展 API，**不 import 仓库 `src/` 里的任何东西**，所以 adapter 被重写后它照样有效。

## 验证对象

| 编号 | 假设 | 若不成立的后果 |
|---|---|---|
| **P1** | 在 `agent_settled` 处理器里调用 `pi.sendMessage(..., { triggerTurn: true })` 真的会启动一个新 run；调用时 `ctx.isIdle()` 已经是 `true` | 投递被判为成功、实际被吞掉：watermark 前进、消息永久丢失，成员再也唤不醒 |
| **P2** | `ctx.abort()` 能切断一个正在跑工具的 turn；`ctx.isIdle()` 在有界时间内变 `true` | `pg.abort` 撒谎：控制项被当成已处理，成员楔死在工具里 |
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
| `before_settle` | `agent_before_settle`（adapter 的 turn_end 来源） | `outcome` |
| `settled_1` / `settled_N` | `agent_settled` | `aborted`、`isIdle`（**在处理器内同步读取**） |
| `delivered` | 从 settle 处理器里 `sendMessage` 之后 | `stage`（p1/p2）、`sendMessage_sync_ms` |
| `tool_start` / `tool_end` | `tool_execution_start` / `_end` | `toolName`、`isError`、`durationMs` |
| `tool_enter` / `tool_return` | `probe_sleep` 内部 | `why`（aborted/timeout）、`ran_ms` |
| `abort_seen` | 工具轮询到 `$PROBE_DIR/abort` | `waited_ms` |
| `abort_called` | 调完 `ctx.abort()` 之后 | `abort_sync_ms`、`abortError` |
| `idle` | `ctx.isIdle()` 变 true | `wait_ms`（相对 abort 调用） |
| `idle_timeout` | 超过 `PROBE_ABORT_WAIT_MS` 仍未 idle | `wait_ms`、`limit_ms` |
| `turn_end` | pi 的 `turn_end` 事件 | `outcome`、`stopReason`、`errorMessage` |
| `assistant_end` | assistant 消息结束 | `stopReason`、`text`（截断） |
| `shutdown_start` / `shutdown_done` | `session_shutdown` 处理器首/尾 | `reason`、`waited_ms` |

## 判据

`run.sh` 的检查项与含义：

| 检查 | PASS 条件 | 失败意味着 |
|---|---|---|
| P1.0–P1.2 | 种子 run settle；处理器内 `isIdle=true`；`delivered` 已记录 | settle 里读到的仍是 busy → adapter 的 `isBusy()` 闸门把投递推迟 5 s 或永久挂起 |
| P1.3–P1.5 | 出现第二个 `agent_start`，且它**在** `delivered` 之后，`before_agent_start.messageType=custom` | 新 run 没起来，或这次 run 是被别的输入起的（A3 假通过陷阱） |
| P1.6 | `since_delivery_ms ≤ 1000` | 起 turn 明显延迟（只警告，不判失败） |
| P2.2 | `probe_sleep` 真的开始执行 | 模型没调工具，P2 无法判定 |
| P2.3–P2.4 | 工具看到外部 abort 文件；`ctx.abort()` 同步返回 | 中止请求进不去 |
| P2.5 | `ctx.isIdle()` 在 `PROBE_ABORT_WAIT_MS`（默认 20 s）内变 true | 工具退出后会话仍不 idle → `pg.abort` 无法兑现 |
| P2.6–P2.7 | `tool_execution_end` 存在；`agent_settled.aborted=true` | abort 没有真正结束这条 run |
| P2.8 | `agent_before_settle` 报 `outcome=aborted` | **见下面“实测发现”**：pi 在 abort 时不发这个边界，只给警告 |
| P3.1–P3.2 | `session_shutdown` 被派发；异步处理器跑完（`shutdown_done`） | 处理器没跑，或它的 promise 没被 await |
| P3.3–P3.5 | 退出码 0；SIGTERM→退出 ≤ 6 s；进程消失 | 退出被拖死或进程残留 |
| P3.6 | `session_shutdown` 只派发一次 | 双派发（teardown + dispose）会把 `'exiting'` 报告发两遍 |

## 本机实测（pi 1.4.0 / herdr 0.9.5 / node v26.12.1 / deepseek-flash / mode=tui）

用 `probe/run.sh` 连跑两次，结果一致：

- **P1 成立**：`agent_settled` 处理器里 `ctx.isIdle()` 已经是 `true`；`sendMessage` 同步返回
  `0 ms`；`before_agent_start` 以 `messageType=custom, customType=probe` 出现，`agent_start`
  在 0–1 ms 后到达。也就是说投递确实起了新 run，且 run 在 settle 派发结束后才启动。
- **P2 成立**：`probe_sleep` 开始 1.6 s 后写入 abort 文件，工具在 100 ms 轮询内看到，
  `ctx.abort()` 同步返回（0 ms），工具的 abort signal 在同一次事件循环里触发并让工具返回；
  `ctx.isIdle()` 在 **25 ms** 后为 `true`，`agent_settled.aborted=true`。
- **P3 成立**：`SIGTERM` → `session_shutdown(reason=quit)` → 处理器 `await` 249 ms →
  进程 `exit 0`，总耗时 357 ms；`session_shutdown` 只派发一次。
- **实测发现（与 adapter 现有假设不符）**：被 abort 的 run **不会**产生
  `agent_before_settle`（pi 在 `_agentRunAbortRequested` 为真时跳过该边界），
  取而代之的是一条 `stopReason: "error"` 的 assistant 消息
  （`errorMessage: "This operation was aborted"`）和 `turn_end` `outcome=error`。
  adapter 把 `agent_before_settle` 当作 turn_end 的唯一来源，因此 **`pg.abort` 之后
  收不到任何 turn_end**：`turnStartedAt` 不会清零、`errorNote` 也不会被设置。
  这条由 `run.sh` 的 `P2.8` 以 WARN 形式打印，不改探针的 PASS/FAIL。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PROBE_LOG` | 必填 | JSONL 输出路径；未设置时扩展只打一行 stderr，然后什么都不注册 |
| `PROBE_DIR` | 必填（P2） | 外部 abort 触发文件所在目录；未设置则 P2 跳过（日志 `p2_skipped`） |
| `PROBE_ABORT_WAIT_MS` | `20000` | abort 之后等 `isIdle()` 的上限 |
| `PROBE_ECHO` | 未设置 | `1` 时把每行日志镜像到 stderr |
| `PROBE_OUT_DIR` | `mktemp -d` | `run.sh` 的产物目录（`probe.log`、`abort`、`pi.pid`、`exit_code`） |
| `PROBE_PROVIDER` / `PROBE_MODEL` | 继承 `PI_PROVIDER` / `PI_MODEL` | 传给 pane 里 pi 的 `--provider` / `--model` |
| `PROBE_SEED_PROMPT` | `Reply with exactly: ready` | 触发第一个 run 的种子提示 |
| `PROBE_ABORT_DELAY` | `1.5` | 工具开始后多久写入 abort 文件（秒） |
| `PROBE_SEED_TIMEOUT` / `PROBE_P1_TIMEOUT` / `PROBE_P2_TIMEOUT` | `120` | 各阶段等待模型的秒数 |
| `PROBE_ABORT_TIMEOUT` | `45` | 等 `idle` 的秒数（大于 `PROBE_ABORT_WAIT_MS`） |
| `PROBE_SHUTDOWN_TIMEOUT` | `20` | 等 `shutdown_done` 与退出的秒数 |

## 已知限制

- 只在 **interactive（tui）模式**下验证。`print` / `json` 模式下 `ctx.shutdown()` 的行为不同，
  本探针不覆盖；探针自己也不会调用 `ctx.shutdown()`，它用外部 `SIGTERM` 触发 `session_shutdown`。
- 只验证 `ctx.abort()` 对一个**忽略 abort signal 的自定义工具**的效果；`bash` 工具是否杀子进程
  （`sleep 60` 这类）不在本探针范围内。
- 采样有粒度：abort 文件每 100 ms 轮询一次，`isIdle()` 每 25 ms 采样一次，所以 `wait_ms`
  有大约 25 ms 的量化误差。
- 探针不写会话文件（`--no-session`），不会污染 `~/.pi` 下的历史记录。
- `probe_sleep` 最多睡 60 s：如果 runner 一直不写 abort 文件，P2 会在 60 s 后自然结束，
  日志里是 `tool_return why=timeout`，不会永远挂住。
