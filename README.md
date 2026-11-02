# PiGroups Pi adapter

A Pi extension that turns a pi session into one member of a PiGroups workspace.

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
  version step otherwise. `v0.5.0+platform.0.2.0` is the adapter alone, on platform 0.2.0;
  the metadata records what it was tested against and is not a compatibility gate.

## Install it into pi

```bash
pi install /absolute/path/to/pigroups-adapter    # personal: written to ~/.pi/agent/settings.json
pi list                                          # should show pigroups-adapter-pi
```

That is the only installation step: the manifest under `pi` in `package.json` declares the
extension entry and the two skills (`pigroups-org`, `pigroups-message`). Without `PIGROUPS_URL`
and `PIGROUPS_TOKEN` in its environment a session does nothing at all, so installing it
personally is safe on a machine that also runs unrelated pi sessions.

Once installed, a member is just a pi started with those two variables set - and a child spawned
by `pg_spawn` inherits them, so nothing else needs configuring.

## Clone for development

The test suite boots the **platform** as a subprocess, so the two repositories are developed side
by side:

```
your-workspace/
├── PiGroups/            # the platform (separate repo)
└── pigroups-adapter/    # this repo
```

`PIGROUPS_PLATFORM_DIR` overrides where the tests look (default `../PiGroups`).

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
