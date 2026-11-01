# PiGroups Pi adapter

A Pi extension that turns a pi session into one member of a PiGroups workspace.

A spawned child loads this same extension by default (`pi -ne -e <this file>`); set
`PIGROUPS_SPAWN_CMD` only when a child needs different flags.

- `docs/概念稿.md` — what it is, what it is not, and the three failures it closes.
- `docs/设计说明.md` — the contracts: `PiSurface`, `Herdr`, the loop, the journal, the `pg.*` command schema.
- `CHANGELOG.md` — version policy and per-version changes (Chinese). A release records one
  pair: both sides share a number when both move, and only the side that changed takes the
  version step otherwise. `v0.4.0+platform.0.2.0` is the adapter alone, on platform 0.2.0;
  the metadata records what it was tested against and is not a compatibility gate.

```bash
npm install
npm test
npm run typecheck
```

The adapter talks to a platform over HTTP; `PIGROUPS_PLATFORM_DIR` (default `../PiGroups`) is the checkout the tests boot.

Where the project stands, what is proven and what still needs a real machine: `docs/handoff.md`.
