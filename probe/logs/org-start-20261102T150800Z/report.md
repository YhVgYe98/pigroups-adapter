# `pg_org_start` 真机验证（2026-11-02）

**结论：PASS 5/5（最终一轮）。**

树：适配器 `71c6951`（`0.6.0+platform.0.2.0`），平台 `210ed07`（`0.2.0`），pi `1.4.0`，
herdr `0.9.5`。平台仓库 `git status` 干净，验证期间没有改过 `../PiGroups`。

## 方法

- 根会话用**用户设置里同一个包**启动：`pi list` 显示
  `../../Documents/pigroups-adapter → /home/yang/Documents/pigroups-adapter`（`pi-list.txt`）。
  为了不把 `pi-straw-boss` / `pi-intercom` 等无关全局扩展带进探针（上一次 level-4 探针
  记录过它们会改用户的 tab、把消息转进主会话），本轮用了一个临时的
  `PI_CODING_AGENT_DIR`，其中 `settings.json` 只声明同一个包路径（`agent-settings.json`）。
  扩展与 skill 的加载路径和真实安装相同，只是没有别的包。
- `PIGROUPS_ADAPTER_DIR` 指向临时目录；根会话**没有** `PIGROUPS_URL` / `PIGROUPS_TOKEN`
  （`/proc/<root pid>/environ` 检查，见 `run.txt` 的 `1.0b`）。
- 一个被动观察扩展 `observe.ts` 只读 `pi.getActiveTools()` / `pi.getAllTools()`，在
  `session_start` 和每次 `tool_execution_end` 写一行 JSON；它**不注册任何工具**，所以模型看到的
  工具面就是适配器真实注册的那一组（`tools-events.jsonl`）。
- 平台进程按 `/proc/<pid>/cmdline` 含 `src/main.ts` 且环境里
  `PIGROUPS_DATA=<data_dir>` 来数（`platform-instances.mjs`），不信任 `org.json` 的 pid。

原始驱动：`driver.sh`（本轮完整可复跑）。临时数据目录在收尾时删除，留下的都是下面列出的
证据文件。

## 逐项结果

### 1. 无身份会话只有 `pg_org_start`，调用后成为根 — PASS

- 调用前 pi 的 active 工具（适配器部分）：`pg_org_start`；同时有 pi 自带的
  `read,bash,edit,write`，没有别的 `pg_*`（`tools-before.txt`、`tools-events.jsonl` 第一条）。
- 工具调用实参是 `{"name":"probe-root"}`，**没有传 `platform_dir`**，走的是默认
  `../PiGroups` 发现路径（`root-tool-calls.txt`）。
- 工具返回（`root-answer-org-start.txt`）：
  `url=http://127.0.0.1:45307`、`pid=650523`、
  `data_dir=/tmp/pgorg-probe.IoX2Vt/adapter/platform-data`、
  `platform_dir=/home/yang/Documents/PiGroups`、`root=m_94c01b`、`reattached=false`。
- `GET /v1/health` 答 `status:ok`；`whoami` 的 `member.is_root=true`
  （`whoami-root.json`、`org.json`）。
- `org.json` 模式 `600`（`org-json-mode.txt`）；平台日志在
  `<data_dir>/platform.log`（`adapter-state/platform.log`）。
- 调用后 active 工具立即变成
  `pg_org_start + pg_abort,pg_children,pg_inspect,pg_members,pg_read,pg_say,pg_schedule,pg_spawn,pg_terminate,pg_whoami`
  （`tools-after.txt`、`tools-events.jsonl` 的 `tool_execution_end` 行）。模型也读到了这十个
  （`tools-after-model.txt`），随后真的调用了 `pg_spawn`。

### 2. 根用一次 `pg_spawn` 拉起子成员，子成员加入同一平台并回答 — PASS

- 平台树在根下面出现 `m_629162 / probe-child`（`tree-after-spawn.json`）。
- 子 pane 是 `wE:p3K`，子 pi pid 650880（`child-process-info.json`）。
- 子会话里 `pg_say` 的**成功 toolResult** 是
  `{"conv":"g:m_94c01b","seq":1}`（`child-tool-calls.txt`、`sessions/child.jsonl`）。
- 人用 human token 读到群消息：
  `sender_name=probe-child, body="probe-child joined the same platform and answered"`，
  `seq=1`（`messages-group.json`）。
- 这一步没有手工起平台、没有手工 bootstrap、没有给根传 URL/token；子成员身份来自
  `pg_spawn` 自己。

### 3. 组织比根 session 活得久 — PASS

- 杀根 pi pid `650346` 后进程消失（`3.1`）。
- 平台仍然答 `/v1/health`（`3.2`）。
- 子成员 `last_seen_at` 在根死后继续前进：
  `1793632260997 → 1793632284427`（约 23.4 s；`child-before-root-kill.json` /
  `child-after-root-kill.json`）。这是子成员自己的 poll 在鉴权，不是平台心跳。
- 平台进程 pid `650523` 没变，`GET /v1/tree` 仍返回根和子（`tree-after-root-kill.json`）。

### 4. 后来的无身份会话重接，而不是起第二个平台 — PASS

- 新 pane `wE:p3M`，新 pi 会话；调用前 active 适配器工具仍只有 `pg_org_start`
  （`reattach-tools-before.txt`、`tools-events-reattach.jsonl`）。
