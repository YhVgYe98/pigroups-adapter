/**
 * Journal of polled batches (概念稿 §8 ①).
 *
 * `poll` consumes: once a batch is taken from the platform it never comes back
 * (../PiGroups/docs/设计说明.md §6.1, at-most-once). So the batch is written to
 * disk before anything is injected, and only removed after the injection has
 * been committed to the agent. A crash in between replays the batch on start.
 *
 * Replay can duplicate an injection; that is why injected text carries the
 * conversation and seq (`[g:m_abc#89]`), see 概念稿 §8 ②.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { PollItem } from './pgclient.ts';

export interface JournalBatch {
  /** Wall clock at which the batch was taken from `poll`. */
  taken_at: number;
  items: PollItem[];
}

export interface JournalEntry {
  id: string;
  batch: JournalBatch;
}

const JOURNAL_SUBDIR = 'journal';

export class Journal {
  private readonly dir: string;
  private seq = 0;

  /** @param adapterDir the `PIGROUPS_ADAPTER_DIR` root; the journal lives in `<adapterDir>/journal`. */
  constructor(adapterDir: string) {
    this.dir = join(adapterDir, JOURNAL_SUBDIR);
  }

  /** Persist a batch before it is injected. Returns the entry id to pass to `commit`. */
  async append(batch: JournalBatch): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const id = this.nextId();
    const tmp = join(this.dir, `.${id}.tmp`);
    await writeFile(tmp, JSON.stringify(batch), 'utf8');
    await rename(tmp, join(this.dir, `${id}.json`));
    return id;
  }

  /** Drop one entry: the batch reached the agent (or is being discarded). */
  async commit(id: string): Promise<void> {
    await rm(join(this.dir, `${id}.json`), { force: true });
  }

  /** Entries still to be replayed, oldest first. */
  async pending(): Promise<JournalEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const entries: JournalEntry[] = [];
    for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
      const path = join(this.dir, name);
      const id = name.slice(0, -'.json'.length);
      try {
        const batch = JSON.parse(await readFile(path, 'utf8')) as JournalBatch;
        entries.push({ id, batch });
      } catch {
        // A half-written or corrupt entry can never be replayed; drop it.
        await rm(path, { force: true });
      }
    }
    return entries;
  }

  /** Discard every pending entry, e.g. on `sys.terminated` (§3.2). */
  async discard(): Promise<void> {
    for (const entry of await this.pending()) await this.commit(entry.id);
  }

  private nextId(): string {
    const stamp = Date.now().toString().padStart(16, '0');
    const counter = (this.seq++).toString().padStart(6, '0');
    return `${stamp}-${counter}-${randomUUID().slice(0, 8)}`;
  }
}
