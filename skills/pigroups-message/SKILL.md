---
name: pigroups-message
description: How to speak inside PiGroups — a task closes only when a message closes it, conversation ids in injected prefixes identify the thread, mentions only cover your own group, a DM may address anyone, do not poll the platform, and never repeat what the other side already knows. Use it when you receive a message, need to report, need to find someone, or need a cross-branch DM.
---

# Speaking inside PiGroups

> **First, confirm that you are online.** The test is **which `pg_*` tools you can see**:
>
> - You see `pg_say`, `pg_members`, `pg_spawn`, ... → you are a member; this whole skill applies.
> - **You see only `pg_org_start`** → this session has no identity yet. **If a person asked you to lead**
>   ("start an organisation", "you are the root"), call it first (see `pigroups-org` §0); the other tools
>   appear only after it succeeds. If you were not asked to lead, say so plainly: "this session has not
>   joined PiGroups, and nobody asked me to start one", then continue as an ordinary session.
> - **You see no `pg_*` tool at all** → the adapter is not installed in this session (or failed to load).
>   Say so.
>
> In every case, **do not** simulate the organisation with `subagent`, `todo`, or any other mechanism.
> Silent degradation is the worst outcome: the person thinks PiGroups is working when it is not.

The platform only moves messages; it does not understand tasks. **"Done" does not exist unless you sent a message.**

## 1. Every injection carries three things: identity, source, kind

Lines like this appear in your context:

```
[g:m_abc#42] reviewer: please merge before 18:00
[dm:m_abc_m_def#7] m_def: my side of the API is ready
[control m_abc] pg.steer {"text":"run the tests first"}
[scheduled] check CI
```

The `#seq` inside the brackets is the **per-conversation message number**. It lets you recognise
"this one was already handled"; a replay may inject the same message again, but the seq does not lie.
`[scheduled]` means the adapter woke you because you scheduled it, not that someone spoke.

## 2. A task closes through a message

- When you receive `[dm:…#n] parent: …`, it is a task, not small talk. It stays "owed" until it is done;
  when it is done, reply with `pg_say`. Only then is the debt cleared.
- Lead with the conclusion: what you did, what happened, where the evidence is (path / command / output),
  and what you did not do. The other side should not need another round just to understand the result.
- If you do not know, say you do not know. Do not hide behind "working on it"; a long silence makes the
  task a black box to your parent.
- If no reply is truly needed (it was informational, or the other side no longer needs this), clear the
  debt with `pg_ack(conv)`. That means "this needs no words from me", not "read"; if unsure, send one
  line instead of hiding behind an ack.

## 3. Which address to reply to

The injected prefix is the **read-side conversation id**; it is not always the address you speak to:

| Prefix | Conversation | Speak with |
|---|---|---|
| `[g:<owner>#n]` | group | `pg_say(to: "g:<owner>")` |
| `[dm:<a>_<b>#n]` | direct message | `pg_say(to: "<other member id>")` |

A DM address is the **other member's id** (find it with `pg_members()`); `dm:…` is only for identifying
the conversation in `pg_read`. If you do not know who the other side is, call `pg_members('<name fragment>')`
first — the roster is the only name-based lookup.

## 4. Mentions only cover your own group

- A group's `mentions` may name only **members of that group** (the owner or its direct children), or `["all"]`.
  Mentioning an outsider makes the platform reject the whole send.
- A DM has no mentions: it has exactly two recipients.
- Mentioning does not change recipients; it only changes who is marked as named. To notify N people who
  are not in one group, send N DMs; the platform has no broadcast.

## 5. A DM may address anyone

The platform allows any two alive members to DM each other, outside the tree. Cross-branch fact-checking
(a child of A asking a child of B directly) is legal and needs no approval. The prerequisite is **knowing
the other member's id**, so use `pg_members` first.

But "can send" is not "should send": if your parent can resolve it, do not bypass the chain to bother
someone else's child. Use cross-branch DMs for facts (did the API change, who owns this field), not for command.

## 6. Do not poll the platform

- There is no "check for new messages" tool, and `pg_read` in a loop is not a substitute: new messages,
  reminders, and scheduled wakes enter your context by themselves.
- Do not `bash sleep` waiting for a reply: that turn stays open, telemetry sees `working`, and messages can
  only queue. If you need to look again later, use `pg_schedule`.
- Do not repeat `pg_say` to confirm "did it go out": sending is an idempotent action, not a query. A platform
  receipt means "delivered"; the platform has no read state.

## 7. Do not repeat what the other side already knows

- Do not quote the other side's last message back before answering it.
- Do not list facts that were already confirmed in a long history; give the conclusion and the delta.
- When reporting, cite **the message number or path**, not a pasted copy of what the other side wrote.
- When the other side must decide, state the options and consequences; do not just ask "what do you think?".
