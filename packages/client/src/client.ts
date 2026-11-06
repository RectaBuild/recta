import { keccak256, type Hex } from "viem";
import { checkExecutionArtifact, type CheckedArtifact, type EvaluationRequestView } from "./artifact.js";
import { ISSUED_AT_HEADER, PATHS, RECTA_ORIGIN, SIGNATURE_HEADER, SIGNED_REQUEST_PREFIX, SIGNER_HEADER } from "./constants.js";
import { RectaCheckError, RectaDebtError, RectaHttpError } from "./errors.js";
import { checkFeePermit } from "./fee.js";
import { parseWalletPolicy } from "./policy.js";
import type { RectaChainReader, RectaSigner, RectaTypedData } from "./signer.js";

export interface RectaClientOptions {
  readonly signer: RectaSigner;
  readonly chain: RectaChainReader;
  readonly limits: {
    /** The most one fee permit may authorize, in USDC atomic units (6 decimals): e.g. 5_000_000n for 5 USDC. */
    readonly maxPermitUsdcAtomic: bigint;
    /** The most native value (wei) one route transaction may attach (LayerZero messaging fees). */
    readonly maxNativeValueWei: bigint;
    /** The least the recipient must be guaranteed, in basis points of the amount sent (e.g. 9950 = 99.5 %). */
    readonly minOutputBps: number;
  };
  /** Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Milliseconds since the epoch; defaults to Date.now. */
  readonly now?: () => number;
}

