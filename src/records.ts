/**
 * The two views of the same fact (设计说明 §12.3):
 *
 * - a member writes `sessions/<sha1(sessionFile)>.json` and `sessions/by-member/<id>.json`
 *   so a later session can prove who it is and a parent can find the file to reopen;
 * - a parent writes `children/<childId>.json` so it knows whom to reopen, with which
 *   cwd/args/token, and whether that child was terminated.
 *
 * Every file here can contain a token. Files are 0600 and their directories 0700; a
 * write is a temp file plus rename, exactly like `org.json` (设计说明 §8.3).
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export type ChildIntent = 'spawned' | 'terminated';

/** `sessions/<hash>.json`: who this pi session is on the platform. */
export interface SessionRecord {
  memberId: string;
  orgUrl: string;
  token: string;
  parentId: string | null;
  sessionFile: string;
  /** `<adapterDir>/orgs/<orgKey>/org.json`; absent from records written before organisations named themselves. */
  orgKey?: string;
}

/** `sessions/by-member/<memberId>.json`: where the parent can reopen that member. */
export interface MemberSessionFile {
  sessionFile: string;
}

/** `children/<childId>.json`: whom this member must be able to reopen. */
export interface ChildRecord {
  /** The member that wrote this record and is the only one allowed to act on it (§12.3). */
  parentId: string;
  childId: string;
  name: string;
  cwd: string | null;
  args: string[];
  token: string;
  intent: ChildIntent;
}

/** `<adapterDir>/respawn/<childId>.lock`: another process is already starting this child. */
export interface RespawnLock {
  pid: number;
  at: number;
}

const SESSIONS = 'sessions';
const BY_MEMBER = 'by-member';
const CHILDREN = 'children';

/** §12.3: the index key is the one thing a restarted session knows for certain. */
export function sessionFileHash(sessionFile: string): string {
  return createHash('sha1').update(sessionFile).digest('hex');
}

export function sessionRecordPath(adapterDir: string, sessionFile: string): string {
  return join(adapterDir, SESSIONS, `${sessionFileHash(sessionFile)}.json`);
}

export function memberSessionPath(adapterDir: string, memberId: string): string {
  return join(adapterDir, SESSIONS, BY_MEMBER, `${memberId}.json`);
}

export function childRecordPath(adapterDir: string, childId: string): string {
  return join(adapterDir, CHILDREN, `${childId}.json`);
}

/** Write both halves of "who I am" in one operation, so they cannot disagree. */
export function writeSessionRecords(adapterDir: string, record: SessionRecord): void {
  ensurePrivateDir(adapterDir);
  writePrivateJson(sessionRecordPath(adapterDir, record.sessionFile), {
    memberId: record.memberId,
    orgUrl: record.orgUrl,
    token: record.token,
    parentId: record.parentId,
    sessionFile: record.sessionFile,
    ...(record.orgKey === undefined || record.orgKey === '' ? {} : { orgKey: record.orgKey }),
  });
  writeMemberSessionFile(adapterDir, record.memberId, record.sessionFile);
}

/** The parent-facing half; exported separately so a test or repair can write just it. */
export function writeMemberSessionFile(adapterDir: string, memberId: string, sessionFile: string): void {
  ensurePrivateDir(adapterDir);
  const dir = join(adapterDir, SESSIONS, BY_MEMBER);
  ensurePrivateDir(dir);
  writePrivateJson(memberSessionPath(adapterDir, memberId), { sessionFile });
}

export function writeChildRecord(adapterDir: string, record: ChildRecord): void {
  ensurePrivateDir(adapterDir);
  ensurePrivateDir(join(adapterDir, CHILDREN));
  writePrivateJson(childRecordPath(adapterDir, record.childId), {
    parentId: record.parentId,
    childId: record.childId,
    name: record.name,
    cwd: record.cwd,
    args: record.args,
    token: record.token,
    intent: record.intent,
  });
}

/** `pg_terminate` keeps the record and changes its intent; deleting it would make respawn forget the tombstone. */
export function markChildrenTerminated(adapterDir: string, ids: Iterable<string>): void {
  for (const id of new Set(ids)) {
    const path = childRecordPath(adapterDir, id);
    const record = readChildFile(path);
    if (record === undefined) continue;
    writeChildRecord(adapterDir, { ...record, intent: 'terminated' });
  }
}

