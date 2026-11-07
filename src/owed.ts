/**
 * The owed-reply ledger (设计说明 §4.2): one persisted flag per conversation, the audit
 * trail of confirmations, and the per-conversation high-water seq that bounds `pg_ack`
 * (§4.3).
 *
 * A flag is set when a message is put into the model's context and cleared when the
 * member replies (`say`) or confirms (`pg_ack`). It is **not** derived from history:
 * history can only answer "who spoke last", and that has no way out of the loop where
 * two members keep re-opening each other's debt by explaining why they owe nothing
 * (§4.1: 17 ack↔ack round trips, 14 `blocked` reports on one real run).
 *
 * Files live beside the journal and the injection watermark, one per member:
 * `<adapterDir>/owed/<memberId>.json`. `PIGROUPS_ADAPTER_DIR` is handed down to spawned
 * children, so the directory is shared by a whole tree and a `dm:` id is the same string
 * on both ends. A write is temp file plus rename, so a crash mid-write cannot leave a
 * truncated ledger behind.
 *
 * The high-water seq is here, not in `Watermarks`: a `gap` names a seq (`before`, the
 * backfill anchor) and sets the flag with it, but never advances the injection watermark
 * (§3.4) — a bound read off the watermark would refuse the very seq the nudge quoted
 * (Q11). It is advanced on every delivery and whenever a nudge names a conversation.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { logWarn } from './log.ts';

/** One owed conversation, as the loop and the nudge text read it. */
export interface OwedFlag {
  conv: string;
  /** Seq the nudge quotes; the largest one this flag covers. */
  seq: number;
  /** When the flag became non-empty. §4.1's roster snapshot is only trusted for older debts. */
  since: number;
}

/** §4.3: a confirmation leaves a local trace, because it deliberately leaves no message. */
export interface AckRecord {
  conv: string;
  seq: number;
  at: number;
}

export interface OwedFile {
  owed: Record<string, { seq: number; since: number }>;
  acks: AckRecord[];
  /**
   * The seq each conversation's most recent `clear` settled. A redelivery at or below it
   * is the same message the member already answered, so it must not re-open the flag.
   * Missing in older files; treated as empty.
   */
  cleared: Record<string, number>;
}

const OWED_SUBDIR = 'owed';

export class OwedLedger {
  private readonly dir: string;
  /** Set by `load`: `<adapterDir>/owed/<memberId>.json`. */
  private path: string | undefined;
  private readonly owed = new Map<string, { seq: number; since: number }>();
  private readonly acks: AckRecord[] = [];
  /** `<conv, seq>`: the newest seq a reply/ack settled; a redelivery at or below it owes nothing. */
  private readonly cleared = new Map<string, number>();
  private readonly named = new Map<string, number>();
  /** Writes are serialised: every one of them rewrites the whole file. */
  private writes: Promise<void> = Promise.resolve();

  /** @param adapterDir the `PIGROUPS_ADAPTER_DIR` root; the ledger lives in `<adapterDir>/owed`. */
  constructor(adapterDir: string) {
    this.dir = join(adapterDir, OWED_SUBDIR);
  }

  /**
   * Read this member's ledger once, at startup, before the first delivery can set a flag.
   *
   * Returns whether a readable file existed. `false` is the only case in which the
   * caller may reconcile from history (§4.2: "文件缺失才做一次全量对账"); `true` means
   * the file wins, even when it is empty — that empty ledger is someone's answer.
   *
   * A corrupt file is treated as missing: re-reading the history can duplicate a debt
   * that was already paid, while starting from an empty ledger would silently drop a
   * debt nobody paid.
   */
  async load(memberId: string): Promise<boolean> {
    const path = join(this.dir, `${memberId}.json`);
    this.path = path;
    this.owed.clear();
    this.acks.length = 0;
    this.cleared.clear();
    this.named.clear();

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }

    let parsed: Partial<OwedFile> | null;
    try {
      parsed = JSON.parse(raw) as Partial<OwedFile> | null;
    } catch {
      logWarn(`[pigroups] unreadable owed ledger at ${path}; reconciling from history instead`);
      return false;
    }

    const owed = parsed?.owed;
    if (typeof owed === 'object' && owed !== null) {
      for (const [conv, flag] of Object.entries(owed)) {
        const seq = (flag as { seq?: unknown } | null)?.seq;
        const since = (flag as { since?: unknown } | null)?.since;
        if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        this.owed.set(conv, {
          seq,
          since: typeof since === 'number' && Number.isFinite(since) ? since : 0,
        });
        this.advance(conv, seq);
      }
    }

