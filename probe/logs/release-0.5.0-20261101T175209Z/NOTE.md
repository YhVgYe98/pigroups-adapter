# 0.5.0+platform.0.2.0 发版证据（2026-11-02）

发版检查按 `docs/handoff.md` §8 的步骤走。真机 A–D 在上一轮做过，证据在
`probe/logs/v3-20261101T173805Z/`；这里只有“打出来的那一份能不能加载”的证明。

| 文件 | 内容 |
|---|---|
| `version.txt` | `package.json` 与 lockfile 的两处版本号，加 `src/version.ts` 的常量（三处相等，`test/version.test.ts` 守着） |
| `typecheck.txt` / `test.txt` | `npm run typecheck`（退出 0）与 `npm test`（123/123） |
| `npm-pack.txt` | `npm pack` 的输出：18 个文件、包名、版本、shasum、integrity |
| `tarball-contents.txt` | tarball 里的全部路径（`src/` 10 个、`skills/` 2 个、`docs/` 3 个、根 3 个） |
| `load-proof.mjs` / `load-proof.txt` | 解包后的 11 条检查，全 PASS |
| `pi-json.err` | `pi -e <解包入口> --no-session --mode json` 的 stderr：`[pigroups] adapter 0.5.0+platform.0.2.0 starting against http://127.0.0.1:9`，退出 0 |
| `pi-json.out` | 同一次运行的 stdout（一条 session 行；`--mode json` 从 `/dev/null` 读不到输入就退出） |
| `skills-load.txt` | pi 自己的 `loadSkillsFromDir` 从**解包副本**读出的两条 skill 与诊断（`pigroups-message`、`pigroups-org`，诊断为空） |
| `packdir.txt` | 这次用的临时目录；里面的 tarball 与解包副本不入库 |

`load-proof.mjs` 是 `probe/logs/release-0.4.0-plat0.2.0-20261101T224511/` 那一份加了
`pi.skills` 与两个 `SKILL.md` 的检查。11 条是：包名、版本、`pi.skills` 只有一项、
两个 skill 带 `SKILL.md`、`pi.extensions` 只有一项、入口存在、`src` 有模块、20 条相对
import 全部解析、入口 `default` 是函数、`EXTENSION_ENTRY` 是字符串、默认 spawn 命令
以 `pi -e ` 开头。

tarball 的 shasum 不写进 `CHANGELOG.md` / `docs/`：它们本身就在包里，写进去就改了 shasum。
要核对就看 `npm-pack.txt`。