- 工具调用实参 `{}`（`reattach-tool-calls.txt`）。
- 返回 `reattached=true`，URL 仍是 `http://127.0.0.1:45307`，root 仍是 `m_94c01b`，
  pid 仍是 `650523`（`reattach-answer.txt`、`org-after-reattach.json`）。
- 重接前后按数据目录数平台进程都只有 **1** 个，且是同一个 pid
  （`platform-before-reattach.txt` / `platform-after-reattach.txt`）。

### 5. 收尾干净 — PASS

- pane 基线 `wD:p1E wE:p1 wE:p12 wE:p2Q wE:p36 wE:p3B wF:p2 wF:p4`，最终完全一致，
  没有新增、没有缺失（`pane-diff.txt`、`panes-baseline.json`、`panes-final.json`）。
- 平台被停掉：pid `650523` 不再存在，`platform-after.txt` 为空，
  `http://127.0.0.1:45307/v1/health` 不再应答。
- 临时目录 `/tmp/pgorg-probe.IoX2Vt` 已删除；没有残留的 `PiGroups/src/main.ts` 进程。

## 测试套件

- `npm run typecheck`：干净。
- `npm test`：第一次 131/132，唯一失败是
  `test/delivery.test.ts:156` 的 `EADDRINUSE`（测试自己挑的空闲端口在 spawn 前被别的进程占走，
  `support.ts` 的 free-port 竞态），不是 `pg_org_start`；重跑 **132/132**。这条竞态本身值得
  以后修，但不影响本轮的结论。

## 与文档的出入

1. **`pg_org_start` 在成功之后仍然留在工具面上。** `tools-after.txt` 明确包含
   `pg_org_start + 十个成员工具`。`docs/概念稿.md:230` 写“只在你还不是成员时存在……有身份的
   会话里根本不注册它”，`skills/pigroups-org/SKILL.md:33` 写“已经有身份……的会话里没有这个
   工具”。实际行为是：**启动时**有 `PIGROUPS_URL` + `PIGROUPS_TOKEN` 的会话不注册它；而一个
   刚用 `pg_org_start` 开出组织的同一会话，工具无法注销，仍会看到它，再调会得到
   `already_member:true`（`src/extension.ts` 的分支，设计说明 §8.1 也写了）。建议把这两处改成
   “只在启动时无身份才注册；成功后保留但只回答已属于 `<url>`”，否则 skill 的“看得到其它
   `pg_*` 就没有这个工具”会和模型的真实工具表相反。
2. **设计说明 §8.4 关于删掉 `org.json` 的说法不成立**（静态检查，本轮未复现）：
   `docs/设计说明.md:705-706` 说“删掉它等于下一次开一个新组织；旧平台若还活着会占着旧端口，
   但新启动会挑空闲端口，不会有两个进程写同一个库”。`src/org.ts` 在没有 `previous` 时把
   `dataDir` 默认成同一个 `<adapterDir>/platform-data`，所以旧平台活着、`org.json` 被删时，
   新启动会挑新端口但**同一个数据库目录**，确实可能出现两个平台进程写同一个库。这与
   概念稿无关，但和设计说明的生命周期承诺相反。

## 试跑记录

`attempts/` 保留了前三次驱动输出（不是产品失败）：

- 第 1 次：pi 的 session 文件要到第一次 prompt 才创建，驱动在 prompt 前等文件，超时。
- 第 2 次：观察器 JSON 解析脚本里用了顶层 `return`，工具列表读成空；另外重接 pane 的 env
  拼接多了一个 `--env`。
- 第 3 次：子成员那次遇到 provider 连续 5 次 `Connection error`，驱动在它真正发出 `pg_say`
  之前就查群消息；另外重接 session 文件同样在 prompt 前等待。修的是驱动，不是 `src/`。

最终一轮（`run.txt`）没有重试或手工补步骤，5 项全绿。

## 证据索引

| 文件 | 内容 |
|---|---|
| `run.txt` | 最终一轮完整时间线 |
| `tree.txt` | commit / 版本 / pi / herdr / 平台 commit / 用户设置里的包条目 |
| `pi-list.txt` | `pi list` 证明包确实装在用户设置里 |
| `agent-settings.json` | 探针用的隔离 settings（只含同一个包路径） |
| `tools-events.jsonl` / `tools-events-reattach.jsonl` | pi 自己的 active/all 工具集 |
| `tools-before.txt` / `tools-after.txt` / `reattach-tools-before.txt` | 适配器工具面 |
| `root-tool-calls.txt` / `reattach-tool-calls.txt` / `child-tool-calls.txt` | 三个会话的实际工具调用 |
| `root-answer-org-start.txt` / `reattach-answer.txt` | 两次 `pg_org_start` 的返回 |
| `org.json` / `org-after-reattach.json` / `org-json-mode.txt` | `org.json` 内容与权限 |
| `whoami-root.json` / `tree-root.json` / `tree-after-spawn.json` | 根身份、树 |
| `child-before-root-kill.json` / `child-after-root-kill.json` | 子成员 `last_seen_at` |
| `messages-group.json` / `human.json` | 群里那条回答 |
| `platform-before-reattach.txt` / `platform-after-reattach.txt` / `platform-after.txt` | 平台进程计数 |
| `panes-baseline.json` / `panes-final.json` / `pane-diff.txt` | pane 基线对比 |
| `sessions/` | 根、重接、子成员的 pi session 原文 |
| `adapter-state/` | 收尾前的 `org.json`、平台日志、子成员注入水位 |
| `attempts/` | 前三次驱动输出与当时的 session |