export function readSessionRecord(adapterDir: string, sessionFile: string): SessionRecord | undefined {
  const path = sessionRecordPath(adapterDir, sessionFile);
  const record = readJson(path);
  if (record === undefined) return undefined;
  const memberId = record.memberId;
  const orgUrl = record.orgUrl;
  const token = record.token;
  const storedFile = record.sessionFile;
  const orgKey = record.orgKey;
  if (
    typeof memberId !== 'string' ||
    typeof orgUrl !== 'string' ||
    typeof token !== 'string' ||
    typeof storedFile !== 'string' ||
    (orgKey !== undefined && orgKey !== null && typeof orgKey !== 'string')
  ) {
    console.warn(`[pigroups] ignoring ${path}: it is not a complete session record`);
    return undefined;
  }
  return {
    memberId,
    orgUrl,
    token,
    parentId: typeof record.parentId === 'string' ? record.parentId : null,
    sessionFile: storedFile,
    ...(typeof orgKey === 'string' && orgKey !== '' ? { orgKey } : {}),
  };
}

export function readSessionFileForMember(adapterDir: string, memberId: string): string | undefined {
  const path = memberSessionPath(adapterDir, memberId);
  const record = readJson(path);
  if (record === undefined) return undefined;
  return typeof record.sessionFile === 'string' && record.sessionFile !== '' ? record.sessionFile : undefined;
}

/**
 * This member's child records, sorted by id, so a respawn run is deterministic.
 * `children/` is shared by every member that inherited the same adapter directory, so
 * the `parentId` filter is the trust boundary: without it a parent would reopen another
 * member's child and register its pane as its own (§12.3).
 */
export function readChildRecords(adapterDir: string, parentId: string): ChildRecord[] {
  const dir = join(adapterDir, CHILDREN);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: ChildRecord[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const record = readChildFile(join(dir, name));
    if (record !== undefined && record.parentId === parentId) records.push(record);
  }
  return records;
}

function readChildFile(path: string): ChildRecord | undefined {
  const record = readJson(path);
  if (record === undefined) return undefined;
  const { parentId, childId, name, cwd, args, token, intent } = record;
  if (
    typeof parentId !== 'string' ||
    parentId === '' ||
    typeof childId !== 'string' ||
    typeof name !== 'string' ||
    typeof token !== 'string' ||
    (intent !== 'spawned' && intent !== 'terminated') ||
    !Array.isArray(args) ||
    !args.every((arg: unknown) => typeof arg === 'string') ||
    (cwd !== null && typeof cwd !== 'string')
  ) {
    console.warn(`[pigroups] ignoring ${path}: it is not a complete child record`);
    return undefined;
  }
  return { parentId, childId, name, cwd: cwd ?? null, args, token, intent };
}

export function respawnLockPath(adapterDir: string, childId: string): string {
  return join(adapterDir, 'respawn', `${childId}.lock`);
}

/** Read a lock without claiming it. `undefined` covers a missing file and an unreadable one. */
export function readRespawnLock(adapterDir: string, childId: string): RespawnLock | undefined {
  const path = respawnLockPath(adapterDir, childId);
  const record = readJson(path);
  if (record === undefined) return undefined;
  const { pid, at } = record;
  if (!Number.isInteger(pid) || pid <= 0 || typeof at !== 'number' || !Number.isFinite(at)) {
    console.warn(`[pigroups] ignoring ${path}: it is not a complete respawn lock`);
    return undefined;
  }
  return { pid, at };
}

/**
 * Claim the lock atomically. `wx` is the cross-process decision: exactly one writer can
 * create the file, so two parents cannot both decide they are the one starting the child.
 * The lock can contain a pid but no token; 0600 is still the house rule for every file
 * under the adapter root (§12.1).
 */
export function createRespawnLock(adapterDir: string, childId: string, lock: RespawnLock): boolean {
  const dir = join(adapterDir, 'respawn');
  ensurePrivateDir(adapterDir);
  ensurePrivateDir(dir);
  const path = respawnLockPath(adapterDir, childId);
  try {
    writeFileSync(path, `${JSON.stringify(lock)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw err;
  }
}

export function removeRespawnLock(adapterDir: string, childId: string): void {
  rmSync(respawnLockPath(adapterDir, childId), { force: true });
}

function readJson(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(`[pigroups] ignoring ${path}: expected a JSON object`);
      return undefined;
    }
    return parsed as Record<string, any>;
  } catch (err) {
    console.warn(`[pigroups] ignoring ${path}: ${(err as Error)?.message ?? String(err)}`);
    return undefined;
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writePrivateJson(path: string, value: unknown): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  // A pid and random suffix keep two writers (or a retry after a crash) from sharing
  // one temp name; rename is atomic, so a reader sees the old file or the new one.
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}
