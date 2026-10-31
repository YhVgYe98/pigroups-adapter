/**
 * HTTP client for the PiGroups platform.
 *
 * Only the endpoints listed in ../PiGroups/docs/设计说明.md §10 are used. The
 * platform knows nothing about this adapter; everything here is plain JSON over
 * `Authorization: Bearer <token>`.
 */

export interface MemberRecord {
  id: string;
  name: string;
  parent_id: string | null;
  status: 'alive' | 'gone';
  is_root: boolean;
  child_count: number;
  groups: { to: string; owner: string }[];
  last_seen_at: number | null;
  created_at: number;
}

export interface WhoamiMember {
  kind: 'member';
  member: MemberRecord;
  groups: { to: string; owner: string }[];
  dms: { to: string; peer: string }[];
  last_seen_at: number | null;
  server: { version: string };
}

export interface Health {
  status: string;
  version: string;
  uptime_ms: number;
}

export interface CreatedMember {
  member: MemberRecord;
  /** Absent when the create call is an idempotent replay (platform §12). */
  token?: string;
}

export interface Conversation {
  to: string;
  kind: 'group' | 'dm';
  label: string;
  owner?: string;
  peer?: string;
  last_message_seq: number;
  last_at: number | null;
}

export interface MessageRecord {
  to: string;
  seq: number;
  sender_id: string;
  sender_kind: 'member' | 'human';
  sender_name: string;
  body: string;
  meta: unknown;
  mentions: string[];
  created_at: number;
}

export interface PollControlItem {
  kind: 'control';
  control_seq: number;
  id: string;
  from_id: string;
  cmd: string;
  payload: Record<string, unknown> | null;
  reply_to: string | null;
  created_at: number;
}

export interface PollGapItem {
  kind: 'gap';
  to: string;
  count: number;
  before: number;
  mentioned: number;
}

export interface PollMessageItem {
  kind: 'message';
  to: string;
  seq: number;
  from_id: string;
  from_name: string;
  from_kind: 'member' | 'human';
  preview: string;
  mentions_me: boolean;
  from_parent: boolean;
  at: number;
}

export type PollItem = PollControlItem | PollGapItem | PollMessageItem;

export interface PollBatch {
  items: PollItem[];
  control_pending: number;
}

export interface SendMessageResult {
  to: string;
  seq: number;
  recipients: string[];
  created_at: number;
}

export interface ControlReceipt {
  to_id: string;
  state: 'pending' | 'delivered';
  delivered_at?: number;
}

export interface SendControlResult {
  control_seq: number;
  receipts: ControlReceipt[];
}

export interface ControlLogItem {
  seq: number;
  id: string;
  to: string | string[];
  receipts: ControlReceipt[];
  created_at: number;
}