    const acks = parsed?.acks;
    if (Array.isArray(acks)) {
      for (const ack of acks) {
        if (typeof ack !== 'object' || ack === null) continue;
        const record = ack as unknown as Record<string, unknown>;
        if (typeof record.conv !== 'string' || typeof record.seq !== 'number') continue;
        this.acks.push({
          conv: record.conv,
          seq: record.seq,
          at: typeof record.at === 'number' ? record.at : 0,
        });
      }
    }

    // `cleared` was added after the first ledger files shipped: its absence is an empty
    // map, not a corrupt file, and the old flags above are still the truth.
    const cleared = parsed?.cleared;
    if (typeof cleared === 'object' && cleared !== null) {
      for (const [conv, seq] of Object.entries(cleared)) {
        if (typeof seq !== 'number' || !Number.isFinite(seq)) continue;
        this.cleared.set(conv, seq);
      }
    }
    return true;
  }

  /** Every owed conversation, in insertion order. */
  entries(): OwedFlag[] {
    return [...this.owed].map(([conv, flag]) => ({ conv, seq: flag.seq, since: flag.since }));
  }

  /** The largest seq this adapter has delivered or named for `conv` (§4.3's `pg_ack` bound). */
  maxSeq(conv: string): number {
    return this.named.get(conv) ?? 0;
  }

  /**
   * §4.3: a conversation this adapter named in a nudge, or handed to the model, can be
   * confirmed up to that seq. Memory only: it bounds one process's answers, and the
   * flags themselves carry their seq across a restart.
   */
  advance(conv: string, seq: number): void {
    if (seq > (this.named.get(conv) ?? 0)) this.named.set(conv, seq);
  }

  /**
   * §4.2: a message was put into the context, so the conversation is owed.
   *
   * Only a larger seq moves an existing flag, and `since` is written once, when the flag
   * becomes non-empty: a redelivery (the abort path puts a batch back) is the same
   * message, and resetting the clock would make §4.1's roster snapshot refuse to judge a
   * debt that is old enough to judge.
   */
  async set(conv: string, seq: number, now: number): Promise<void> {
    this.advance(conv, seq);
    // §4.2 / Q2: the abort path re-delivers a batch the model may already have answered.
    // A seq at or below what `clear` settled names the same message (or an older one), so
    // it may move the ack bound but must not open a flag the reply already closed.
    const cleared = this.cleared.get(conv);
    if (cleared !== undefined && seq <= cleared) return;
    const existing = this.owed.get(conv);
    if (existing !== undefined) {
      if (seq <= existing.seq) return;
      existing.seq = seq;
      await this.persist();
      return;
    }
    this.owed.set(conv, { seq, since: now });
    await this.persist();
  }

  /** §4.2: the member replied or confirmed. Returns the seq the flag named, if any. */
  async clear(conv: string): Promise<number | undefined> {
    const existing = this.owed.get(conv);
    if (existing === undefined) return undefined;
    this.owed.delete(conv);
    // Persist the settlement with the flag it removed: after a restart, a redelivery at
    // this seq (or below it) would otherwise look like a fresh debt again.
    this.cleared.set(conv, Math.max(this.cleared.get(conv) ?? 0, existing.seq));
    await this.persist();
    return existing.seq;
  }

  /** §4.3: a confirmation is silent, so its only trace is this record. */
  async recordAck(conv: string, seq: number, at: number): Promise<void> {
    this.acks.push({ conv, seq, at });
    await this.persist();
  }

  private persist(): Promise<void> {
    const write = this.writes.then(() => this.writeNow());
    // A failed write must not wedge the queue for later mutations; the caller still sees
    // the rejection (a confirmation that could not be recorded is not a confirmation).
    this.writes = write.catch(() => undefined);
    return write;
  }

  private async writeNow(): Promise<void> {
    const path = this.path;
    if (path === undefined) throw new Error('owed ledger written before load(memberId)');
    const body = JSON.stringify({
      owed: Object.fromEntries([...this.owed].map(([conv, flag]) => [conv, { seq: flag.seq, since: flag.since }])),
      acks: this.acks,
      cleared: Object.fromEntries(this.cleared),
    } satisfies OwedFile);
    const tmp = join(this.dir, `.${basename(path)}.tmp`);
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, path);
  }
}
