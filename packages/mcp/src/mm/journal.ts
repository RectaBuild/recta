/**
 * The send journal of the `mm recta` plugin (owner 2026-11-11 21:22, Fable P-1/P-2/P-3 on #19).
 *
 * Every transaction this plugin asks MetaMask to send is written here, and fsynced, BEFORE MetaMask is asked: if the
 * process dies during the send, the attempt survives as UNKNOWN. While any attempt of a wallet is unresolved (UNKNOWN,
 * or SENT and not yet mined), no Recta command sends anything from that wallet; only `mm recta recover`, from
 * MetaMask's and the chain's evidence, resolves it. One file per wallet, mode 0600, in a 0700 directory.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RectaCheckError } from "@recta/client";

export type AttemptState = "UNKNOWN" | "SENT" | "NOT_SENT" | "REVERTED";
export type ChainStatus = "PENDING" | "CONFIRMED" | "REVERTED";

export interface JournalAttempt {
  readonly id: string;
  readonly command: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly wallet: string;
  readonly chain_id: number;
  readonly to: string;
  readonly data_keccak: string;
  readonly value: string;
  readonly gas: string;
  readonly max_fee_per_gas: string;
  readonly max_priority_fee_per_gas: string;
  /** The wallet's pending nonce read just before the send. */
  readonly nonce: number;
  readonly approval: boolean;
  readonly result_id?: string;
  /** What the agent asked to move: a later run with the same identity is what must never happen twice. */
  readonly economic: Readonly<Record<string, string>>;
  /** In the request's intent summary: MetaMask's job for this attempt is the one whose `intent` carries it. */
  readonly tag: string;
  /** mm's wallet mode when the attempt was made (byok signs at once and keeps no request to sign later). */
  readonly wallet_mode?: string;
  readonly state: AttemptState;
  readonly chain_status?: ChainStatus;
  readonly hash?: string;
  readonly mm_job?: string;
  readonly evidence?: string;
}

/** An attempt blocks every send from its wallet until evidence resolves it. */
export function unresolved(a: JournalAttempt): boolean {
  return a.state === "UNKNOWN" || (a.state === "SENT" && a.chain_status !== "CONFIRMED" && a.chain_status !== "REVERTED");
}

export function journalDir(override?: string): string {
  return override ?? process.env["RECTA_MM_JOURNAL_DIR"] ?? join(homedir(), ".recta", "mm-journal");
}

const fail = (what: string, e: unknown): never => {
  throw new RectaCheckError("journal", `could not ${what} Recta's send journal (${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}): nothing was sent`);
};

/** A wallet's journal. Reads tolerate a missing file; every write is atomic and fsynced, or it throws. */
export class SendJournal {
  readonly file: string;
  private readonly lockFile: string;
  private locked = false;

  constructor(readonly dir: string, wallet: string) {
    const name = wallet.toLowerCase();
    this.file = join(dir, `${name}.json`);
    this.lockFile = join(dir, `${name}.lock`);
  }

  read(): JournalAttempt[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      return fail("read", e);
    }
    try {
      const parsed = JSON.parse(text) as { attempts?: unknown };
      if (!Array.isArray(parsed.attempts)) throw new Error("no attempts list");
      // Fable L-2: an entry that cannot be read as an attempt may be an UNKNOWN send: the whole journal is refused.
      for (const a of parsed.attempts) if (!wellFormed(a)) throw new Error(`malformed entry ${JSON.stringify(a).slice(0, 120)}`);
      return parsed.attempts as JournalAttempt[];
    } catch (e) {
      // A journal that cannot be read may hide an UNKNOWN send: never treat it as empty.
      return fail("parse", e);
    }
  }

  private write(attempts: readonly JournalAttempt[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify({ version: 1, attempts }, null, 1));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      const dirFd = openSync(this.dir, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* nothing to remove */ }
      fail("write", e);
    }
  }

  /** Adds or replaces (by id) one attempt. */
  put(attempt: JournalAttempt): void {
    const all = this.read();
    const i = all.findIndex((a) => a.id === attempt.id);
    if (i < 0) all.push(attempt); else all[i] = attempt;
    this.write(all);
  }

  /**
   * One sending command at a time per wallet. A lock left by a process that no longer runs is taken over: the
   * journal, not the lock, is what remembers its sends.
   */
  lock(): void {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      fail("create", e);
    }
    for (let i = 0; i < 3; i++) {
      // The pid is written to a private file first and linked into place: the lock never exists without its pid
      // (Fable L-1).
      const mine = `${this.lockFile}.${process.pid}.${i}`;
      try {
        const fd = openSync(mine, "w", 0o600);
        try { writeSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
        linkSync(mine, this.lockFile);
        this.locked = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") fail("lock", e);
      } finally {
        try { unlinkSync(mine); } catch { /* not created */ }
      }
      const held = this.holder();
      if (held === "busy") throw new RectaCheckError("wallet_busy", "another mm recta command is sending from this wallet: nothing was sent; wait for it to finish");
      // A dead holder's lock: move it aside under a private name, so two processes cannot both take it over. If what
      // was moved is not the dead lock (another process took it over first), it is put back.
      const aside = `${this.lockFile}.stale.${process.pid}.${i}`;
      try { renameSync(this.lockFile, aside); } catch { continue; }
      let moved: string | undefined;
      try { moved = readFileSync(aside, "utf8"); } catch { /* unreadable */ }
      if (moved !== held) {
        try { linkSync(aside, this.lockFile); } catch { /* a newer lock is in place */ }
        try { unlinkSync(aside); } catch { /* gone */ }
        throw new RectaCheckError("wallet_busy", "another mm recta command took this wallet's lock: nothing was sent; wait for it to finish");
      }
      try { unlinkSync(aside); } catch { /* gone */ }
    }
    fail("lock", new Error("lock contended"));
  }

  /** The content of a lock whose holder is gone (it may be taken over), or "busy". */
  private holder(): string | "busy" {
    let content: string;
    try {
      content = readFileSync(this.lockFile, "utf8");
    } catch {
      return "";
    }
    const pid = Number(content);
    if (!Number.isInteger(pid) || pid <= 0) {
      // Not a lock this module wrote whole: only an old one is taken over.
      try { if (Date.now() - statSync(this.lockFile).mtimeMs < 60_000) return "busy"; } catch { return ""; }
      return content;
    }
    return alive(pid) ? "busy" : content;
  }

  unlock(): void {
    if (!this.locked) return;
    this.locked = false;
    try { unlinkSync(this.lockFile); } catch { /* already gone */ }
  }
}

function alive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const STATES: ReadonlySet<string> = new Set(["UNKNOWN", "SENT", "NOT_SENT", "REVERTED"]);
function wellFormed(a: unknown): boolean {
  if (typeof a !== "object" || a === null) return false;
  const r = a as Record<string, unknown>;
  return typeof r["id"] === "string" && typeof r["state"] === "string" && STATES.has(r["state"]) && typeof r["wallet"] === "string" && typeof r["chain_id"] === "number" && typeof r["nonce"] === "number" && typeof r["to"] === "string" && typeof r["data_keccak"] === "string" && typeof r["tag"] === "string" && typeof r["approval"] === "boolean";
}