/** Any structured platform error (../PiGroups/docs/设计说明.md §10.1). */
export class PgError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  readonly retryAfterMs: number | null;

  constructor(status: number, code: string, message: string, detail: unknown, retryAfterMs: number | null) {
    super(message);
    this.name = 'PgError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 410 `member_gone`: stop everything (设计说明 §9). */
export class PgGone extends PgError {
  constructor(error: PgError) {
    super(error.status, error.code, error.message, error.detail, error.retryAfterMs);
    this.name = 'PgGone';
  }
}

/** 409 `poll_in_progress`: another poll of the same member is waiting (§9). */
export class PgPollBusy extends PgError {
  constructor(error: PgError) {
    super(error.status, error.code, error.message, error.detail, error.retryAfterMs);
    this.name = 'PgPollBusy';
  }
}

/** Connection failure or 5xx: retry with backoff (§9). */
export class PgUnavailable extends PgError {
  constructor(status: number, message: string, detail: unknown = null) {
    super(status, status === 0 ? 'unreachable' : 'unavailable', message, detail, null);
    this.name = 'PgUnavailable';
  }
}

export interface PgClientOptions {
  url: string;
  token: string;
}

export interface PollOptions {
  wait?: number;
  limit?: number;
  types?: string;
  signal?: AbortSignal;
}

export class PgClient {
  readonly url: string;
  readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PgClientOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = globalThis.fetch;
  }

  async health(): Promise<Health> {
    return this.request<Health>('GET', '/v1/health', { auth: false });
  }

  async whoami(): Promise<WhoamiMember> {
    return this.request<WhoamiMember>('GET', '/v1/whoami');
  }

  async createMember(input: { name?: string; request_id: string }): Promise<CreatedMember> {
    return this.request<CreatedMember>('POST', '/v1/members', { body: input });
  }

  async getMember(id: string): Promise<MemberRecord> {
    return this.request<MemberRecord>('GET', `/v1/members/${encodeURIComponent(id)}`);
  }

  async deleteMember(id: string): Promise<{ terminated: string[] }> {
    return this.request<{ terminated: string[] }>('DELETE', `/v1/members/${encodeURIComponent(id)}`);
  }

  async reissueToken(id: string): Promise<{ token: string }> {
    return this.request<{ token: string }>('POST', `/v1/members/${encodeURIComponent(id)}/token`, {
      body: {},
    });
  }

  async conversations(): Promise<{ items: Conversation[] }> {
    return this.request<{ items: Conversation[] }>('GET', '/v1/conversations');
  }

  async sendMessage(input: {
    to: string;
    body: string;
    mentions?: string[];
    meta?: unknown;
    client_msg_id?: string;
  }): Promise<SendMessageResult> {
    return this.request<SendMessageResult>('POST', '/v1/messages', { body: input });
  }

  async messages(input: {
    to: string;
    before?: number;
    limit?: number;
  }): Promise<{ items: MessageRecord[]; next: number | null }> {
    return this.request<{ items: MessageRecord[]; next: number | null }>('GET', '/v1/messages', {
      query: { to: input.to, before: input.before, limit: input.limit },
    });
  }

  async sendControl(input: {
    to: string | string[];
    id: string;
    cmd: string;
    payload?: unknown;
    reply_to?: string | null;
  }): Promise<SendControlResult> {
    return this.request<SendControlResult>('POST', '/v1/control', { body: input });
  }

  async listControl(input: { since?: number; limit?: number } = {}): Promise<{
    items: ControlLogItem[];
    next: number | null;
  }> {
    return this.request<{ items: ControlLogItem[]; next: number | null }>('GET', '/v1/control', {
      query: { since: input.since, limit: input.limit },
    });
  }

  /**
   * One consuming pull (/PiGroups §6.1: 取走即消费). A single request: retry and
   * backoff are the loop's business (§9), so a 409 surfaces as `PgPollBusy` with
   * `retryAfterMs` from the `Retry-After` header.
   */
  async poll(opts: PollOptions = {}): Promise<PollBatch> {
    return this.request<PollBatch>('GET', '/v1/poll', {
      query: { wait: opts.wait, limit: opts.limit, types: opts.types },
      signal: opts.signal,
    });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
      auth?: boolean;
    } = {},
  ): Promise<T> {
    const url = new URL(this.url + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {};
    if (opts.auth !== false) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new PgUnavailable(0, `${method} ${path}: ${(err as Error)?.message ?? 'request failed'}`);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const envelope = parsed as { error?: { code?: string; message?: string; detail?: unknown } } | null;
      const code = envelope?.error?.code ?? `http_${res.status}`;
      const message = envelope?.error?.message ?? `${method} ${path} failed with ${res.status}`;
      const retryAfter = res.headers.get('retry-after');
      const retryAfterMs = retryAfter === null ? null : Number(retryAfter) * 1000;
      const err = new PgError(
        res.status,
        code,
        message,
        envelope?.error?.detail ?? null,
        retryAfterMs !== null && Number.isFinite(retryAfterMs) ? retryAfterMs : null,
      );
      if (res.status === 410 && code === 'member_gone') throw new PgGone(err);
      if (res.status === 409 && code === 'poll_in_progress') throw new PgPollBusy(err);
      if (res.status >= 500) throw new PgUnavailable(res.status, message, envelope?.error?.detail ?? null);
      throw err;
    }

    return parsed as T;
  }
}
