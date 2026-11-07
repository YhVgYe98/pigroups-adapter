---
name: pigroups-org
description: How to lead a PiGroups team — write a brief that needs no follow-up question, find people by name, read child telemetry, decide when to inspect / abort / terminate, and decide when to do the work yourself. Use it when assigning work, splitting a task, handling a stuck child, or replacing one.
---

# Leading a PiGroups organisation

> **First, confirm that you are online.** The test is **which `pg_*` tools you can see**:
>
> - You see `pg_say`, `pg_members`, `pg_spawn`, ... → you are a member; this whole skill applies.
> - **You see only `pg_org_start`** → this session has no identity yet. **If a person asked you to lead**
>   ("start an organisation", "you are the root"), call it first (see §0); the other tools appear only after
>   it succeeds. If you were not asked to lead, say so plainly: "this session has not joined PiGroups, and
>   nobody asked me to start one", then continue as an ordinary session.
> - **You see no `pg_*` tool at all** → the adapter is not installed in this session (or failed to load).
>   Say so.
>
> In every case, **do not** simulate the organisation with `subagent`, `todo`, or any other mechanism.
> Silent degradation is the worst outcome: the person thinks PiGroups is working when it is not.

## 0. The root's first move: start the organisation

If you were asked to lead and the session has only `pg_org_start`, call it first:

- `pg_org_start(name: "<organisation name>", ...)`. `name` is the root member's name and the first row of
  the roster; name it after **what this team is for** (`release-2026`, `billing`), not `root` or `agent1`.
- It finds the platform code (`platform_dir` → `PIGROUPS_PLATFORM_DIR` → the installed `pigroups` package →
  `../PiGroups` next to the adapter), starts the platform if necessary, and bootstraps the root identity.
  After success, `pg_say`, `pg_spawn`, and the other tools appear.
- If it fails, it returns the paths it tried or the platform's error code. Change the arguments and retry;
  do not guess.
- Once it succeeds you are the **root**: you have no parent, and tasks come directly from the person. State
  the organisation name and your root identity before your first report.
- **The platform outlives this session.** If you exit or the pane closes, the organisation stays in the
  platform data; the root credential and the organisation are recorded in `<adapterDir>/orgs/<key>/org.json`.
  A later `pg_org_start` with the same `PIGROUPS_ADAPTER_DIR` and organisation name reattaches to the same
  organisation. Do not kill the platform to "restart" it, and do not start a second one by hand.
- **`port` is only a starting candidate** (design §8.2): the platform binds its own port and writes
  `endpoint.json`; the adapter verifies the platform identity, waits for healthy health, and updates the
  organisation URL. Do not pin the old port or pick a free port to bypass a startup error. A starting
  identity response or a transient health failure is not evidence that the member died; the adapter owns
  liveness and layered respawn.
- A session that already has an identity (it can see other `pg_*` tools because `PIGROUPS_URL` and
  `PIGROUPS_TOKEN` are in the environment) does not have this tool. Then you are a member, not the root.
  An organisation you just started in this session is different: `pg_org_start` remains visible and only
  answers "already belongs to <url>".

You are a parent (at least to the members you spawn). Your job is not to "pass the task down"; it is to
**make the child not need to come back with a second question**, and to decide when the child is stuck.
The tools answer "what can I do"; this skill answers "how should I use it".

## 1. A brief that needs no follow-up

The `brief` of `pg_spawn(name?, brief, cwd?, args?)` is the first DM the child receives. A bad brief makes
the child do one of two things: stop and ask, or guess. Four elements are mandatory:

