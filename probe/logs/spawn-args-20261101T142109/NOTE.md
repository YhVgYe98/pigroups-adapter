# run A（旁证）

这是 `pg_spawn` args 透传真机验证的**第一次**运行；主记录与结论在
`../spawn-args-20261101T142926/report.md`（run B）。两次跑的是同一份驱动逻辑，
本目录独有：

- `banner/wE_p1X/004.txt`：只给 `name` + `brief` 的子成员，活着时的启动 banner——
  `[Skills]`、`[Prompts]`、`[Extensions]`（11 项，含 `extension.ts`）。
- `banner/wE_p1Y/001.txt`：带 `args: ["--tools","read"]` 的子成员，**活着时**从
  `--source visible` 抓到的启动命令回显：
  `pi -e /home/yang/Documents/pigroups-adapter/src/extension.ts --tools read`。
- `control-banner.txt`：同一个 pi 加 `-ne` 的对照 banner，`[Extensions]` 只有
  `extension.ts`。
- `child1-*.jsonl` / `child2-*.jsonl`：两次子成员的会话；`child2-facts.txt` 里是
  case 2 的英文拒绝原文。

run A 的两处缺口（run B 补齐）：启动行没有从 pane 回滚里取（只抓到了 child 2 活着时的那次），
root 的会话文件没复制（pi 要跑完一轮才落盘，`find` 太早）。清理与 run B 一样做过：
`panes-new-after-cleanup.txt` / `tabs-after-cleanup.txt` 里集合与基线相同。
