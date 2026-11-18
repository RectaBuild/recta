/**
 * A local check refused, or a transaction did not end as expected. `check` names it. Read it before acting:
 * - `transaction_unknown` (a RectaSendUnknownError): a transaction may have been sent. Look `sentTxHashes` (or, with
 *   none, the account's latest transactions) up on chain before sending anything again, by Recta or any other route.
 * - `transaction_failed`: the named transaction was mined and reverted.
 * - a wallet's own checks (`wallet_*`, from the MetaMask signer) say in their message what was sent.
 * - every other check: nothing was signed or sent.
 */
export class RectaCheckError extends Error {
  override readonly name: string = "RectaCheckError";
  constructor(readonly check: string, message: string) {
    super(`${check}: ${message}`);
  }
}

/** A send whose outcome is not known (owner rule 2026-11-11: UNKNOWN, never FAILED): what was already sent, as data. */
export class RectaSendUnknownError extends RectaCheckError {
  override readonly name: string = "RectaSendUnknownError";
  constructor(
    message: string,
    /** The evaluation this send belongs to, when it belongs to one. */
    readonly resultId: string | undefined,
    /** Every transaction hash already sent, in order; empty when none came back. */
    readonly sentTxHashes: readonly { readonly role: string; readonly chainId: number; readonly hash: `0x${string}` }[],
  ) {
    super("transaction_unknown", message);
  }
}

/** Recta answered with an error. `body` is Recta's JSON answer when it sent one. */
export class RectaHttpError extends Error {
  override readonly name: string = "RectaHttpError";
  readonly reasonCode: string | undefined;
  constructor(readonly status: number, readonly body: unknown) {
    const reason = typeof body === "object" && body !== null && typeof (body as Record<string, unknown>)["reason_code"] === "string" ? (body as Record<string, string>)["reason_code"] : undefined;
    // The reason, Recta's own message and whether a retry may succeed, so an agent reading only the error knows why
    // it failed and what to do (before 0.1.7 it read only "Recta answered HTTP 503 (CAPTURE_FAILED_CLOSED)").
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const message = typeof record["message"] === "string" ? record["message"].replace(/\s+/g, " ").slice(0, 500) : undefined;
    const retryable = typeof record["retryable"] === "boolean" ? (record["retryable"] ? " (retryable)" : " (not retryable)") : "";
    super(`Recta answered HTTP ${status}${reason === undefined ? "" : ` ${reason}`}${message === undefined ? "" : `: ${message}`}${retryable}`);
    this.reasonCode = reason;
  }
}

/** A new evaluation was refused because the sender owes a fee: `offer` is the debt permit Recta offers (or null while
 *  a pull is pending). Pay it with `payDebt(offer)` only if you agree; this package never signs a debt by itself. */
export class RectaDebtError extends RectaHttpError {
  override readonly name: string = "RectaDebtError";
  constructor(body: unknown, readonly offer: unknown) {
    super(402, body);
  }
}
