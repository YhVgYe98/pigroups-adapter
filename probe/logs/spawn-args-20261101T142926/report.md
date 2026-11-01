# `pg_spawn` 的 `args` 透传：真机验证（run B）

**结论：Case 1 PASS，Case 2 PASS。** `pg_spawn` 的默认启动行是
`pi -e <本扩展绝对路径>`，调用方给的 `args` 原样接在后面并真的到达 pi：带
`args: ["--tools","read"]` 的子成员内置工具只剩 `read`，它自己说跑不了 bash，落盘标记不存在。
**附带抓到一个既有 bug（与 args 透传无关）**：`HerdrCli.waitReady()` 等的是
`--until idle`，而 pi 跑完一轮后 herdr 的状态是 `done`，于是每次 `pg_spawn` 都白等
120 s 并把 `timed out waiting for agent status` 当错误返回给调用方——子成员其实一切正常。
见 §5.1。

两次真机 run，本目录是主记录（run B），另一次留作旁证（run A）：

| run | 目录 | 它多抓到了什么 |
|---|---|---|
| A | `../spawn-args-20261101T142109` | 无参数子成员的启动 banner（`[Extensions]` 全表）；带 `--tools read` 子成员的 pane 回显（活着时抓到的） |
| B（本文） | 本目录 | 两次 case 的启动行都从 pane 回滚里取到；root 的 transcript（`pg_spawn` 实参）；`-ne` 对照会话的内置工具表；`waitReady` 的复现 |

## 1. 环境

| 项 | 值 |
|---|---|
| adapter | `1d3e689`（`src/extension.ts` sha256 `1dc103f5…`，`src/command.ts` sha256 `36285d3b…`，`src/herdr.ts` sha256 `7a82f592…`，见 `tree.txt`） |
| 平台 | `0.2.0`，端口 41778，一次性数据目录（run A：41777） |
| pi / herdr / node | 1.4.0 / 0.9.5 / v26.12.1 |
| 模型 | `deepseek/deepseek-flash`（子成员继承 settings 的 `defaultModel`，thinking=max） |
| root | 成员 `m_a95aa7`，pane `wE:p21`，`pi -ne -e <adapter> --model deepseek/deepseek-flash`（**只有 root 用 `-ne` 隔离**，它是探针自己的会话） |
| child 1 | 成员 `m_303c16`，pane `wE:p22`，pi pid 206890 |
| child 2 | 成员 `m_5572fc`，pane `wE:p23`，pi pid 221936 |
| 对照 | pane `wE:p24`，同一个 pi 加 `-ne`，只为 A/B |
| `PIGROUPS_SPAWN_CMD` | **全程未设置**。root 的 `/proc/<pid>/environ` 里没有它（`root-environ.txt`），所以 `resolveSpawnCmd()` 走的是默认值 |

`expected-spawn-cmd.txt`（run A）是代码对默认值的自述：

```
{ "entry": "/home/yang/Documents/pigroups-adapter/src/extension.ts",
  "command": "pi -e '/home/yang/Documents/pigroups-adapter/src/extension.ts'",
  "argv": ["pi","-e","/home/yang/Documents/pigroups-adapter/src/extension.ts"] }
```

## 2. Case 1：只给 name 和 brief

### 2.1 root 的调用实参（原文）

`root-session.jsonl`，`pg_spawn` 的 toolCall（时间 `14:30:15.747Z`）：

```json
{"name":"probe-one","brief":"You are probe-one. Do exactly two things, then stop. (1) Call the read tool once on /home/yang/Documents/pigroups-adapter/package.json. (2) Call the pg_say tool once with to=g:m_a95aa7 and text=probe-one: read the manifest. Use no other tool, and do not use intercom."}
```

没有 `cwd`，没有 `args`，没有第三个键。

### 2.2 子成员的启动行（原文）

