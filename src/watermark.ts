/**
 * The injection watermark (设计说明 §3.4): one per conversation,
 * `injected[conv] = 最大已注入 seq`.
 *
 * Three paths can point at the same `(conv, seq)`: the startup brief read from the
 * parent's history, the polled copy the platform inbox still holds (it consumes on
 * read, so a member that never polled keeps its copy), and a journal replay after a
 * crash between "took it" and "injected it". One rule covers all three:
 *
 * ```
 * 要注入 (conv, seq) 时：
 *   if seq <= injected[conv]: 丢弃（已注入过）
 *   else: 注入；injected[conv] = seq；水位落盘
 * ```
 *
 * The map is persisted because the window that matters most — brief injected, inbox
 * copy not yet polled, process died — is exactly the one a memory-only map loses.
 *
 * Files live beside the journal, one per member id: `PIGROUPS_ADAPTER_DIR` is handed
 * down to spawned children (see `spawnMember`), and a DM's conversation id is the
 * same string on both ends, so a single shared map would let a child's seq hide a
 * parent's message. A write is temp file plus rename, so a crash mid-write cannot
 * leave a truncated map behind.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export interface WatermarkFile {
  v: 1;
  injected: Record<string, number>;
}

const WATERMARK_SUBDIR = 'injected';

export class Watermarks {
  private readonly dir: string;
  /** Set by `load`: `<adapterDir>/injected/<memberId>.json`. */
  private path: string | undefined;
  /** The hot path: consulted on every injection, rewritten only when a seq advances. */
  private readonly injected = new Map<string, number>();

  /** @param adapterDir the `PIGROUPS_ADAPTER_DIR` root; watermarks live in `<adapterDir>/injected`. */
  constructor(adapterDir: string) {
    this.dir = join(adapterDir, WATERMARK_SUBDIR);
  }

  /**
   * Read this member's map once, at startup, before the first injection point runs.
   * A corrupt file means the whole dedup record is gone (a duplicate is possible, a
   * lost message is not), so say so instead of starting from an empty map silently.
   *
   * Returns whether a readable map existed. The caller uses it for the one decision the
   * watermark can answer that the ledger cannot: has this member ever been handed anything
   * before? No map means a fresh spawn, which is the only startup where the parent's last
   * DM is the task book (§4.2).
   */
  async load(memberId: string): Promise<boolean> {
    const path = join(this.dir, `${memberId}.json`);
    this.path = path;
    this.injected.clear();

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    let injected: unknown;
    try {
      injected = (JSON.parse(raw) as Partial<WatermarkFile> | null)?.injected;
    } catch {
      console.warn(`[pigroups] unreadable injection watermark at ${path}; starting with an empty one`);
      // The file is there, so this member has started before: not a fresh spawn. Starting
      // empty may duplicate an injection (a lost message would be worse), and calling it a
      // spawn would silence a debt the parent's last instruction deserves.
      return true;
    }
    if (typeof injected !== 'object' || injected === null) return true;

    for (const [conv, seq] of Object.entries(injected)) {
      if (typeof seq === 'number' && Number.isFinite(seq)) this.injected.set(conv, seq);
    }
    return true;
  }

  /** §3.4: `seq <= injected[conv]` means this message has already been shown to the model. */
  seen(conv: string, seq: number): boolean {
    const injected = this.injected.get(conv);
    return injected !== undefined && seq <= injected;
  }

  /**
   * Record a seq that reached the agent, rewriting the file when it advances the
   * watermark. Called only after `deliver` returned: an advance before the text was
   * committed would let a failed delivery or a crash hide the message forever.
   */
  async advance(conv: string, seq: number): Promise<void> {
    if (this.seen(conv, seq)) return;
    const path = this.path;
    if (path === undefined) throw new Error('injection watermark advanced before load(memberId)');

    this.injected.set(conv, seq);
    const body = JSON.stringify({ v: 1, injected: Object.fromEntries(this.injected) } satisfies WatermarkFile);
    const tmp = join(this.dir, `.${basename(path)}.tmp`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  }
}
