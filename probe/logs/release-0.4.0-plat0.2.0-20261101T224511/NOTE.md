# 发版证据：适配器 `0.4.0+platform.0.2.0`

这个目录是 `v0.4.0+platform.0.2.0` 这个标签的打包证据。真机（平台 0.2.0 + pi）的
`pg_spawn` 证据不在这里，在 `probe/logs/spawn-args-20261101T142926/`（主）与
`probe/logs/spawn-args-20261101T142109/`（佐证）；两处一起构成这次发版的验证。

## 版本与测试

| 文件 | 内容 |
|---|---|
| `version.txt` | 三处版本：`package.json`、`src/version.ts` 的常量、lockfile 两处，都是 `0.4.0+platform.0.2.0` |
| `test.txt` | `npm test`：103 tests / 103 pass / 0 fail，`test exit=0` |
| `typecheck.txt` | `npm run typecheck`：`tsc --noEmit` 无输出，`typecheck exit=0` |

## 打包与“打出来的那份能加载”

| 文件 | 内容 |
|---|---|
| `npm-pack.txt` | `npm pack` 的输出：`pigroups-adapter-pi-0.4.0+platform.0.2.0.tgz`，shasum `0b5cf0dbb227560c893cab6842d83401edf27b60`，16 个文件 |
| `tarball-contents.txt` | `tar -tzvf` 的 16 行：`package.json`、`README.md`、`CHANGELOG.md`、4 个 `docs/`、10 个 `src/*.ts`；不含 `test/`、`probe/`、lockfile |
| `packdir.txt` | 本次的临时目录（`/tmp/pigroups-release4.Qa6L3X`），tarball 在里面；临时目录重启就没了，要重现就重新 `npm pack` |
| `load-proof.mjs` / `load-proof.txt` | 解包副本的静态+动态加载证明，9 条全 PASS（见下）；解包在 `/tmp/pigroups-release-final/package` |
| `pi-load-agent-start.json` | herdr 起子进程的返回：`argv: ["pi","-e","/tmp/pigroups-release-final/package/src/extension.ts","--no-session","--verbose"]` |
| `pi-load-pane.txt` | 那次启动的 pane 回滚：`[Extensions]` 的 `path` 组列出解包副本的 `src/extension.ts`——pi 自己报告它加载了这份文件 |
| `pi-load-json-mode.stderr.txt` | `pi -e <解包副本>/src/extension.ts --mode json` 的 stderr：`[pigroups] adapter 0.4.0+platform.0.2.0 starting against http://127.0.0.1:9`，退出 0 |
| `pi-load-json-mode.stdout.txt` | 同一次运行的 stdout：一条 `session` 事件，没有别的 |
| `pi-load-tab.json` / `pi-load-pane-close.json` / `pi-load-tab-close.json` / `panes-after-cleanup.txt` | 清理痕迹 |

**shasum 为什么只写在这里。** tarball 里装着 `CHANGELOG.md` 和 `docs/`；把 shasum 写进
`CHANGELOG.md` 或 `docs/handoff.md` 就会改掉 tarball 的内容，shasum 立刻作废。所以文档里只写
tarball 名，shasum 留在本文件（`probe/` 不在 `files` 里，不进包）。

`load-proof.mjs` 对**解包后的副本**（不是仓库工作树）做九条检查：

1. `package.json` 的 `name` / `version`；
2. `pi.extensions` 恰好一项，且 `./src/extension.ts` 在包里存在；
3. `src/` 里有 TypeScript 模块；
4. 20 条相对 import 全部解析到包内文件（少一个文件，pi 会在 import 期就失败，而不是安装期）；
5. `import()` 入口成功，`default` 是扩展函数、`EXTENSION_ENTRY` 指向解包路径、
   `defaultSpawnCmd()` 得到 `pi -e /tmp/pigroups-release-final/package/src/extension.ts`。

`pi-load-json-mode` 那条是最硬的一条：`[pigroups] adapter … starting against …` 是
`src/extension.ts` 在 `init()` 里打的，能打出来就说明整条模块图（`command` / `loop` / `herdr` /
`pgclient` / `surface` / `version`）在 pi 里都 import 成功了。`PIGROUPS_URL` 指到
`127.0.0.1:9`（没有服务）是故意的：不需要真平台，也不需要模型调用；`--mode json` 从
`/dev/null` 读不到输入就正常退出。

**这一份不证明什么**：不证明真实平台上的行为。真平台那条是
`probe/logs/spawn-args-20261101T142926/report.md`（两个 case 都 PASS）。

## 清理

起 pi 的那个 tab：先 `herdr pane close wE:p2A`（exit 0），tab 随之消失，再
`herdr tab close wE:t18` 得到 `tab_not_found`——这是预期的，不是失败。之后 pane 集合
`wD:p1E wE:p1 wE:p12 wE:p1J`、tab 集合 `wD:tD wE:t1 wE:tT wE:tW` 与基线一致；没有残留的
`pi -e …` 进程。没有创建会话（TUI 那次带 `--no-session`，json 那次也带），所以不需要清理
`~/.pi/agent/sessions`。