**读自子成员自己的 pane 回滚**：`child1-pane-scrollback.txt` 第 1–2 行（`herdr pane read wE:p22 --source recent-unwrapped --lines 400`，在子 pi 退出、shell 回到前台之后抓的）：

```
pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
> pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
```

第二行带 `>` 是 bash 的 PS2 续行符——命令是 herdr 打进 pane 的 shell 的，回车后 shell
把它回显出来。同一个文件里这一对行还会再出现一次（第 138–139 行）：那不是重绘，是
`read_launch_line()` 依次追加的三个快照（`recent-unwrapped`、`recent`、`visible`）里的第二份。
**启动行里没有 `-ne`，也没有 `--no-extensions`；`-e` 指向本仓库的 `src/extension.ts`。**

为什么不用 `/proc`：pi 启动时 `process.title = "pi"`（`dist/bundle/cli-runtime.js` 的
`setupCli()`），内核里的 argv 被改写成只剩 `pi`。所以：

```
$ herdr pane process-info --pane wE:p22
"foreground_processes":[{"argv":["pi"],"cmdline":"pi","cwd":"/tmp/pgargsB-scratch.uOTfI0","name":"pi","pid":206890}]

$ od -c /proc/206890/cmdline
0000000   p   i  \0  \0  \0  \0  \0  \0  \0  \0  \0  \0  \0  \0  \0  \0
...
```

`herdr agent start` 的返回里其实有 argv（驱动自己起的对照 pi 就有：
`["pi","-ne","-e","/home/yang/Documents/pigroups-adapter/src/extension.ts",…]`），
但**适配器把这个返回丢掉了**，所以拿不到子成员的 `argv` 数组。旁证是子进程环境里的
基命令（`child1-launch-evidence.txt`）：

```
PIGROUPS_SPAWN_CMD=pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
```

这是 `spawnMember()` 写进子进程环境的 `config.spawnCmd`，也就是 `startAgent()` 前面那段
argv；case 1 没有 `args` 要接，所以它**就是**完整启动行，和回滚里的两行逐字相同。

### 2.3 子成员是正常 agent 的四条证据

1. **成员**：`/v1/tree`（root token）里有 `m_303c16`，`parent_id = m_a95aa7`（`tree-after-spawn1.json`）。
2. **收到 brief**：子会话第一条注入消息是 `[dm:m_303c16_m_a95aa7#1] root: You are probe-one. …`（`child1-session.jsonl`，`customType:"pigroups"`）。
3. **跑了一个工具**：`14:30:18.809Z read {"path":"/home/yang/Documents/pigroups-adapter/package.json",…}`，结果里是 `"version": "0.4.0+platform.0.2.0"`。
4. **人能从 human API 读到**：`GET /v1/messages?to=g:m_a95aa7`（human token）原文（`human-messages-group-root.json`）：

```json
{"items":[{"to":"g:m_a95aa7","seq":1,"sender_id":"m_303c16","sender_kind":"member",
  "sender_name":"probe-one","body":"probe-one: read the manifest","meta":null,"mentions":[],
  "created_at":1793543420309}],"next":null,"server_version":"0.2.0"}
```

它随后还调了 `pg_whoami` 和两次 `pg_say`（第一次因为写侧要求 `g:<owner>` 或成员 id 而被拒，
第二次成功），回了 root 的私聊（`dm:m_303c16_m_a95aa7` seq=2）——全部工具调用就是
`read`、`pg_say`、`pg_whoami`。

### 2.4 继承：这台机器上有可见证据

子成员的启动 banner（`child1-pane-scrollback.txt`，[Extensions] 段原文）：

```
[Extensions]
  @juicesharp/rpiv-ask-user-question, @juicesharp/rpiv-todo, @quintinshaw/pi-dynamic-workflows:workflow.ts, extension.ts,
herdr-agent-state.ts, pi-intercom, pi-straw-boss:src, pi-straw-boss:src/balance.ts, pi-straw-boss:src/blocked.ts, pi-subagents:bundle,
pi-web-access:dist
```

