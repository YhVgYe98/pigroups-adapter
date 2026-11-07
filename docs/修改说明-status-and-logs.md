# 状态栏与诊断日志

## 1. 状态栏只放一行身份

pi 的内置 footer 第一行是 `<cwd> • <session name>`，后面是用量/模型；`ctx.ui.setStatus()`
另起**一行**（所有 extension 的 status 排序后拼成一行）。内置 footer 不能在它的第一行后面追加，
要精确拼到第一行只能整体替换 footer，或者改持久化的 session 名——两者都不值得为一行身份信息做。

因此本适配器用 `ctx.ui.setStatus('pigroups', …)`，**只加一行**：

```
PG billing-api(m_a1b2c3) · quant-lab → planner → billing-api (2 kids)
```

- `PG` 是固定前缀。
- 第一个名字是成员名，括号里是成员 id；名字用 `ctx.ui.theme.bold()` 加粗（主题不支持时退化为纯文本）。
- `·` 后面是从根到自己的名字链，用真正的右箭头 `→` 连接；路径来自 `GET /v1/tree`。
- 最后一个名字就是自己，同样加粗。
- `(n kids)` 是**直接子成员**数，单数写 `(1 kid)`。
- 不显示 owed、在线状态、平台版本等；这些不是这一行要回答的问题。

状态行是 UI，不进模型上下文，不消耗 token。更新时机：

1. `whoami` 拿到身份后先用 `[selfName]` 立即显示一行；
2. `GET /v1/tree` 成功后补上根→自己的完整路径和直接子成员数；
3. `pg_spawn` 创建子成员后立即 `+1`，随后用 tree 校正；
4. `pg_terminate` 成功后重新读 tree 校正；
5. `session_tree` 换上下文时重画最后一份；`session_shutdown` 清空。

tree 读取失败时保留 `[selfName]` 和 whoami 的 child_count，不把状态行变成错误提示。
状态回调不能影响 loop：`onStatus` 的异常在调用处吞掉。

## 2. 诊断日志不再进 TUI

`[pigroups] …` 开头的诊断行原来走 `console.log/warn`，会出现在 pi 的终端/TUI 输出里。
它们不是模型上下文（模型看到的是 `sendMessage(..., display:true)` 的 custom message），
只是运维信息；不应该占用对话框或终端。

现在：

- 所有适配器的 `console.log/warn` 改为 `logInfo/logWarn`；
- 生产路径写入 `<adapterDir>/adapter.log`，每行 `ISO 时间 + LEVEL + [name(id)] + 原文`，目录 0700、文件 0600；
  `whoami` 之前还没有身份，启动行不带 tag；
- adapter root 未知时先缓冲，`setLogDir` 后 flush；绝不能为默认路径创建目录，否则 legacy 目录检查
  会把 `~/.pi/pigroups` 当成已存在而放弃旧布局；
- 写文件失败就放弃这一行，不退回 stderr，避免又一次污染 TUI；
- 测试路径（`NODE_TEST_CONTEXT` 存在）仍调用 `console.log/warn`，让现有测试继续捕获警告；
- 真正需要人立刻处理的错误仍通过工具错误、`ctx.ui.notify` 或状态行表达，不靠 console。

这样模型上下文和 `display` 策略保持不变，TUI 里只剩对话、工具结果和一行 PiGroups 状态。
