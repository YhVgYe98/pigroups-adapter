# PiGroups Pi adapter

A Pi extension that turns a pi session into one member of a PiGroups workspace — or,
when the session has no identity yet, lets it start the organisation and become its root.

A spawned member loads this same extension by default (`pi -e <this file>`); it is
otherwise a normal pi session, with the operator's tools, skills, prompt templates,
MCP servers and context files. `pg_spawn` can append a raw pi argv tail for one
spawn (`args`); it does not mirror pi's flags, so `pi --help` is the reference. Set
`PIGROUPS_SPAWN_CMD` only to replace the whole base command.

- `docs/概念稿.md` — what it is, what it is not, and the three failures it closes.
- `docs/设计说明.md` — the contracts: `PiSurface`, `Herdr`, the loop, the journal, the `pg.*` command schema.
- `skills/pigroups-org` and `skills/pigroups-message` — how to run the organisation (briefs,
  roster, telemetry, abort/terminate) and how to talk (tasks close by message, conversation
  ids, mentions, no polling). Registered under `pi.skills` and shipped with the package.
- `CHANGELOG.md` — version policy and per-version changes (Chinese). A release records one
  pair: both sides share a number when both move, and only the side that changed takes the
  version step otherwise. `v0.6.0+platform.0.2.0` is the adapter alone, on platform 0.2.0;
  the metadata records what it was tested against and is not a compatibility gate.

## Quick start: ask the agent to start an org

```bash
pi install /absolute/path/to/pigroups-adapter    # personal: written to ~/.pi/agent/settings.json
pi list                                          # should show pigroups-adapter-pi
```

That is the only installation step: the manifest under `pi` in `package.json` declares the
extension entry and the two skills (`pigroups-org`, `pigroups-message`).

Then start `pi` and ask for an organisation:

> Start a PiGroups organisation named `release-2026` and then ...

A session with no identity gets exactly one tool, `pg_org_start`. It finds the platform
checkout (`platform_dir` argument, else `PIGROUPS_PLATFORM_DIR`, else `../PiGroups` next to
this repository), starts the platform detached, bootstraps a root, writes
`<adapter dir>/orgs/<name>/org.json`, and only then registers the twelve member tools (`pg_say`, `pg_spawn`,
`pg_members`, ...). The platform is started **by the agent**, not by hand, and it outlives the
session: a later session with the same adapter directory reattaches through the same tool
instead of starting a second platform.

**The platform owns its port.** `pg_org_start` passes `port` as a first candidate; the platform
binds a socket, keeps it for its lifetime, and records the port it got in
`platforms/<platform_id>/endpoint.json` before it opens the database. An existing organisation
starts from that recorded port, so two sessions cannot end up serving one platform on two ports.
A candidate held by the same platform makes the new process exit `2`, and the adapter reattaches
instead of treating it as a failure. A temporary health failure does not establish member death,
and nothing signals a recorded pid any more; agent liveness and respawn remain adapter
responsibilities. See §8.2 of [the adapter design](docs/设计说明.md).

A member that was **handed an identity** is the other path: start pi with `PIGROUPS_URL` and
`PIGROUPS_TOKEN` in its environment. It registers the twelve member tools at startup and does not
get `pg_org_start` at all. A child spawned by `pg_spawn` inherits both variables, so nothing
else needs configuring for the tree below the root.

`PIGROUPS_ADAPTER_DIR` (default `~/.pi/pigroups`, or `<PI_CODING_AGENT_DIR>/pigroups`
for a custom profile) holds the journal, per-member state, per-organisation `org.json`,
and by default the shared platform data root.

## Clone for development

The test suite boots the **platform** as a subprocess, so the two repositories are developed side
by side:

```
your-workspace/
├── PiGroups/            # the platform (separate repo)
└── pigroups-adapter/    # this repo
```

`PIGROUPS_PLATFORM_DIR` overrides where the tests (and `pg_org_start`) look (default
`../PiGroups` next to this repository).

```bash
npm install
npm test
npm run typecheck
```

`probe/logs/` holds real-machine evidence from past runs. Some of those files contain credentials
of throwaway platforms that were started on localhost and deleted; they are dead, and they are
kept because they are the record. Delete the directory before publishing anything widely.

The adapter talks to a platform over HTTP; `PIGROUPS_PLATFORM_DIR` (default `../PiGroups`) is the checkout the tests boot.

Where the project stands, what is proven and what still needs a real machine: `docs/handoff.md`.