其中只有 `extension.ts` 是适配器用 `-e` 放进去的，其余全部来自用户 `~/.pi/agent/settings.json`
的 `packages` 和 `~/.pi/agent/extensions/`。子会话的 system prompt 里也直接列出了这些扩展注册的
工具（`child1-facts.txt`）：

```
builtinTools=read,bash,edit,write,codemode,web_search,source_check,fetch_content,get_search_content,web_enable,subagent,subagents_enable,ask_user_question,todo,intercom
```

`web_search`/`fetch_content`/`web_enable`/`get_search_content`/`source_check` 来自
`pi-web-access`，`subagent`/`subagents_enable` 来自 `pi-subagents`，`todo` 是
`@juicesharp/rpiv-todo`，`ask_user_question` 是 `@juicesharp/rpiv-ask-user-question`，
`intercom` 是 `pi-intercom`；`codemode` 是 pi 自带工具被 settings 的 `defaultTools:
["+codemode"]` 打开的。**适配器没有放这些进去。**

A/B（同一个 pi、同一个模型，只多一个 `-ne`，见 `control-probe/`）：

| | 启动参数 | banner `[Extensions]` | 会话里的内置工具 |
|---|---|---|---|
| 对照 | `-ne -e <adapter>` | `extension.ts` | `read,bash,edit,write` |
| case 1 子成员 | 默认（`-e <adapter>`） | 上表 11 项 | 上表 15 项 |

`-ne` 的定义（`pi --help`）是 “Disable extension discovery and built-in extensions
(explicit -e paths still work)”——所以对照里 `extension.ts` 仍在、发现来的那些消失。
子成员的 15 项工具因此**同时证明**两件事：`-e <adapter>` 生效了，`-ne`/`--no-extensions`
没有生效。

副作用核查：子会话里没有 `intercom` 的工具调用，也没有任何别的会话消息；工具调用只有
`read`/`pg_say`/`pg_whoami`。本轮没有消息经 `pi-intercom` 漏进用户主会话。
（只能证明"这一轮没漏"，不能证明"永远不会漏"——扩展确实加载了。）

**Case 1：PASS。**

## 3. Case 2：`args: ["--tools","read"]`

### 3.1 root 的调用实参（原文）

`root-session.jsonl`，`14:32:38.515Z`：

```json
{"name":"probe-two","args":["--tools","read"],"brief":"You are probe-two. Wait for a follow-up instruction, then answer it briefly and exactly."}
```

### 3.2 子成员的启动行（原文）

`child2-pane-scrollback.txt` 第 1–2 行（同样是在子 pi 退出后从 pane 回滚里读的）：

```
pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts --tools read
> pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts --tools read
```

run A 在子成员**活着**的时候也从 `--source visible` 抓到了同一行
（`../spawn-args-20261101T142109/banner/wE_p1Y/001.txt`）：

```
pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts --tools read
> pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts --tools read
```

环境里的基命令仍然只有默认那一段（`child2-launch-evidence.txt`）：

```
PIGROUPS_SPAWN_CMD=pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
```

即：基命令 + 调用方的 `args`，顺序不变，没有引号、没有改写。

### 3.3 `--tools read` 真的生效

子会话的 system prompt 里 pi 只启用了 `read`（`child2-facts.txt`）：

```
builtinTools=read
toolCalls=(none)
```

`toolCalls=(none)` 是关键：整个会话里没有任何工具调用，尤其没有 `bash`。
落盘标记 `bash-ran.txt`：

```
bash-ran absent
```

### 3.4 子成员自己的拒绝原文（verbatim）

驱动直接对这个 pane 发一条指令（`prompt2-bash.txt`：

> Use the bash tool to run exactly this command: touch /tmp/pgargsB-scratch.uOTfI0/bash-ran
> then report the verbatim result. If you cannot run it, say exactly which tools you do have available and why the command cannot be run.

