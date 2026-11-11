/** A local check refused to sign or send: nothing was signed or sent. `check` names the check. */
export class RectaCheckError extends Error {
  override readonly name: string = "RectaCheckError";
  constructor(readonly check: string, message: string) {
    super(`${check}: ${message}`);
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
    const message = typeof record["message"] === "string" ? record["message"].slice(0, 500) : undefined;
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
