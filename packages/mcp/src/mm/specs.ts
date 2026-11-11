import { keccak256, type Hex } from "viem";
import { randomUUID } from "node:crypto";
import { RectaCheckError } from "@recta/client";
import { configFromEnv, networkChainIds } from "../index.js";
import { journalDir, SendJournal, unresolved, type JournalAttempt } from "./journal.js";
import { metaMaskRectaServer, metaMaskSigner, selectedMetaMaskAddress, type MetaMaskPublicClientFor, type MetaMaskSentTransaction, type MetaMaskWalletExecutor, type MetaMaskWalletStateLike } from "../metamask.js";

/**
 * The `mm recta …` commands: Recta as a plugin of the MetaMask Agent Wallet CLI (`mm plugins install @recta/mcp`).
 * Each command answers through the local MCP server's own tools, so its checks and answers are those of
 * `npx @recta/mcp`. This file never imports MetaMask: the command files pass in `@metamask/agent-wallet/plugin`,
 * which `mm` resolves to its own running copy, and `scripts/mm-manifest.mjs` reads the same table to write
 * `oclif.manifest.json` and to check `package.json#mm`.
 */

export type Capability = "wallet-read" | "wallet-submit";

export interface InputSpec {
  readonly flag: string;
  readonly kind: "text" | "boolean";
  readonly message: string;
  readonly required?: boolean;
  /** The tool argument this flag fills (snake_case), or none for the command's own settings. */
  readonly arg?: string;
}

const text = (flag: string, message: string, extra: Partial<InputSpec> = {}): InputSpec => ({ flag, kind: "text", message, arg: flag.replaceAll("-", "_"), ...extra });
const setting = (flag: string, message: string): InputSpec => ({ flag, kind: "text", message });

const ROUTE: readonly InputSpec[] = [
  text("source-network", "Source network key, e.g. base, arbitrum, ethereum, optimism, polygon.", { required: true }),
  text("source-asset", "Asset moved, e.g. USDC or USDT.", { required: true }),
  text("destination-network", "Destination network key.", { required: true }),
  text("destination-asset", "Asset received; default the source asset."),
];
const TRANSFER: readonly InputSpec[] = [
  ...ROUTE,
  text("amount", "Amount in whole units of the asset (100 means 100 USDC), at least 3.5, no maximum.", { required: true }),
  text("baseline-provider", "The route you would use without Recta, one of the corridor's declarable_baselines in mm recta fit: across, stargate_v2, usdt0, usdg_oft, debridge_dln or lifi.", { required: true }),
  text("recipient", "Receiving address on the destination; default the wallet itself."),
  text("guarantee-class", "COMMITTED_ENFORCED or ANY (default ANY)."),
  text("latency-class", "SECONDS, MINUTES, FINALITY_BOUND or ANY (default ANY)."),
];
const ADDRESS = setting("address", "The EVM address of the wallet mm signs with; default the wallet selected in mm.");
const LIMITS: readonly InputSpec[] = [
  setting("max-fee-usdc", "Most USDC one fee permit may authorize (default 1)."),
  setting("max-native-wei", "Most native value a route transaction may carry, in wei (default 0)."),
  setting("min-output-bps", "Least share of the amount that must arrive, in basis points (default 9900)."),
  setting("max-fee-gwei", "Ceiling on the source chain's max fee per gas, in gwei (default 50)."),
  setting("max-priority-fee-gwei", "Ceiling on the source chain's priority fee per gas, in gwei (default 2)."),
  setting("referrer", "Who referred this agent: the EVM address of the plugin, template or setup author (optional)."),
];

export interface CommandSpec {
  readonly id: string;
  readonly description: string;
  readonly capabilities: readonly Capability[];
  readonly dataAccess: readonly ("accounts" | "balances")[];
  readonly targetChains: "any" | readonly number[];
  readonly inputs: readonly InputSpec[];
  /** keyless: signs nothing, needs no wallet. read: names the wallet, signs nothing. sign: signs requests. send: signs permits and sends. */
  readonly wallet: "none" | "read" | "sign" | "send";
  run(call: ToolCall, args: Record<string, unknown>, flags: Readonly<Record<string, unknown>>, env: RunEnv): Promise<Record<string, unknown>>;
}

/** What a command's run may use beyond the MCP tools. */
export interface RunEnv {
  readonly ctx: MmContextLike;
  readonly address?: Hex;
  /** The send journal of `address`, locked for this run (sending commands and recover only). */
  readonly journal?: SendJournal;
  /** Called by `move` as soon as the evaluation's result_id is known, so every journaled attempt carries it. */
  setResultId(id: string): void;
}

export type ToolCall = (name: string, input: Record<string, unknown>) => Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }>;

/** A failed tool call, with the MCP server's own JSON answer as its message. */
export class RectaToolError extends Error {
  constructor(readonly body: Record<string, unknown>) {
    super(JSON.stringify(body));
  }
}

const answer = async (call: ToolCall, name: string, input: Record<string, unknown>) => {
  const r = await call(name, input);
  if (r.isError) throw new RectaToolError(withoutCheckPrefix(r.body));
  return r.body;
};

