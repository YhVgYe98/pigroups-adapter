# PiGroups Pi adapter — working rules

Read before writing anything:

- `docs/概念稿.md` — what the adapter is and what it deliberately is not. **Authoritative.**
- `docs/设计说明.md` — the contracts: `PiSurface`, `Herdr`, the loop, the journal, the `pg.*` schema.
- `../PiGroups/docs/设计说明.md` §10 — the platform's 16 endpoints. The platform is a separate repo and is **not** to be changed.

There is no other spec. If you need something that is not in these files, ask; do not invent it.

## Language

Documents are Chinese. Code, comments, commit messages, test names are English.

## Runtime contract — do not change

- Node >= 24, ESM, TypeScript run directly. **No build step.**
- `npm test` → `node --test test/*.test.ts`
- `npm run typecheck` → `tsc --noEmit`
- `npm run test:catalog` regenerates `test/CATALOG.md`; every `test/*.test.ts` file must be classified in `test/catalog.config.json` (mixed files use per-case overrides). The catalog test fails on a stale index or an unclassified case.
- The extension entry is `src/extension.ts`; it is loaded by Pi, which supplies the `pi` object.
- `src/loop.ts` must **not** import `@earendil-works/pi-coding-agent`. It depends on `PiSurface` only. That is the only reason this repo is testable.
- The platform under test is booted from `PIGROUPS_PLATFORM_DIR` (default `../PiGroups`) with `node src/main.ts`, `PORT` and `PIGROUPS_DATA` from the test.
- External commands (`herdr`) go through the `Herdr` interface, never called directly from `loop.ts`.

## File ownership — hard rule

| Path | Owner |
|---|---|
| `src/**` | the implementation worker |
| `test/**` | the test worker |

## Isolation — hard rule

- Implementation worker: do not read, list, glob, or grep `test/**`.
- Test worker: do not read, list, glob, or grep `src/**`.
- Neither reads the other's output, reports, or diffs. Everything one needs about the other arrives **in words, from the boss**.

Both may read `docs/**`, `AGENTS.md`, `package.json`, and `../PiGroups/docs/**`.

## Git

- Commits are **unsigned**: this repository has `commit.gpgsign=false` locally. Always `git commit --no-gpg-sign -m "..."`; never add `-S`.
- Commit only the paths you own: `git add src/` or `git add test/`. **Never** `git add -A` while a peer is writing in the same tree.
- One commit per task. Message: `area: what changed`.
- Do not rebase, amend, or force-push.

## Behaviour

- Prefer the smallest change that satisfies the spec. No new tools, no new commands, no extra config keys.
- When the spec is silent or looks wrong, stop and ask. The asynchrony here is deliberate; "improving" it silently is the one unacceptable outcome.
