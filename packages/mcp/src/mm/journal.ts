/**
 * The send journal of the `mm recta` plugin (owner 2026-11-11 21:22, Fable P-1/P-2/P-3 on #19).
 *
 * Every transaction this plugin asks MetaMask to send is written here, and fsynced, BEFORE MetaMask is asked: if the
 * process dies during the send, the attempt survives as UNKNOWN. While any attempt of a wallet is unresolved (UNKNOWN,
 * or SENT and not yet mined), no Recta command sends anything from that wallet; only `mm recta recover`, from
 * MetaMask's and the chain's evidence, resolves it. One file per wallet, mode 0600, in a 0700 directory.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
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
  /** MetaMask's pending-job ids before the send: the job of this attempt is a new one. */
  readonly mm_jobs_before: readonly string[];
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
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(this.lockFile, "wx", 0o600);
        try { writeSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
        this.locked = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") fail("lock", e);
        let pid = NaN;
        try { pid = Number(readFileSync(this.lockFile, "utf8")); } catch { /* removed meanwhile */ }
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
          throw new RectaCheckError("wallet_busy", `another mm recta command (process ${pid}) is sending from this wallet: nothing was sent; wait for it to finish`);
        }
        try { unlinkSync(this.lockFile); } catch { /* removed meanwhile */ }
      }
    }
    fail("lock", new Error("lock contended"));
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