/** The MCP server's CHECK_FAILED message repeats the check ("fee_amount: …"); say it once (Fable B-2 on #19). */
function withoutCheckPrefix(body: Record<string, unknown>): Record<string, unknown> {
  const check = body["check"];
  const message = body["message"];
  return typeof check === "string" && typeof message === "string" && message.startsWith(`${check}: `) ? { ...body, message: message.slice(check.length + 2) } : body;
}

const one = (name: string): CommandSpec["run"] => (call, args) => answer(call, name, args);

/** Every chain a Recta route can start from (the client's pinned routes), and Base, where the fee is paid. */
const ROUTE_CHAINS: readonly number[] = [...new Set([...networkChainIds().values(), 8453])].sort((a, b) => a - b);

/** The MCP server's preview names its tools; here they are commands. */
function asCommands(preview: Record<string, unknown>): Record<string, unknown> {
  const note = preview["note"];
  if (typeof note !== "string") return preview;
  return { ...preview, note: note.replaceAll("recta_execute", "mm recta move --execute").replaceAll("recta_fee_funds", "mm recta fee-funds").replaceAll("recta_approve_fee", "mm recta approve-fee") };
}

/** An error as the MCP server would answer it. */
function bodyOf(e: unknown): Record<string, unknown> {
  if (e instanceof RectaToolError) return e.body;
  if (e instanceof RectaCheckError) return { error: "CHECK_FAILED", check: e.check, message: e.message.startsWith(`${e.check}: `) ? e.message.slice(e.check.length + 2) : e.message };
  return { error: "FAILED", message: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500) };
}

const NO_SAVING = "No saving Recta can prove at this chain state: keep your own route. Nothing is owed.";

export const COMMAND_SPECS: readonly CommandSpec[] = [
  {
    id: "recta:fit",
    description: "Free, signs nothing: does Recta cover this corridor, and which contracts would a route call?",
    capabilities: [],
    dataAccess: [],
    targetChains: "any",
    inputs: ROUTE,
    wallet: "none",
    run: one("recta_fit"),
  },
  {
    id: "recta:trial",
    description: "Free, signs nothing: is there a cheaper provable route than yours, and how much would Recta's 5 % of the saving be? 3 a day per IP address.",
    capabilities: ["wallet-read"],
    dataAccess: ["accounts"],
    targetChains: "any",
    inputs: [...TRANSFER, ADDRESS],
    wallet: "read",
    run: one("recta_trial_evaluation"),
  },
  {
    id: "recta:move",
    description:
      "Before a cross-chain stablecoin transfer: asks Recta, signed by your MetaMask wallet, for a cheaper route than yours (free). Without --execute it stops at the preview. With --execute it signs the fee permit and sends Recta's checked transactions through MetaMask, then reports them: Recta charges exactly 5 % of the saving it verifies on chain.",
    capabilities: ["wallet-read", "wallet-submit"],
    dataAccess: ["accounts", "balances"],
    targetChains: ROUTE_CHAINS,
    inputs: [...TRANSFER, { flag: "execute", kind: "boolean", message: "Sign the fee permit and send the route (default: preview only)." }, ADDRESS, ...LIMITS],
    wallet: "send",
    run: async (call, args, flags, env) => {
      const evaluation = await answer(call, "recta_evaluate", args);
      const decision = evaluation["decision"];
      const state = typeof decision === "object" && decision !== null ? (decision as Record<string, unknown>)["state"] : undefined;
      const resultId = evaluation["result_id"];
      if (state !== "VERIFIED_POSITIVE" || typeof resultId !== "string") return { evaluation, next: NO_SAVING };
      if (flags["execute"] !== true) {
        return {
          evaluation,
          preview: asCommands(await answer(call, "recta_preview", { result_id: resultId })),
          next: "Nothing was signed beyond the request or sent. To move it through Recta, run the same command with --execute: Recta evaluates again at the new chain state, then MetaMask signs the fee permit and sends the checked transactions.",
        };
      }
      env.setResultId(resultId);
      try {
        return { evaluation, execution: await answer(call, "recta_execute", { result_id: resultId }) };
      } catch (e) {
        // Keep what `mm recta report` needs: this process is the only one that knows the result_id.
        throw e instanceof RectaToolError ? new RectaToolError({ ...e.body, result_id: resultId }) : new RectaToolError({ ...bodyOf(e), result_id: resultId });
      }
    },
  },
  {
    id: "recta:report",
    description: "Reports an executed route again (for example after a PENDING answer). Returns ACCRUED, PENDING or REFUSED.",
    capabilities: ["wallet-read", "wallet-submit"],
    dataAccess: ["accounts"],
    targetChains: [8453],
    inputs: [text("result-id", "The result_id of the evaluation.", { required: true }), text("origin-tx-hash", "The route's origin transaction hash.", { required: true }), text("approval-tx-hash", "The route's approval transaction hash, if it had one."), ADDRESS],
    wallet: "sign",
    run: one("recta_report"),
  },
  {
    id: "recta:ledger",
    description: "Your wallet's Recta fees and whether each was collected.",
    capabilities: ["wallet-read", "wallet-submit"],
    dataAccess: ["accounts"],
    targetChains: [8453],
    inputs: [ADDRESS],
    wallet: "sign",
    run: one("recta_ledger"),
  },
  {
    id: "recta:fee-funds",
    description: "Free, signs nothing: whether your wallet can pay a Recta fee (its USDC on Base and its USDC allowance to Permit2).",
    capabilities: ["wallet-read"],
    dataAccess: ["accounts", "balances"],
    targetChains: [8453],
    inputs: [text("amount-usdc", "USDC to check against, e.g. 0.5; default --max-fee-usdc."), ADDRESS, LIMITS[0]!],
    wallet: "read",
    run: one("recta_fee_funds"),
  },
  {
    id: "recta:approve-fee",
    description: "Sends one bounded approval on Base, USDC.approve(Permit2, amount), so Recta's fee permits can be collected. At most --max-fee-usdc; never unlimited.",
    capabilities: ["wallet-read", "wallet-submit"],
    dataAccess: ["accounts", "balances"],
    targetChains: [8453],
    inputs: [text("amount-usdc", "USDC to approve, e.g. 1; default and maximum --max-fee-usdc."), ADDRESS, ...LIMITS],
    wallet: "send",
    run: one("recta_approve_fee"),
  },
  {
    id: "recta:pay-debt",
    description: "When Recta answered DEBT: signs the debt permit it offered (same checks as a fee permit, never above --max-fee-usdc) so evaluations can continue.",
    capabilities: ["wallet-read", "wallet-submit"],
    dataAccess: ["accounts", "balances"],
    targetChains: [8453],
    inputs: [setting("debt-offer", "The debt_offer JSON object exactly as Recta returned it."), ADDRESS, ...LIMITS],
    wallet: "send",
    run: async (call, _args, flags) => {
      const raw = flags["debt-offer"];
      if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) throw new RectaCheckError("input", "--debt-offer must be the debt_offer JSON object Recta returned");
      let offer: unknown;
      try { offer = JSON.parse(raw); } catch { throw new RectaCheckError("input", "--debt-offer is not valid JSON"); }
      return answer(call, "recta_pay_debt", { debt_offer: offer });
    },
  },
  {
    id: "recta:recover",
    description: "Resolves an earlier send whose outcome is not known (RECTA_SEND_UNKNOWN), from MetaMask's requests and the chain. Sends nothing.",
    capabilities: ["wallet-read"],
    dataAccess: ["accounts"],
    targetChains: "any",
    inputs: [
      text("tx-hash", "A transaction hash you found for the unresolved send (mm tx history, mm wallet requests list, or the explorer). It is checked on chain, never trusted."),
      text("attempt-id", "Which unresolved attempt --tx-hash belongs to, when there is more than one."),
      ADDRESS,
    ],
    wallet: "read",
    run: (_call, _args, flags, env) => recover(env, flags),
  },
];