/** The text a sender signs for one request (EIP-191), exactly as Recta's server rebuilds it. */
export function signedRequestMessage(f: { readonly method: string; readonly path: string; readonly idempotencyKey: string; readonly bodyKeccak256: string; readonly issuedAt: number }): string {
  return [
    SIGNED_REQUEST_PREFIX,
    `method: ${f.method.toUpperCase()}`,
    `path: ${f.path}`,
    `idempotency-key: ${f.idempotencyKey}`,
    `body-keccak256: ${f.bodyKeccak256.toLowerCase()}`,
    `issued-at: ${f.issuedAt}`,
  ].join("\n");
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const RESULT_ID = /^[A-Za-z0-9_-]+$/;
const field = (v: unknown, k: string): unknown => (typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined);
const resultIdOf = (v: string): string => {
  if (!RESULT_ID.test(v)) throw new RectaCheckError("result_id", "not a Recta result id");
  return v;
};

export type FeeOutcome =
  | { readonly kind: "NOT_REQUIRED" }
  | { readonly kind: "ALREADY_AUTHORIZED" }
  | { readonly kind: "AUTHORIZED"; readonly amountUsdcAtomic: bigint; readonly signature: Hex }
  | { readonly kind: "DRY_RUN"; readonly amountUsdcAtomic: bigint; readonly typedData: RectaTypedData };

/**
 * Recta's flow for an agent that holds its own EOA: evaluate → authorizeFee → execute → report. Every step can be
 * called alone. Nothing is signed or sent before this package's own checks pass (see `checkFeePermit` and
 * `checkExecutionArtifact`); they cannot be turned off.
 */
export function createRectaClient(options: RectaClientOptions) {
  const { signer, chain, limits } = options;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const nowUnix = (): bigint => BigInt(Math.floor(now() / 1000));
  const payer = signer.address.toLowerCase();
  let policyChecked = false;

  async function call(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string, signed = true): Promise<Answer> {
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    if (signed) {
      const issuedAt = Math.floor(now() / 1000);
      const message = signedRequestMessage({ method, path, idempotencyKey: idempotencyKey ?? "", bodyKeccak256: keccak256(bytes), issuedAt });
      headers[SIGNER_HEADER] = signer.address;
      headers[ISSUED_AT_HEADER] = String(issuedAt);
      headers[SIGNATURE_HEADER] = await signer.signMessage(message);
    }
    const response = await doFetch(`${RECTA_ORIGIN}${path}`, { method, headers, ...(body === undefined ? {} : { body: bytes }) });
    const text = await response.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON: keep the text */ }
    return { status: response.status, body: parsed };
  }

  /** Reads Recta's live wallet policy once and refuses to go on unless its fee block names this package's pins. */
  async function walletPolicy(): Promise<void> {
    if (policyChecked) return;
    const a = await call("GET", PATHS.walletPolicy, undefined, undefined, false);
    if (a.status !== 200) throw new RectaHttpError(a.status, a.body);
    parseWalletPolicy(a.body);
    policyChecked = true;
  }

  /** Step 1: a durable decision (free). Throws RectaDebtError when the sender owes a fee first. */
  async function evaluate(request: EvaluationRequestView & Record<string, unknown>, opts: { readonly idempotencyKey?: string } = {}): Promise<Record<string, unknown>> {
    if (typeof request.sender !== "string" || request.sender.toLowerCase() !== payer) throw new RectaCheckError("sender", "the request's sender must be the signer");
    await walletPolicy();
    const a = await call("POST", PATHS.evaluations, request, opts.idempotencyKey ?? crypto.randomUUID());
    if (a.status === 402) throw new RectaDebtError(a.body, field(a.body, "debt_offer") ?? null);
    if (a.status !== 200) throw new RectaHttpError(a.status, a.body);
    return a.body as Record<string, unknown>;
  }

  /**
   * Step 2: the decision's committed transactions. With Recta's collection on, the artifact first asks for the fee
   * permit: it is checked, rebuilt and signed only if it passes, then stored, and the answer carries the artifact. With
   * `dryRun`, it stops before signing and returns the typed data it would sign.
   */
  async function authorizeFee(resultId: string, opts: { readonly dryRun?: boolean } = {}): Promise<{ readonly fee: FeeOutcome; readonly artifact: unknown }> {
    const id = resultIdOf(resultId);
    const artifactPath = `${PATHS.evaluations}/${id}/execution-artifact`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const a = await call("GET", artifactPath);
      if (a.status === 200) {
        const authorized = field(field(a.body, "fee_authorization"), "status") === "AUTHORIZED";
        return { fee: { kind: authorized ? "ALREADY_AUTHORIZED" : "NOT_REQUIRED" }, artifact: field(a.body, "artifact") };
      }
      if (a.status !== 402 || field(a.body, "status") !== "SIGNATURE_REQUIRED") throw new RectaHttpError(a.status, a.body);
      const expiry = field(a.body, "commercial_expiry_unix");
      const checked = checkFeePermit(field(a.body, "fee_authorization"), {
        payer,
        maxPermitUsdcAtomic: limits.maxPermitUsdcAtomic,
        nowUnix: nowUnix(),
        ...(typeof expiry === "string" && /^[0-9]+$/.test(expiry) ? { commercialExpiryUnix: BigInt(expiry) } : {}),
      });
      if (opts.dryRun === true) return { fee: { kind: "DRY_RUN", amountUsdcAtomic: checked.amount, typedData: checked.typedData }, artifact: undefined };
      const signature = await signer.signTypedData(checked.typedData);
      const s = await call("POST", `${PATHS.evaluations}/${id}/fee-authorization`, { signature, amount_usdc_atomic: checked.amount.toString() });
      if (s.status === 200 || s.status === 201) return { fee: { kind: "AUTHORIZED", amountUsdcAtomic: checked.amount, signature }, artifact: field(s.body, "artifact") };
      if (!(s.status === 409 && field(s.body, "reason_code") === "OFFER_STALE")) throw new RectaHttpError(s.status, s.body);
    }
    throw new RectaHttpError(409, { reason_code: "OFFER_STALE" });
  }

  /** Checks the artifact against the request and the package's pinned routes; nothing is sent. */
  async function check(resultId: string, artifact: unknown, request: EvaluationRequestView): Promise<CheckedArtifact> {
    await walletPolicy();
    return checkExecutionArtifact(artifact, { resultId: resultIdOf(resultId), request, limits: { signer: payer, nowUnix: nowUnix(), maxNativeValueWei: limits.maxNativeValueWei, minOutputBps: limits.minOutputBps } });
  }

  /** Step 3: checks, then sends the transactions in order, each mined successfully before the next. */
  async function execute(resultId: string, artifact: unknown, request: EvaluationRequestView): Promise<{ readonly approvalTxHash?: Hex; readonly originTxHash: Hex }> {
    const checked = await check(resultId, artifact, request);
    let approvalTxHash: Hex | undefined;
    for (const tx of checked.transactions) {
      const { role, ...send } = tx;
      const hash = await signer.sendTransaction(send);
      if (!(await chain.waitForSuccess(tx.chainId, hash))) throw new RectaCheckError("transaction_failed", `${role} transaction ${hash} reverted`);
      if (role === "APPROVAL") approvalTxHash = hash;
      else return { ...(approvalTxHash === undefined ? {} : { approvalTxHash }), originTxHash: hash };
    }
    throw new RectaCheckError("transaction_order", "the artifact has no execution");
  }

  /**
   * Step 4: reports the executed route; Recta verifies the delivery on chain and records the saving and its 5 %.
   * `stage`: ACCRUED (verified and recorded), PENDING (not yet verifiable: report again later) or REFUSED (Recta will
   * not accrue this execution; see `body.reason_code`).
   */
  async function report(resultId: string, originTxHash: Hex, approvalTxHash?: Hex): Promise<{ readonly stage: "ACCRUED" | "PENDING" | "REFUSED"; readonly body: Record<string, unknown> }> {
    const a = await call("POST", `${PATHS.evaluations}/${resultIdOf(resultId)}/execution`, { origin_tx_hash: originTxHash, ...(approvalTxHash === undefined ? {} : { approval_tx_hash: approvalTxHash }) });
    const body = a.body as Record<string, unknown>;
    if (a.status === 200 || a.status === 201) return { stage: "ACCRUED", body };
    if (a.status === 202) return { stage: "PENDING", body };
    if (a.status === 422) return { stage: "REFUSED", body };
    throw new RectaHttpError(a.status, a.body);
  }

  /** The signer's fees and whether each was collected. */
  async function ledger(): Promise<Record<string, unknown>> {
    const a = await call("GET", `${PATHS.accruals}${payer}`);
    if (a.status !== 200) throw new RectaHttpError(a.status, a.body);
    return a.body as Record<string, unknown>;
  }

  /** Signs and submits a debt permit Recta offered (RectaDebtError.offer), after the same checks as a fee permit. */
  async function payDebt(offer: unknown): Promise<Record<string, unknown>> {
    const checked = checkFeePermit(offer, { payer, maxPermitUsdcAtomic: limits.maxPermitUsdcAtomic, nowUnix: nowUnix() }, "DEBT");
    const debtId = field(offer, "debt_id");
    if (typeof debtId !== "string") throw new RectaCheckError("debt", "the offer has no debt_id");
    const signature = await signer.signTypedData(checked.typedData);
    const a = await call("POST", PATHS.feeDebts, { debt_id: debtId, deadline_unix: checked.deadline.toString(), signature });
    if (a.status !== 200 && a.status !== 201) throw new RectaHttpError(a.status, a.body);
    return a.body as Record<string, unknown>;
  }

  /**
   * The four steps in a row. With `dryRun`, it evaluates and checks but signs no permit and sends no transaction: it
   * stops at the permit (collection on) or after checking the artifact (collection off).
   */
  async function run(request: EvaluationRequestView & Record<string, unknown>, opts: { readonly dryRun?: boolean; readonly idempotencyKey?: string } = {}) {
    const decision = await evaluate(request, opts.idempotencyKey === undefined ? {} : { idempotencyKey: opts.idempotencyKey });
    const resultId = field(decision, "result_id");
    if (field(field(decision, "decision"), "state") !== "VERIFIED_POSITIVE" || typeof resultId !== "string") return { stage: "NO_ROUTE" as const, decision };
    const { fee, artifact } = await authorizeFee(resultId, opts.dryRun === true ? { dryRun: true } : {});
    if (fee.kind === "DRY_RUN") return { stage: "DRY_RUN" as const, decision, fee };
    if (opts.dryRun === true) return { stage: "DRY_RUN" as const, decision, fee, checked: await check(resultId, artifact, request) };
    const sent = await execute(resultId, artifact, request);
    return { stage: "REPORTED" as const, decision, fee, ...sent, report: await report(resultId, sent.originTxHash, sent.approvalTxHash) };
  }

  return { evaluate, authorizeFee, check, execute, report, ledger, payDebt, run, walletPolicy };
}

export type RectaClient = ReturnType<typeof createRectaClient>;