1. **Goal**: what the world should look like when this is done (not "look at X", but "X should produce Z at
   time Y").
2. **Acceptance**: what counts as done, which command to run, which output to inspect, who signs off. If
   it can be a command, make it a command.
3. **Boundaries**: what must not be touched, how long it may take, how long it may stay stuck before
   reporting, and which decision must be asked about.
4. **Report**: send `pg_say` to whom when done, and with what (conclusion, evidence paths, what was not done).

One more habit: **put the context you already have into the brief** (relevant files, earlier conclusions,
known traps). The child does not share your session history; "do what we discussed" is zero information.

Do not use the brief as a substitute for tool permissions: `args` is appended to the pi launch arguments
verbatim. Passing `--tools read` can leave the child unable to use `pg_*` at all (it can listen but not speak).

## 2. Name members: the name is the only index

`pg_members(query)` does a case-insensitive substring match on **name** only. Ids are opaque; people do
not remember them and models cannot guess them. The name is the one handle on the platform.

- Name by **what it owns**: `billing-api`, `web-tests`, `release-notes`; not `helper1` or `agent2`.
- A query can hit several members with the same fragment, so names must distinguish responsibilities; do
  not call three repositories `coder`.
- After assigning work, find the child again with `pg_members('billing')`; do not make your parent remember ids.
- `relation` in the roster is a capability boundary: only `child` may be `pg_abort`ed or `pg_terminate`d;
  `sibling` and `peer` may speak but not command. `last_seen_at` is the **last authentication time, not
  liveness**.
- The roster lists only **alive** members. Whether a child process is still running is decided by the adapter
  from **panes** (heartbeats are a fact, not a death sentence). To reopen, use `pg_respawn()` (§6); do not
  `pg_terminate` and then `pg_spawn`.

## 3. Read telemetry

`pg_children()` is a snapshot; `pg_inspect(member)` asks once. Read the snapshot first; do not inspect immediately.

| State | Meaning | What to do |
|---|---|---|
| `stalled` | One tool has been running a long time | Look at `last.tool`. If it is worth waiting, wait; if the direction is wrong, abort and state the new direction |
| `slow_turn` | The whole turn is taking too long | It may be thinking or spinning; read `last.text` |
| `error` | The turn ended with a provider error | This is not task failure; retry if needed, or switch models |
| `idle_owed` | Idle but owes a reply | It is waiting for you or someone else; see which conversation it owes, and answer it first if needed |
| `blocked` | The same conversation was nudged three times with no output | It is probably stuck on a decision: ask what is missing, or abort and give direction |
| `silent_acking` | The same conversation was acked at least three times with no words in between | It is clearing debt with acks instead of reporting; ask explicitly for the conclusion |
| `recovered` | It just left a state; `of` names it | No action; know that it recovered |

`gone` is **not** a telemetry state (removed in 0.13.0): a deleted member disappears from the roster and
telemetry; there is no `gone` row. Do not wait for a `gone` to tell you it is gone — the evidence is that
its session is absent from the panes. A missing heartbeat only says the heartbeat loop stopped; it does not
prove the process exited.

Each `pg_children()` row also carries `last`: the last assistant text (truncated) and the last tool call
(name, argument preview, `ok`). `ok: false` is a pi-reported error; `ok: true` does **not** mean the task succeeded.

## 4. When to inspect

- Telemetry says "not normal" but not what it is doing (for example `slow_turn` with an empty `last.text`).
- Before an irreversible decision (abort / terminate).
- Do not use inspect instead of reading telemetry: it is **one question**, not a polling endpoint; asking
  the same member repeatedly returns the same table.

## 5. When to abort

`pg_abort(member)` cuts the current turn and **carries no words**. Direction is communication; cutting is
operations. Keep them separate:

- It is stuck in a tool that will not end by itself; or
- Its direction is definitely wrong, and continuing only wastes work.

Use **`pg_abort` → `pg_say`**: stop first, then state the new direction. After an abort, the adapter closes
the delivery window immediately, so the message that follows enters its context as soon as possible instead
of waiting for a window.

Do not use abort to express displeasure: cutting throws away the work in that turn. Do not expect abort to
make it "see" your words — abort injects no prompt of its own.

## 6. When to terminate

`pg_terminate(member)` deletes the whole subtree (the platform cascades) and closes the panes this adapter
started for those members.

- This branch is definitely no longer needed (the person left, the direction is dead, a duplicate was spawned).
- Do not terminate + spawn to "restart it": the member keeps its session and context, which are lost on
  restart; try abort / say first. To reopen a child whose **identity still exists but whose process is gone**,
  use `pg_respawn()`: it takes no arguments and covers your subtree. It reopens from the session in
  `children/<id>.json` using the original token (never reissues one); a pane already running that session
  only gets a `pg.respawn` control so it can repair its own subtree; an unreadable pane list starts nothing.
  `pg_terminate` deletes identity; `pg_spawn` creates new identity; neither is a restart.
- Before deleting, remember that the cascade takes every child below it, and their replies owed to you.

## 7. When to do the work yourself

Delegation has a cost: writing the brief, waiting, reading telemetry, handling drift. These are faster done yourself:

- A one-off small change that takes a few minutes and does not need a second holder of context.
- The child lacks required context or tools (for example it has no `bash`, and you only need one command).
- A decision only you can make — then ask **upward**, not downward.

Do not delegate to "look like a manager". A team is for **parallelism** and **long-lived context**, not hierarchy for its own sake.

## 8. Do not poll

Messages, telemetry, and reminders enter your context by themselves. Do not `bash sleep` waiting for a
result, and do not repeat `pg_inspect`. If you really need to look later, use
`pg_schedule(after_seconds, note)`: one-shot, bounded, valid only inside the adapter process. When it is due
the adapter injects `[scheduled] note` and starts a turn. Scheduling the same thing repeatedly means you
should fix the telemetry strategy, not add another timer.