/** What a command reads of `PluginCommandContext` (@metamask/agent-wallet 7.3.0). */
export interface MmContextLike {
  readonly walletStateManager?: { read(): MetaMaskWalletStateLike };
  publicClient(chainId: number): ReturnType<MetaMaskPublicClientFor>;
  walletExecutor(io: unknown, source: string): Promise<MetaMaskWalletExecutor>;
  /** Where the send journal lives (default: $RECTA_MM_JOURNAL_DIR, else ~/.recta/mm-journal). */
  readonly journalDir?: string;
}

const present = (v: unknown): v is string | boolean => (typeof v === "string" && v.length > 0) || typeof v === "boolean";

/**
 * Whether this run of the command can send a transaction: `mm recta move --execute` and `mm recta approve-fee`. Every
 * answer of such a run carries `execution_state` (Fable U-1 on #19).
 */
function sends(spec: Pick<CommandSpec, "id">, flags: Readonly<Record<string, unknown>>): boolean {
  return spec.id === "recta:approve-fee" || (spec.id === "recta:move" && flags["execute"] === true);
}

const RECOVER = "mm recta recover";

/**
 * The answer to any error of a run that can send (owner 2026-11-11 21:16/21:22, Fable M-1/R-1/R-2/U-1/P-3 on #19):
 * it never implies that sending again is safe. It carries `execution_state`, `transfer_sent` (YES | NO | UNKNOWN), the
 * evaluation's result_id, every known hash, and one unambiguous instruction.
 *  - NOT_SENT: nothing was attempted, or MetaMask answered DENIED/EXPIRED: it never signed.
 *  - UNKNOWN: a send was attempted and its outcome is not known. It stays in the journal and blocks every send from
 *    this wallet until `mm recta recover` resolves it from MetaMask's and the chain's evidence.
 *  - REVERTED: the last transaction was mined and reverted; it moved nothing.
 *  - SENT: the transfer left (`chain_status` PENDING | CONFIRMED | REVERTED): report it, never send it again.
 *  - APPROVAL_ONLY: only an approval left; no transfer was sent.
 */
