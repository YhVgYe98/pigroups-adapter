# requeue-multi 20261101T175812Z — 两批投进同一轮，abort 后两批都要重投

真实平台 + 真实 pi 1.4.0，跑的是**修好的**适配器：HEAD `8e9fe91`
（`fix: requeue every unacknowledged batch, not only the last`）。投递窗口 5 s，
模型 `deepseek/deepseek-flash`，平台 `http://127.0.0.1:40433`（一次性数据目录，pid 在
`platform.pid`，已退出）。

## 结论

**PASS。** 两批各自在一个窗口关闭时 steer 进**同一个仍在跑的 60 s bash 工具**；`pg.abort`
切断该轮后，适配器把**两批一起**按投递顺序重投，pi 在 abort 后 **54 ms** 落盘一条
`custom_message`，`#1` 在 `#2` 之前。0.5.0 的单槽位在这里只会重投 `#2`（见
`../v3-20261101T173805Z/extra-multibatch-loss.txt`）。

## 证据（逐字）

`adapter-watch.jsonl`（适配器自己的 journal + 注入水位；水位到 1 再走到 2，说明是**两次**
成功投递）：

```
{"ts":"2026-11-01T18:02:58.363Z" … "journal":[],"injected":{…"injected":{"dm:m_c5ebf9_m_cbfaef":1}}}
{"ts":"2026-11-01T18:03:08.350Z" … "journal":[],"injected":{…"injected":{"dm:m_c5ebf9_m_cbfaef":2}}}
```

`timeline.txt`（pi 自己的 session，abort 之后的行）：

```
{"index":6,"timestamp":"2026-11-01T18:03:08.433Z","role":"toolResult","toolName":"bash","isError":true,"durationMs":15148,"text":"Command aborted"}
{"index":7,"timestamp":"2026-11-01T18:03:08.434Z","role":"assistant","stopReason":"error","errorMessage":"This operation was aborted","text":""}
{"index":8,"type":"custom_message","timestamp":"2026-11-01T18:03:08.482Z","customType":"pigroups",
 "content":"[dm:m_c5ebf9_m_cbfaef#1] root: MARK-ONE-20261101T180247Z: …\n[dm:m_c5ebf9_m_cbfaef#2] root: MARK-TWO-20261101T180247Z: …"}
```

模型确实读到了整条重投（session 里 abort 后的助手正文原文）：

```
Now there are newest instructions. Two markers: MARK-ONE says when you next see this marker,
reply with exactly "MARK-ONE-..." and then stop. MARK-TWO is the newest instruction.
So reply exactly "MARK-TWO-20261101T180247Z".
```

它按"follow the newest instruction"只回了 `MARK-TWO`，但正文把两个 marker 都点名了——
`#1` 没有被丢。

## 时间线

| 事件 | 时刻 | 相对量 |
|---|---|---|
| bash `sleep 60` 工具开始 | 18:02:53.283 | — |
| batch one DM 写入平台（seq 1） | 18:02:53.301 | — |
| **batch one 投递**（journal 清空、水位 = 1） | 18:02:58.363 | DM 后 **5.06 s**，工具仍在跑 |
| batch two DM 写入平台（seq 2） | 18:02:59.412 | 第一个窗口关闭后 1.05 s |
| **batch two 投递**（journal 清空、水位 = 2） | 18:03:08.350 | DM 后 **8.94 s**，工具仍在跑 |
| `pg.abort` | 18:03:08.428 | 工具已跑 15.1 s，**同一轮**（工具结果尚未出现） |
| 工具被切断 + 错误助手消息 | 18:03:08.433 / .434 | — |
| **两批一起重投的 `custom_message` 落盘** | **18:03:08.482** | abort 后 **54 ms**，`#1` 在 `#2` 前 |
| 模型回答（点名两个 marker，回 `MARK-TWO`） | 18:03:08.49x | 重投后不到 1 s |

## 这条检查证明什么、不证明什么

- 证明：两次投递都发生在**同一轮、同一个 60 s 工具**之内（`summary.json` 的
  `toolStillRunningAtAbort: true`，`elapsedAtAbortMs: 15145`，且 abort 时 session 里没有
  该工具的 `toolResult`）；abort 后重投的那一份里两批齐全、顺序为 `#1 → #2`。
- 不证明：pi 一定在这次 abort 中把两条 steer 都丢了。这条检查证明的是**适配器把两批都交回去了**，
  "abort 真的会吞掉排队中的 steer"由 2026-11-01 的原生实验
  （`../steer-20261101T170244Z/e2-native-steer-platform-abort`）与 v3 的负对照
  （`../v3-20261101T173805Z/B-negative-control-no-requeue`）测量；这里重投是必需的那一半。
- 单元测试里同一形状的那条：`test/delivery.test.ts` → "two batches steered into one
  still-running turn are both re-sent, in delivery order, when that turn is aborted"。
  在旧单槽位代码上它的断言是红的（重投只有 `[dm:…#2] root: batch two`）。

## 清理

`cleanup.json`：运行前后的 pane id 完全一致，`extraPanes: []`，平台 pid 已退出
（`platformAlive: false`）。运行前的基线是 `panes-before.json`：

```
wD:p1E  wE:p1  wE:p12  wE:p2Q  wE:p36
```

`wE:p36`（tower 的 pi）在本次运行**之前**就存在，不是这次检查开出来的；要求保留的
`wD:p1E / wE:p1 / wE:p12 / wE:p2Q` 都在（`requiredPanesPresent: true`）。探针自己的
tab/pane 已关闭，临时平台数据、适配器目录、scratch 已删除。

## 复跑

```
node driver.mjs /home/yang/Documents/pigroups-adapter/probe/logs/requeue-multi-20261101T175812Z
```

`driver.mjs` 自己起一次性平台（随机端口、临时数据目录）、起一个带
`-ne -e /home/yang/Documents/pigroups-adapter/src/extension.ts` 的 pi 成员、驱动上面的序列，
最后关 pane、杀平台、清临时目录。退出码 0 = PASS 且没有多出 pane。

## 文件

| 路径 | 内容 |
|---|---|
| `run.log` / `commands.log` | 驱动日志与每条外部命令（逐字） |
| `adapter-watch.jsonl` | 适配器的 journal 与注入水位快照（50 ms 采样） |
| `session.jsonl` / `timeline.txt` | pi 的 session 副本与其中的关键时刻 |
| `summary.json` / `analysis.json` | 判决、marker、时间、重投正文、助手正文 |
| `pane.txt` / `process-info.json` | 收尾前的 pane 内容与进程信息 |
| `panes-before.json` / `final-panes.json` / `cleanup.json` | 运行前后的 pane 列表与清理检查 |
| `env.sh` / `platform.log` / `platform.pid` | 运行参数（含 HEAD、模型、窗口）与平台日志 |
