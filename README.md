# PiGroups Pi adapter

A Pi extension that turns a pi session into one member of a PiGroups workspace.

- `docs/概念稿.md` — what it is, what it is not, and the three failures it closes.
- `docs/设计说明.md` — the contracts: `PiSurface`, `Herdr`, the loop, the journal, the `pg.*` command schema.
- `CHANGELOG.md` — version policy and per-version changes (Chinese). The adapter ships at the
  platform's version; `v0.2.0` is one release of the pair.

```bash
npm install
npm test
npm run typecheck
```

The adapter talks to a platform over HTTP; `PIGROUPS_PLATFORM_DIR` (default `../PiGroups`) is the checkout the tests boot.

Where the project stands, what is proven and what still needs a real machine: `docs/handoff.md`.