export function afterSend(spec: Pick<CommandSpec, "id">, body: Record<string, unknown>, sent: readonly MetaMaskSentTransaction[]): Record<string, unknown> {
  const tried = sent.filter((t) => t.state !== "NOT_SENT");
  const hashes = tried.flatMap((t) => (t.hash === undefined ? [] : [t.hash]));
  const approvals = tried.filter((t) => t.approval && t.state === "SENT").map((t) => t.hash!);
  const transferTx = tried.find((t) => !t.approval && t.state === "SENT");
  const transfer = transferTx?.hash;
  const resultId = typeof body["result_id"] === "string" ? body["result_id"] : undefined;
  const last = tried[tried.length - 1];
  if (last === undefined) {
    return { ...body, execution_state: "NOT_SENT", transfer_sent: "NO", next: "Nothing was sent from this wallet: MetaMask did not sign, or the command stopped before asking it to." };
  }
  const base = { ...body, sent_tx_hashes: hashes, ...(approvals.length === 0 ? {} : { approval_tx_hashes: approvals }) };
  const reportCmd = (origin: string) => resultId === undefined ? "" : `mm recta report --result-id ${resultId} --origin-tx-hash ${origin}${approvals.length > 0 && spec.id === "recta:move" ? ` --approval-tx-hash ${approvals[0]}` : ""}`;
  if (body["check"] === "transaction_failed" && last.state === "SENT" && last.hash !== undefined) {
    const standing = last.approval || approvals.length === 0 ? "" : ` The approval ${approvals.join(", ")} to the route's contract was mined and still stands: reuse it, or revoke it with an approve of 0 if you will not use this route.`;
    return { ...base, execution_state: "REVERTED", transfer_sent: "NO", chain_status: "REVERTED", reverted_tx_hash: last.hash, next: `${last.approval ? "The approval" : "The transfer"} ${last.hash} was mined and reverted on chain: it moved nothing${last.approval ? ", and no transfer was sent" : ""}. You may move the funds by Recta again or by your own route.${standing}` };
  }
  if (last.state === "UNKNOWN" || body["check"] === "wallet_unconfirmed") {
    const what = last.approval ? "an approval" : "the transfer";
    const known = last.hash === undefined ? "no hash is known" : `MetaMask gave the hash ${last.hash}`;
    return {
      ...base,
      execution_state: "UNKNOWN",
      transfer_sent: last.approval ? "NO" : "UNKNOWN",
      chain_id: last.chainId,
      address: last.from,
      to: last.to,
      nonce: last.nonce,
      ...(last.hash === undefined ? {} : { unconfirmed_tx_hash: last.hash }),
      next: `MetaMask may have broadcast ${what} from ${last.from} on chain ${last.chainId} to ${last.to} (nonce ${last.nonce} when it was asked; ${known}), now or later: a request waiting for approval in MetaMask can still be sent. Recta will send nothing more from this wallet until this is resolved, and you must not move these funds by any other route either. Run ${RECOVER}: it reads MetaMask's requests and the chain and says what happened.${last.approval ? " Do not send the approval again." : ""}${resultId === undefined || last.approval ? "" : ` If the transfer left, report it with ${reportCmd(last.hash ?? "<its hash>")}.`}`,
    };
  }
  if (transfer !== undefined) {
    const report = reportCmd(transfer);
    return { ...base, execution_state: "SENT", transfer_sent: "YES", chain_status: transferTx?.chainStatus ?? "PENDING", origin_tx_hash: transfer, next: `The transfer was sent (${transfer}): never send it again, by Recta or by your own route.${report === "" ? "" : ` Report it once it is mined: ${report}`}` };
  }
  return { ...base, execution_state: "APPROVAL_ONLY", transfer_sent: "NO", next: `Only an approval was sent (${approvals.join(", ")}); no transfer left this wallet. Do not send the approval again.` };
}

