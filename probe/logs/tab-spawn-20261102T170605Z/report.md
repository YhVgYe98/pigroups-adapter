# `pg_spawn` 把成员放进新 tab —— 真机验证（2026-11-02）

**结论：PASS 9/9。** 一次 `pg_spawn` 在根的 workspace 里开出一个新 tab（label = 成员名），
子成员就在那个 tab 的 root pane 里；根自己的 tab 仍然只有它那一个 pane（没有分栏）；操作者原有
17 个 pane 全部原样留在原来的 tab 里；`pg_terminate` 之后子 tab 连同 pane 一起消失。

树：适配器 `cb4e70b`（`0.6.0+platform.0.2.0` + 未提交的 `src/herdr.ts` / `test/herdr.test.ts`
改动 = 本次要落的那一笔），平台 `210ed07`（`0.2.0`），pi `1.4.0`，herdr `0.9.5`，
node `v26.12.1`。平台仓库在这场运行里没有被修改（`tree.txt`）。

## 为什么要在真机上验

`HerdrCli.spawn` 从 `pane split --direction down` 改成 `tab create --no-focus --label <name>`
（上级的原话：“spawn 出来的放在新 tab 里，只要在同一个 workspace 就好，没必要放在一个 tab 中”），
pane id 改从 `root_pane.pane_id` 取。单测只能证明 argv 和取值路径；三件事只有真机能回答：

1. `tab create` 不带 `--workspace` 时，新 tab 落在**调用方所在的 workspace**，而不是当前焦点所在的
   workspace（本机焦点在 `wF:t3`，根在 `wE`）；
2. `root_pane.pane_id` 里的 pane 就是 `agent start` 之后子成员真正待着的那个 pane；
3. 子 tab 在 `pg_terminate` 之后是不是真的消失（关掉 tab 的最后一个 pane 会不会留下空壳）。

## 方法

`driver.sh` 是本轮的完整驱动，可原样复跑：

```bash
bash probe/logs/tab-spawn-20261102T170605Z/driver.sh
```

1. **一次性平台**：`PORT` 用内核分配的空闲端口，`PIGROUPS_DATA` 指向 `mktemp -d` 目录，
   `PIGROUPS_ADMIN_TOKEN` 每次新生成（`platform.log` 是它的输出）。
2. **一个根**：`POST /v1/bootstrap` 换 root id + token；根自己的 tab 用
   `herdr tab create --workspace wE --label tabspawn-root --env PIGROUPS_URL/PIGROUPS_TOKEN/PIGROUPS_ADAPTER_DIR`
   建，`herdr agent start` 的命令是 `-ne -e /home/yang/Documents/pigroups-adapter/src/extension.ts`
   —— 只装这一个扩展，不带全局包。
3. **没有 `PIGROUPS_SPAWN_CMD`**：驱动 shell、herdr server、根进程三处都断言过（2.1 / 2.1b），
   所以 `pg_spawn` 用的是默认的自加载命令 `pi -e <本仓库>/src/extension.ts`。子成员的环境里
   能直接读到这个默认值（3.5），子成员的 `[Extensions]` banner 也证明它是“自加载 + 继承操作者
   全部扩展”，不是 `-ne`（3.5b）。
4. 根被要求**只调用一次** `pg_spawn`（`name=tab-child`，`cwd` 指向临时目录，不传 `args`），
   然后在 spawn 前后各采一次 `herdr tab list` / `herdr pane list` / `GET /v1/tree`。
5. 子成员说一句话，用 human token 按人读消息的方式取回。
6. 根再**只调用一次** `pg_terminate`，然后重新采 tab/pane/tree，并等 tab 消失。
7. 收尾：关探针 tab、停平台、删临时目录、删子成员的临时 session 目录，打印与第 0 步基线的
   pane/tab 差异。

采样时间窗内一共 9 项检查，全部通过（`run.txt` 里的 `PASS` 行；`SUMMARY failed=0`）。

## 逐项证据

### 3.1 新 tab 出现，label 是成员名，workspace 等于根的 workspace —— PASS

`tabs-before-spawn.txt`（spawn 之前，`wE:t2C` 是探针给根建的 tab）与
`tabs-after-spawn.txt`（spawn 之后）：

```
wE:t1	PiGroups 实现	panes=1	working	wE
wE:tT	3	panes=1	unknown	wE
wE:t1F	4	panes=1	unknown	wE
wE:t23	5	panes=1	unknown	wE
wE:t2C	tabspawn-root	panes=1	idle	wE
--- after spawn ---
wE:t2C	tabspawn-root	panes=1	done	wE
wE:t2D	tab-child	panes=1	done	wE
```