子成员的回答（`child2-session.jsonl`，`14:39:49.473Z`，`stopReason: stop`）：

```
无法执行。我当前可用的工具只有 `read`（读取文件内容，支持文本与图片），没有任何可执行命令的工具：没有 bash / shell / exec 类工具，因此 `touch /tmp/pgargsB-scratch.uOTfI0/bash-ran` 无法运行，也就没有 verbatim 结果可报。

若需要落地该文件，请在该 tab 会话中由具备 bash 工具的 agent 执行，或为我启用命令执行工具。
```

run A 的同一个 case 用英文拒绝（`../spawn-args-20261101T142109/child2-facts.txt`）：

```
I cannot run it: the only tool available to me is `read` (file reading, no execution). No `bash`/shell tool is exposed in this session, so `touch /tmp/pgargs-scratch.AaKbIg/bash-ran` was not executed and there is no command output to report verbatim.
```

这不是"因为别的原因拒绝"：拒绝理由就是工具表里没有执行类工具，而工具表本身
（`builtinTools=read`）和落盘标记（不存在）各自独立成立。

**Case 2：PASS。** 如果 `args` 被吞掉，子成员会是默认工具表（15 项，含 bash），
`bash-ran` 会存在；两个观测都不成立。

## 4. 判定表

| 观测 | 判据 | 结果 | 证据 |
|---|---|---|---|
| C1-a root 只传 name+brief | 实参只有两个键 | PASS | `root-session.jsonl` 的 toolCall |
| C1-b 启动行含 `-e <adapter>` | pane 回滚第 1 行 | PASS | `child1-pane-scrollback.txt` |
| C1-c 启动行不含 `-ne`/`--no-extensions` | 同上 + 15 项工具 + `-ne` 对照只有 4 项 | PASS | §2.2、§2.4 |
| C1-d 子成员正常 | 成员、brief、read 工具、human API 一句话 | PASS | §2.3 |
| C1-e 继承 | 有可见证据（11 项扩展 + 15 项工具） | PASS（并已报告） | §2.4 |
| C2-a 启动行尾接 `--tools read` | pane 回滚第 1 行 | PASS | `child2-pane-scrollback.txt` |
| C2-b 旗标生效 | `builtinTools=read`（唯一） | PASS | `child2-facts.txt` |
| C2-c 跑不了 shell | 拒绝原文 + `toolCalls=(none)` + `bash-ran` 不存在 | PASS | §3.3、§3.4 |

## 5. 附带发现（与 args 透传无关，但本轮真机撞上的）

### 5.1 `pg_spawn` 的 readiness 等待误报超时（既有 bug）

两次 `pg_spawn` 的 tool result 都是 `isError=true`、正文一字不差：

```json
[{"type":"text","text":"timed out waiting for agent status"}]
```

时间：`14:30:15.747Z` 调用 → `14:32:29.872Z` 失败（134.1 s）；第二次
`14:32:38.515Z` → `14:34:42.304Z`（123.8 s）。root 把这次失败写进了自己的回答
（"the spawn call timed out waiting for agent status"），但子成员当场就在正常工作。

根因复现（`ready-probe/`，同一个 pi，只多一个 `-ne`）：

| 状态 | 命令 | 结果 |
|---|---|---|
| 还没跑过任何一轮 | `herdr agent wait <pane> --until idle --timeout 60000` | exit 0，`agent_status:"idle"` |
| 跑完一轮之后（`agent_status:"done"`） | `herdr agent wait <pane> --until idle --timeout 8000` | **exit 1，`{"error":{"code":"timeout","message":"timed out waiting for agent status"}}`** |
| 同上 | `herdr agent wait <pane> --until done --timeout 8000` | exit 0，`agent_status:"done"` |
| 同上 | `herdr agent wait <pane> --until idle --until done --timeout 8000` | exit 0 |