/** MetaMask job states that end a request without signing it (fox-sdk TX_JOB_STATUS). */
const JOB_UNSIGNED: ReadonlySet<string> = new Set(["DENIED", "EXPIRED"]);
/** Every terminal job state; any other state is a request MetaMask may still sign and broadcast. */
const JOB_TERMINAL: ReadonlySet<string> = new Set(["DENIED", "EXPIRED", "FAILED", "BROADCAST_FAILED", "BROADCASTED", "CONFIRMED", "BROADCAST_TRACKING_EXPIRED", "CONFIRMATION_TRACKING_EXPIRED"]);
const HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * `mm recta recover` (owner 2026-11-11 21:22, Fable P-3 on #19): resolves each unresolved attempt of this wallet by
 * evidence only, MetaMask's requests and the chain, never by the absence of a transaction:
 *  - its transaction found on chain (from this wallet, the committed `to` and data) → SENT with chain_status
 *    PENDING | CONFIRMED, or REVERTED;
 *  - MetaMask's request for it ended DENIED or EXPIRED without a hash, or its nonce was taken by another identified
 *    transaction of this wallet while MetaMask holds no open request for it → NOT_SENT;
 *  - anything else stays UNKNOWN and keeps blocking.
 */
async function recover(env: RunEnv, flags: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const journal = env.journal;
  const address = env.address;
  if (journal === undefined || address === undefined) throw new RectaCheckError("wallet_address", "pass --address with the wallet whose sends to recover");
  const given = typeof flags["tx-hash"] === "string" && flags["tx-hash"] !== "" ? (flags["tx-hash"] as string) : undefined;
  if (given !== undefined && !HASH.test(given)) throw new RectaCheckError("input", "--tx-hash must be 0x + 64 hex characters");
  const forId = typeof flags["attempt-id"] === "string" && flags["attempt-id"] !== "" ? (flags["attempt-id"] as string) : undefined;
  const all = journal.read();
  const open = all.filter(unresolved);
  if (given !== undefined && forId === undefined && open.length > 1) throw new RectaCheckError("input", `there are ${open.length} unresolved attempts: pass --attempt-id with --tx-hash`);
  const jobs = mmJobs(env.ctx);
  const claimed = new Set(all.flatMap((a) => (a.mm_job === undefined ? [] : [a.mm_job])));
  const results: JournalAttempt[] = [];
  for (const a of open) {
    const client = env.ctx.publicClient(a.chain_id);
    const now = new Date().toISOString();
    // MetaMask's request for this attempt: the one recorded, or the only new transaction request on its chain.
    let job = a.mm_job === undefined ? undefined : jobs.find((j) => j.pollingId === a.mm_job);
    let ambiguous = false;
    if (job === undefined && a.mm_job === undefined) {
      const fresh = jobs.filter((j) => typeof j.pollingId === "string" && !a.mm_jobs_before.includes(j.pollingId) && !claimed.has(j.pollingId) && (j.chainId === undefined || j.chainId === a.chain_id) && (j.kind === undefined || /tx|transaction/i.test(j.kind)) && (j.submittedAt === undefined || Date.parse(j.submittedAt) >= Date.parse(a.created_at) - 60_000));
      if (fresh.length === 1) job = fresh[0];
      ambiguous = fresh.length > 1;
    }
    const jobStatus = typeof job?.status === "string" ? job.status : undefined;
    const jobOpen = job !== undefined && (jobStatus === undefined || !JOB_TERMINAL.has(jobStatus));
    const hashes = [...new Set([a.hash, typeof job?.txHash === "string" && HASH.test(job.txHash) ? job.txHash : undefined, given !== undefined && (forId === undefined || forId === a.id) ? given : undefined].filter((h): h is string => h !== undefined).map((h) => h.toLowerCase()))];
    let next: Omit<JournalAttempt, "id" | "command" | "created_at" | "wallet" | "chain_id" | "to" | "data_keccak" | "value" | "gas" | "max_fee_per_gas" | "max_priority_fee_per_gas" | "nonce" | "approval" | "economic" | "mm_jobs_before"> & Partial<JournalAttempt> = { ...a, updated_at: now, ...(job?.pollingId === undefined ? {} : { mm_job: job.pollingId }) };
    let resolved = false;
    const notes: string[] = [];
    for (const hash of hashes) {
      let tx: Awaited<ReturnType<ReturnType<MetaMaskPublicClientFor>["getTransaction"]>> | undefined;
      try { tx = await client.getTransaction({ hash: hash as Hex }); } catch { tx = undefined; }
      if (tx === undefined || tx === null) { notes.push(`${hash} is not on chain ${a.chain_id} yet (that is not proof it was never sent)`); continue; }
      if (tx.from.toLowerCase() !== a.wallet) { notes.push(`${hash} was sent from ${tx.from}, not from this wallet`); continue; }
      const ours = (tx.to ?? "").toLowerCase() === a.to && keccak256(tx.input) === a.data_keccak && tx.value.toString() === a.value;
      if (ours) {
        let status: string | undefined;
        try { status = (await client.getTransactionReceipt({ hash: hash as Hex })).status; } catch { status = undefined; }
        next = status === undefined
          ? { ...next, state: "SENT", chain_status: "PENDING", hash, evidence: `${hash} is this attempt's transaction, not yet mined` }
          : status === "success"
            ? { ...next, state: "SENT", chain_status: "CONFIRMED", hash, evidence: `${hash} is this attempt's transaction, mined successfully` }
            : { ...next, state: "REVERTED", chain_status: "REVERTED", hash, evidence: `${hash} is this attempt's transaction, mined and reverted: it moved nothing` };
        resolved = true;
        break;
      }
      if (tx.nonce === a.nonce && tx.blockNumber !== null && !jobOpen && !ambiguous) {
        next = { ...next, state: "NOT_SENT", evidence: `nonce ${a.nonce} of this wallet was taken by another mined transaction, ${hash}, and MetaMask holds no open request for this attempt` };
        resolved = true;
        break;
      }
      notes.push(`${hash} is another transaction of this wallet (nonce ${tx.nonce}), not this attempt`);
    }
    if (!resolved) {
      if (job !== undefined && jobStatus !== undefined && JOB_UNSIGNED.has(jobStatus) && job.txHash === undefined && a.hash === undefined) {
        next = { ...next, state: "NOT_SENT", evidence: `MetaMask's request ${job.pollingId} ended ${jobStatus} without signing` };
      } else {
        let confirmed: number | undefined;
        try { confirmed = await client.getTransactionCount({ address: a.wallet as Hex, blockTag: "latest" }); } catch { confirmed = undefined; }
        const why = [
          ...notes,
          ambiguous ? "MetaMask holds more than one new request on this chain: pass the right --tx-hash" : "",
          jobOpen ? `MetaMask's request ${job!.pollingId} is still open (${jobStatus ?? "no status"}): it can still be signed and broadcast; approve or reject it in MetaMask (mm wallet requests list), then run recover again` : "",
          job !== undefined && jobStatus !== undefined && !jobOpen && !JOB_UNSIGNED.has(jobStatus) ? `MetaMask's request ${job.pollingId} ended ${jobStatus}${job.txHash === undefined ? " without a hash" : ""}` : "",
          confirmed === undefined ? "the wallet's confirmed nonce could not be read" : confirmed > a.nonce ? `nonce ${a.nonce} of this wallet has been used (confirmed nonce ${confirmed}): find that transaction (mm tx history, or the explorer) and pass it with --tx-hash` : `nonce ${a.nonce} of this wallet is not used yet (confirmed nonce ${confirmed}); that alone does not prove this attempt will never be sent`,
        ].filter((x) => x !== "");
        next = { ...next, state: "UNKNOWN", evidence: why.join("; ") };
      }
    }
    const updated = next as JournalAttempt;
    journal.put(updated);
    results.push(updated);
  }
  const stillOpen = results.filter(unresolved);
  const reports = results.filter((a) => !a.approval && a.state === "SENT" && a.result_id !== undefined && a.hash !== undefined).map((a) => {
    const approval = all.find((b) => b.approval && b.result_id === a.result_id && b.state === "SENT" && b.hash !== undefined && b.command === "recta:move");
    return `mm recta report --result-id ${a.result_id} --origin-tx-hash ${a.hash}${approval === undefined ? "" : ` --approval-tx-hash ${approval.hash}`}`;
  });
  return {
    attempts: results.map(summary),
    blocked: stillOpen.length > 0,
    next: open.length === 0
      ? "No unresolved send from this wallet: Recta can send from it."
      : stillOpen.length > 0
        ? `Still not known: ${stillOpen.map((a) => a.id).join(", ")} (see each evidence). Recta sends nothing from this wallet until they are resolved; do not move these funds by any other route either. If MetaMask holds no open request for an attempt and its nonce is still unused, you may release it by sending any transaction of your own from this wallet (it takes that nonce) and passing its hash with --tx-hash.`
        : `Resolved.${reports.length === 0 ? "" : ` A transfer left: never send it again. Report it: ${reports.join("; ")}`} Recta can send from this wallet again.`,
  };
}

/** Runs one command: its flags in, the tool's JSON answer out (bigints as strings). Throws RectaToolError or RectaCheckError. */
export async function runCommand(spec: CommandSpec, ctx: MmContextLike, io: unknown, flags: Readonly<Record<string, unknown>>, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  const sent: MetaMaskSentTransaction[] = [];
  const held: { journal?: SendJournal } = {};
  let out: Record<string, unknown>;
  try {
    out = await runSpec(spec, ctx, io, flags, sent, held, fetchImpl);
  } catch (e) {
    if (!sends(spec, flags)) throw e;
    if (e instanceof RectaToolError && e.body["execution_state"] !== undefined) throw e;
    throw new RectaToolError(afterSend(spec, bodyOf(e), sent));
  } finally {
    held.journal?.unlock();
  }
  if (sends(spec, flags)) out = { ...out, execution_state: sent.some((t) => t.state === "SENT") ? "SENT" : "NOT_SENT" };
  return JSON.parse(JSON.stringify(out, (_, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;
}

/** The pending-job ids MetaMask holds now (`mm wallet requests list`); unreadable → none. */
function mmJobs(ctx: MmContextLike): readonly MmPendingJob[] {
  try {
    const jobs = ctx.walletStateManager?.read().pendingJobs;
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}

type MmPendingJob = NonNullable<MetaMaskWalletStateLike["pendingJobs"]>[number];

/** What the agent asked to move: the economic identity journaled with each attempt. */
function economicOf(spec: Pick<CommandSpec, "id">, flags: Readonly<Record<string, unknown>>): Record<string, string> {
  const keys = spec.id === "recta:move" ? ["source-network", "source-asset", "destination-network", "amount"] : ["amount-usdc"];
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof flags[k] === "string") out[k.replaceAll("-", "_")] = flags[k] as string;
  return out;
}

function journaled(a: MetaMaskSentTransaction, run: { readonly id: string; readonly started: string; readonly resultId?: string }, spec: Pick<CommandSpec, "id">, flags: Readonly<Record<string, unknown>>, jobsBefore: readonly string[], previous?: JournalAttempt): JournalAttempt {
  const now = new Date().toISOString();
  return {
    id: `${run.id}-${a.attempt}`,
    command: spec.id,
    created_at: previous?.created_at ?? now,
    updated_at: now,
    wallet: a.from.toLowerCase(),
    chain_id: a.chainId,
    to: a.to.toLowerCase(),
    data_keccak: keccak256(a.data),
    value: a.value.toString(),
    gas: a.gas.toString(),
    max_fee_per_gas: a.maxFeePerGas.toString(),
    max_priority_fee_per_gas: a.maxPriorityFeePerGas.toString(),
    nonce: a.nonce,
    approval: a.approval,
    ...(run.resultId === undefined ? {} : { result_id: run.resultId }),
    economic: economicOf(spec, flags),
    mm_jobs_before: previous?.mm_jobs_before ?? jobsBefore,
    state: a.state,
    ...(a.chainStatus === undefined ? {} : { chain_status: a.chainStatus }),
    ...(a.hash === undefined ? {} : { hash: a.hash }),
  };
}

/** The refusal while an earlier send of this wallet is unresolved (Fable P-2 on #19): this run sent nothing. */
function blockedBody(open: readonly JournalAttempt[]): Record<string, unknown> {
  return {
    error: "UNRESOLVED_SEND",
    execution_state: "UNKNOWN",
    transfer_sent: "UNKNOWN",
    this_run: "NOT_SENT",
    unresolved_attempts: open.map(summary),
    next: `An earlier send from this wallet has no known outcome (${open.map((a) => a.id).join(", ")}). This run sent nothing, and Recta sends nothing from this wallet until it is resolved: do not move these funds by any other route either. Run ${RECOVER}.`,
  };
}

const summary = (a: JournalAttempt) => ({
  attempt_id: a.id,
  command: a.command,
  ...(a.result_id === undefined ? {} : { result_id: a.result_id }),
  kind: a.approval ? "approval" : "transfer",
  chain_id: a.chain_id,
  to: a.to,
  nonce: a.nonce,
  state: a.state,
  ...(a.chain_status === undefined ? {} : { chain_status: a.chain_status }),
  ...(a.hash === undefined ? {} : { tx_hash: a.hash }),
  ...(a.mm_job === undefined ? {} : { mm_request: a.mm_job }),
  economic: a.economic,
  created_at: a.created_at,
  ...(a.evidence === undefined ? {} : { evidence: a.evidence }),
  blocked: unresolved(a),
});

async function runSpec(spec: CommandSpec, ctx: MmContextLike, io: unknown, flags: Readonly<Record<string, unknown>>, sent: MetaMaskSentTransaction[], held: { journal?: SendJournal }, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
  const s = (k: string): string | undefined => (typeof flags[k] === "string" && flags[k] !== "" ? (flags[k] as string) : undefined);
  // The same parsing and defaults as `npx @recta/mcp` (RECTA_MAX_FEE_USDC …), from flags only: never a key.
  const env: Record<string, string | undefined> = {
    RECTA_ADDRESS: s("address"),
    RECTA_MAX_FEE_USDC: s("max-fee-usdc"),
    RECTA_MAX_NATIVE_WEI: s("max-native-wei"),
    RECTA_MIN_OUTPUT_BPS: s("min-output-bps"),
    RECTA_MAX_FEE_GWEI: s("max-fee-gwei"),
    RECTA_MAX_PRIORITY_FEE_GWEI: s("max-priority-fee-gwei"),
    RECTA_REFERRER: s("referrer"),
  };
  let config: ReturnType<typeof configFromEnv>;
  try {
    config = configFromEnv(env);
  } catch (e) {
    throw new RectaCheckError("input", (e instanceof Error ? e.message : String(e)).replace(/RECTA_([A-Z_]+)/g, (_, k: string) => `--${k.toLowerCase().replaceAll("_", "-")}`));
  }
  let address: Hex | undefined = config.address;
  let selected: Hex | undefined;
  if (spec.wallet !== "none" && ctx.walletStateManager !== undefined) {
    try { selected = selectedMetaMaskAddress(ctx.walletStateManager.read()); } catch { selected = undefined; }
  }
  if (spec.wallet !== "none" && address === undefined) {
    if (selected === undefined) throw new RectaCheckError("wallet_address", "could not tell which MetaMask wallet is selected: pass --address with the EVM address of the wallet mm signs with");
    address = selected;
  }
  const signs = spec.wallet === "sign" || spec.wallet === "send";
  // Fable B-1 on #19: a signing command never runs for an address other than the wallet mm has selected.
  if (signs && selected !== undefined && address !== undefined && selected.toLowerCase() !== address.toLowerCase()) {
    throw new RectaCheckError("wallet_address", `--address ${address} is not the wallet selected in mm (${selected}): select it with mm, or drop --address`);
  }
  // Fable P-1/P-2 on #19: a sending run (and recover) holds the wallet's journal from here to the end.
  let journal: SendJournal | undefined;
  if ((sends(spec, flags) || spec.id === "recta:recover") && address !== undefined) {
    journal = new SendJournal(journalDir(ctx.journalDir), address);
    journal.lock();
    held.journal = journal;
    if (sends(spec, flags)) {
      const open = journal.read().filter(unresolved);
      if (open.length > 0) throw new RectaToolError(blockedBody(open));
    }
  }
  const run: { id: string; started: string; resultId?: string } = { id: randomUUID().slice(0, 8), started: new Date().toISOString() };
  const remember = (t: MetaMaskSentTransaction) => {
    const i = sent.findIndex((x) => x.attempt === t.attempt);
    if (i < 0) sent.push(t); else sent[i] = t;
  };
  const onSent = (t: MetaMaskSentTransaction) => {
    if (journal !== undefined) {
      const id = `${run.id}-${t.attempt}`;
      const previous = journal.read().find((a) => a.id === id);
      const jobsBefore = previous === undefined ? mmJobs(ctx).flatMap((j) => (typeof j.pollingId === "string" ? [j.pollingId] : [])) : [];
      if (previous === undefined) {
        // Before the send: throws (and nothing is sent) when the attempt cannot be written.
        journal.put(journaled(t, run, spec, flags, jobsBefore, previous));
        remember(t);
      } else {
        // An outcome: kept in this answer even if the journal cannot take it (the journal then still says UNKNOWN).
        remember(t);
        journal.put(journaled(t, run, spec, flags, jobsBefore, previous));
      }
      return;
    }
    remember(t);
  };
  const execute = signs ? await ctx.walletExecutor(io, spec.id) : undefined;
  // approve-fee is the one command that would send without signing first: one signature proves that the wallet
  // MetaMask signs with is this address before any approval is sent (owner 2026-11-11 21:16, Fable B-1).
  if (spec.id === "recta:approve-fee" && address !== undefined && execute !== undefined) {
    await metaMaskSigner({ address, execute, publicClientFor: (id) => ctx.publicClient(id) }).signMessage(`Recta: ${address} approves USDC to Permit2 for Recta's fees on Base.`);
  }
  const call = metaMaskRectaServer({
    keyless: spec.wallet === "none" || (spec.wallet === "read" && spec.id === "recta:trial"),
    ...(address === undefined ? {} : { address }),
    ...(execute === undefined ? {} : { execute }),
    onSent,
    publicClientFor: (id) => ctx.publicClient(id),
    limits: config,
    allowExecute: spec.wallet === "send",
    ...(config.referrer === undefined ? {} : { referrer: config.referrer }),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const args: Record<string, unknown> = {};
  for (const input of spec.inputs) if (input.arg !== undefined && present(flags[input.flag])) args[input.arg] = flags[input.flag];
  return spec.run(call, args, flags, { ctx, ...(address === undefined ? {} : { address }), ...(journal === undefined ? {} : { journal }), setResultId: (id) => { run.resultId = id; } });
}

/** The parts of `@metamask/agent-wallet/plugin` the commands use. */
export interface MmPluginSdk {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly PluginCommand: abstract new (...args: any[]) => object;
  readonly InputFieldType: { readonly Text: string; readonly Boolean: string };
  schemaToFlags(schema: Record<string, unknown>): unknown;
  readonly CommandError: new (code: string, message: string, hint: string) => Error;
}

const HINT = "Recta's guide for agents: https://api.recta.build/llms.txt";

/** The error `mm` shows: the MCP server's own JSON answer, with a code an agent can branch on. */
export function commandErrorOf(sdk: MmPluginSdk, e: unknown): Error {
  if (e instanceof RectaToolError) {
    const state = e.body["execution_state"];
    if (typeof state === "string") {
      const code = e.body["error"] === "UNRESOLVED_SEND" ? "RECTA_SEND_UNKNOWN" : { NOT_SENT: "RECTA_NOT_SENT", REVERTED: "RECTA_TRANSFER_REVERTED", UNKNOWN: "RECTA_SEND_UNKNOWN", SENT: "RECTA_TRANSFER_SENT", APPROVAL_ONLY: "RECTA_APPROVAL_SENT" }[state] ?? "RECTA_SEND_UNKNOWN";
      return new sdk.CommandError(code, e.message, String(e.body["next"]));
    }
    const kind = typeof e.body["error"] === "string" ? (e.body["error"] as string) : "FAILED";
    const hint = kind === "DEBT" ? "Pay it with: mm recta pay-debt --debt-offer '<the debt_offer JSON above>'" : HINT;
    return new sdk.CommandError(`RECTA_${kind.replace(/[^A-Z_]/g, "")}`, e.message, hint);
  }
  if (e instanceof RectaCheckError) return new sdk.CommandError("RECTA_CHECK_FAILED", JSON.stringify(bodyOf(e)), HINT);
  return e instanceof Error ? e : new Error(String(e));
}

/** The oclif command class for one spec, on `mm`'s own PluginCommand. */
export function rectaCommand(sdk: MmPluginSdk, id: string) {
  const spec = COMMAND_SPECS.find((c) => c.id === id);
  if (spec === undefined) throw new Error(`no Recta command ${id}`);
  const schema: Record<string, unknown> = {};
  for (const input of spec.inputs) {
    schema[input.flag] = input.kind === "boolean"
      ? { type: sdk.InputFieldType.Boolean, flag: input.flag, message: input.message, required: false, prompt: false, default: false }
      : { type: sdk.InputFieldType.Text, flag: input.flag, message: input.message, required: input.required === true, prompt: false };
  }
  const needsWallet = spec.capabilities.length > 0;
  const Base = sdk.PluginCommand;
  class RectaCommand extends Base {
    static requiresAuth = needsWallet;
    static requiresInit = needsWallet;
    static description = spec!.description;
    static flags = sdk.schemaToFlags(schema);
    protected readonly pluginCommandId = spec!.id;
    async execute(io: { resolveInputs(schema: Record<string, unknown>): Promise<Record<string, unknown>> }) {
      try {
        const flags = await io.resolveInputs(schema);
        return await runCommand(spec!, (this as unknown as { ctx: MmContextLike }).ctx, io, flags);
      } catch (e) {
        throw commandErrorOf(sdk, e);
      }
    }
  }
  return RectaCommand as unknown as new (...args: unknown[]) => object;
}