```
[check-new-tab] label="tab-child" (expected "tab-child") workspace=wE (root workspace wE)
                panes=1 agent_status=done
PASS  3.1 one new tab appeared, label 'tab-child', workspace wE (wE:t2D)
```

新增恰好一个 tab；`workspace_id=wE`，与根 tab `wE:t2C` 相同。适配器不传 `--workspace`，herdr 用
调用方 pane 的 workspace 解析（根 pi 的 `HERDR_WORKSPACE_ID=wE`）。**这一点本轮单独量过**：在
`wE:p1` 的 shell 里（此时焦点在 `wF:t3`）执行 `herdr tab create --no-focus --label probe-ws-test`，
返回的是 `wE:t28` / `wE:p3N`，即调用方的 workspace，不是焦点 workspace；测完立即 `herdr tab close`。

### 3.2 子成员的 pane 就在这个新 tab 里 —— PASS

`panes-after-spawn.txt` 里新增的两行（pane → tab 映射）：

```
wE:p3S	tab=wE:t2C	ws=wE	agent=pi	done     <- 根
wE:p3T	tab=wE:t2D	ws=wE	agent=pi	done     <- 子成员
```

```
[check-child-pane] tab=wE:t2D (child tab wE:t2D) workspace=wE agent=pi status=done
PASS  3.2 the new pane wE:p3T belongs to tab wE:t2D
```

子成员 pid 36734，`/proc/36734` 的 cwd 是 `pg_spawn` 传的 `cwd`（`child-process-info.json`）。

### 3.3 根自己的 tab 没有多出第二个 pane —— PASS

```
[check-root-tab] before=[wE:p3S] after=[wE:p3S] ok
PASS  3.3 the root's tab still has exactly its one pane; no split beside the operator
```

`tabs-after-spawn.txt` 里 `wE:t2C` 仍是 `panes=1`。这正是这次改动的目的：成员不再挤在操作者
正在看的那个 tab 里。

### 3.4 操作者原有的 tab/pane 布局没有被碰 —— PASS

```
[check-layout-untouched] baseline panes=17 still present and in place=17 ok
PASS  3.4 every pre-existing pane is still there, in the same tab
```

17 个基线 pane（`wD:p1E`、`wE:p36`、`wE:p1`、`wE:p12`、`wE:p2Q`、`wE:p3B`、`wF:p2`、
`wF:t3` 的 ten 个 pane 等）逐个比对 pane_id 与 tab_id，全部一致；tab 列表顺序也没变（新 tab 只会
追加在末尾）。收尾时的差异是空的：

```
layout diff: panes baseline=17 final=17 added=[] missing=[] tabs baseline=8 final=8 added=[] missing=[]
```

### 3.5 / 3.5b 子成员跑的是默认自加载命令 —— PASS

根进程的环境里没有 `PIGROUPS_SPAWN_CMD`（`root-env.txt`）：

```
PASS  2.1 PIGROUPS_SPAWN_CMD is not set in the root environment (default command in play)
PASS  2.1b the herdr server environment carries no PIGROUPS_SPAWN_CMD
```

适配器把**自己的** `config.spawnCmd` 放进子成员环境，于是子成员 `PIGROUPS_SPAWN_CMD` 的实测值就是
默认值（`child-env.txt`）：

```
PIGROUPS_ADAPTER_DIR=/tmp/pgtab-probe.qpTKCI/adapter
PIGROUPS_SPAWN_CMD=pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
PIGROUPS_TOKEN=pgt_0af1a486...
PIGROUPS_URL=http://127.0.0.1:32917
PASS  3.5 the child's command is the default self-loading one: pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts
```

子成员 pane 的启动 banner 是第二个独立证人（`child-extensions-banner.txt`）：`-ne` 只会列出
`extension.ts` 一个，这里列出的是操作者的整套扩展**加上** `extension.ts`，说明子成员用的是默认
命令（自加载本扩展、继承操作者的环境）：

```
[Extensions]
  @juicesharp/rpiv-ask-user-question, @juicesharp/rpiv-todo, @quintinshaw/pi-dynamic-workflows:workflow.ts, extension.ts,
herdr-agent-state.ts, pi-intercom, pi-straw-boss:src, pi-straw-boss:src/balance.ts, pi-straw-boss:src/blocked.ts, pi-subagents:bundle,
pi-web-access:dist
PASS  3.5b the child's [Extensions] banner lists extension.ts among the inherited extensions (self-loading default, not -ne)
```

### 3.6 子成员是成员，挂在根下面 —— PASS

根那次 `pg_spawn` 的返回（`sessions/root-after-spawn.jsonl`）：