`pg_spawn` 先投 brief、再起 pane，所以子成员几乎立刻就进入第一轮；`waitReady()` 只等
`idle`，而 pi 结束一轮后 herdr 记的是 `done`，于是**每次 spawn 都会走满
`SPAWN_READY_MS` 再报错**。修法很短（`--until idle --until done`，herdr 本来就支持重复
`--until`），但那是行为改动 + 测试，不属于本轮；本轮只记录，不改 `src/`。

### 5.2 `--tools read` 会连适配器自己的 9 个工具一起切断

`--tools` 是"允许清单"，它挡的不只是内置工具：case 2 的子成员没有 `pg_say`，因此无法
回复 `pg_spawn` 发的那条 brief 私聊。适配器的欠账提醒于是每 ~2 s 注入一次
（`customType:"pigroups"`：`你在这些会话还有未回复的消息：dm:… #1。回复，或说明为什么不需要回。`），
子成员越回越被催，永远不 `idle`——这也让 `herdr agent wait --until idle` 在 case 2 里
5 分钟都等不到（`wait-child2.json`）。这不是 bug（允许清单是调用者的选择），但值得记下：
**用 `--tools` 收窄子成员时，适配器工具也会被收窄**，子成员会变成"只能听、不能说"。

### 5.3 三条关于"启动行能不能读到"的事实

1. herdr 把启动命令打进 pane 的 shell（所以 shell 会回显）；这是本轮最直接的 argv 证据。
2. pi 改掉自己的 `process.title`，`/proc/<pid>/cmdline` 与 `herdr pane process-info` 只剩
   `["pi"]`——**别指望从进程表读 argv**。
3. `herdr agent start` 的返回里有 `argv`，但适配器 `HerdrCli.spawn()` 把它丢了；
   要把它变成证据，得让适配器记日志或落盘——产品决定，本轮不动。

## 6. 清理

两次 run 的收尾（`panes-after-cleanup.json` / `tabs-after-cleanup.json`）：

```
new panes vs baseline after cleanup: ' '
pane sets equal: true
tab sets equal: true
platform port 41778 closed
```

- 造出来的 pane 全部 `herdr pane close`，tab 全部 `herdr tab close`；最终 pane 集合与
  baseline 相同（`wD:p1E wE:p1 wE:p12 wE:p1J`），tab 集合相同（`wD:tD wE:t1 wE:tT wE:tW`）——
  只剩 boss 自己的 pane 和 tab。
- 平台进程 `206158` 已停，端口 41778 不再应答；run A 的 41777 同样已关。
- 子成员没有 `--session-dir`（默认启动行不加），会话落在
  `~/.pi/agent/sessions/--tmp-pgargsB-scratch.uOTfI0--/`：复制到
  `children-session-originals/` 后删除，用户会话目录里没有残留；root/对照的
  `--session-dir` 是 `/tmp` 下的一次性目录，随 run 一起删掉。
- 未设置、也未读取被改坏的 `~/.pi/agent/settings.json`；平台仓库只被 `node src/main.ts`
  读过、跑过，没有改动（`git -C ~/Documents/PiGroups status` 干净）。

## 7. 复跑

```bash
# 一次完整的 run（这次用了约 10 分钟：两次 readiness 误报各白等 120 s，case 2 还等了 5 分钟 idle）
bash probe/logs/spawn-args-20261101T142926/driver.sh

# 只复现 readiness 误报
bash probe/logs/spawn-args-20261101T142926/ready-probe.sh

# 只做 -ne 的 A/B（banner + 内置工具表）
bash probe/logs/spawn-args-20261101T142926/control-probe.sh
```

`driver.sh` 自己起一次性平台（端口 41778）与一次性数据目录，收尾时关掉它造的每个
pane/tab 并核对集合；`PIGROUPS_SPAWN_CMD` 在脚本开头被 `unset`，并且会断言它确实不在
root 的环境里——默认值是这一轮的被测对象。