```
{"id":"m_820d1b","name":"tab-child"}
```

平台的成员记录（`member-child-after-spawn.json`）：

```json
{"id":"m_820d1b","name":"tab-child","parent_id":"m_44d178","status":"alive","is_root":false,
 "groups":[{"to":"g:m_44d178","owner":"m_44d178"}],"server_version":"0.2.0"}
```

### 3.7 子成员说了人读得到的一句话 —— PASS

群里的一条消息，用 human token 按 `GET /v1/messages?to=g:<root>` 读回（`messages-group.json`）：

```json
{"to":"g:m_44d178","seq":1,"sender_id":"m_820d1b","sender_kind":"member",
 "sender_name":"tab-child","body":"tab-child is in its own tab and answering"}
```

子成员自己的会话文件（`sessions/child.jsonl`）里那次 `pg_say` 的结果：

```
{"role":"toolResult","toolName":"pg_say","content":[{"type":"text","text":"{\"conv\":\"g:m_44d178\",\"seq\":1}"}],"isError":false,"durationMs":3}
```

子成员的收尾发言（`child-answer.txt`）：

```
Message sent to `g:m_44d178` (seq 1): "tab-child is in its own tab and answering". Stopping there — no further work queued, standing by for the next task.
```

### 4. `pg_terminate` 之后子 tab 消失 —— PASS

根的 `pg_terminate` 返回（`root-pg-terminate-result.txt`）：

```
{"terminated":["m_820d1b"],"pane_close_failed":[],"pane_close_forced":[]}
```

`tabs-after-terminate.txt`（`wE:t2D` 不再出现，顺序回到 spawn 之前 + 根）：

```
wE:t2C	tabspawn-root	panes=1	done	wE
wF:t2	󰐻	panes=1	idle	wF
wF:t3	量化研究组织	panes=10	working	wF
```

```
PASS  4.1 the child's tab wE:t2D is gone from herdr tab list
PASS  4.2 the child's pane wE:p3T is gone from herdr pane list
PASS  4.3 the child pi process 36734 is gone
PASS  4.4 the child is gone from /v1/tree
```

**tab 不是空壳，也没有留下 pane。** 这不是运气：herdr 0.9.5 关掉一个 tab 的最后一个 pane 时会把
tab 一起关掉，本轮开工前单独量过（建 `wE:t29`，只 `herdr pane close wE:p3P`，随后 `tab list` 里
`wE:t29` 与 pane 都不在）。适配器的 `close()` 走的正是 `herdr pane close`，所以“pane close 之后
tab 跟着消失”是可复现的 herdr 行为，不是本轮的偶发。

根 tab 在整轮里始终是 `before=[wE:p3S] after=[wE:p3S]`（`check-root-tab-after-terminate.txt`）。

## 收尾

- 探针 tab（根）已关：`herdr pane close wE:p3S` → tab `wE:t2C` 随之消失（`tab close` 返回 1，
  因为 pane 关掉时 tab 已经不在了）。
- 平台 pid 36037 收到 SIGTERM 后退出；`/v1/health` 不再应答。
- `/tmp/pgtab-probe.qpTKCI` 已删除；子成员那个临时 cwd 的 session 目录
  `~/.pi/agent/sessions/--tmp-pgtab-probe.qpTKCI-child--` 也在取证后删掉。
- pane/tab 差异为空（见 3.4 的 `layout diff`）。

## 复跑记录

`attempts/run-1/` 是同一驱动的第一次运行（`2026-11-02T17:07:02Z`）：结论相同（PASS），但驱动当时
把子成员的 session 目录猜成了“子进程 cwd 下”，而它其实在操作者的 agent dir 下
（`~/.pi/agent/sessions/--<cwd>--`），所以缺 `child-env.txt` / `child-extensions-banner.txt`
与 `child-pg-say-result.txt` 三项证据。改的是驱动，不是 `src/`；本目录下的产物全部来自第二次
运行（`2026-11-02T17:07:47Z`）。

## 顺带记下的一件事（不是这次改动的判据）

默认命令意味着子成员**继承操作者的全部扩展**（banner 里的 `pi-straw-boss`、`pi-intercom` 等）。
这是设计上写明的（“像是人在那个 pane 里自己起了 pi”），本轮没有发现它动布局：`wE` 本来就有
tower，新成员进来没有开新 tab，`pi-straw-boss` 的“tidy tabs”只整理自己所在的（单 pane）tab。
若换到一个还没有 tower 的 workspace 里 spawn，`pi-straw-boss` 按自己的规则可能开一个 tower tab
——那会是那个扩展的行为，而不是适配器多开了 tab。
