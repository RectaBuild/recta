import type { Hex } from "viem";
import { FEE_CHAIN_ID, FEE_FACILITATOR, FEE_PERMIT_TYPES, FEE_RECEIVER, PERMIT2, PERMIT_DEADLINE_AFTER_EXPIRY_SECONDS, UPTO_PROXY, USDC_BASE } from "./constants.js";
import { RectaCheckError } from "./errors.js";
import type { RectaTypedData } from "./signer.js";

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const obj = (v: unknown, check: string, what: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new RectaCheckError(check, `${what} is not an object`);
  return v as Record<string, unknown>;
};
const uint = (v: unknown, check: string, what: string): bigint => {
  if (typeof v !== "string" || !UINT.test(v)) throw new RectaCheckError(check, `${what} is not a canonical unsigned integer`);
  const n = BigInt(v);
  if (n >= 2n ** 256n) throw new RectaCheckError(check, `${what} exceeds uint256`);
  return n;
};
const address = (v: unknown, check: string, what: string): string => {
  if (typeof v !== "string" || !ADDRESS.test(v)) throw new RectaCheckError(check, `${what} is not an address`);
  return v.toLowerCase();
};
const expect = (actual: string, pinned: string, check: string, what: string): void => {
  if (actual !== pinned) throw new RectaCheckError(check, `${what} is ${actual}, not ${pinned}`);
};

export interface FeePermitLimits {
  /** The payer: the account that signs. */
  readonly payer: string;
  /** The most this agent agrees to authorize in one permit, in USDC atomic units (6 decimals). Required: a permit's
   *  amount also covers earlier fees not yet collected, which Recta's server, not the chain, bounds. */
  readonly maxPermitUsdcAtomic: bigint;
  readonly nowUnix: bigint;
  /** The decision's commercial expiry when the caller knows it from elsewhere (the artifact): must agree. */
  readonly commercialExpiryUnix?: bigint;
}

/**
 * Checks a fee permit Recta offers (`fee_authorization` of an execution artifact, or a debt's `debt_offer`) against
 * the pinned values and the agent's own limit, and returns the typed data to sign, rebuilt from the checked fields
 * only (never the server's object as it came).
 *
 * Refuses unless: the domain is Permit2 on Base; the types are exactly Recta's; the spender is x402's `upto` proxy; the
 * token is USDC on Base; `witness.to` is Recta's receiver; `witness.facilitator` is Recta's sender; the amount is the
 * offer's cap plus what it carries (for a decision) and at most `maxPermitUsdcAtomic`; and the deadline is in the
 * future and no later than the commercial expiry plus 37 days (for a decision).
 */
export function checkFeePermit(offer: unknown, limits: FeePermitLimits, kind: "DECISION" | "DEBT" = "DECISION"): { readonly typedData: RectaTypedData; readonly amount: bigint; readonly deadline: bigint } {
  const o = obj(offer, "fee_offer", "the fee offer");
  const td = obj(o["typed_data"], "fee_typed_data", "typed_data");
  const domain = obj(td["domain"], "fee_domain", "typed_data.domain");
  if (domain["name"] !== "Permit2") throw new RectaCheckError("fee_domain", "the domain is not Permit2's");
  if (domain["chainId"] !== FEE_CHAIN_ID && domain["chainId"] !== String(FEE_CHAIN_ID)) throw new RectaCheckError("fee_domain", `the chain is ${String(domain["chainId"])}, not Base (${FEE_CHAIN_ID})`);
  expect(address(domain["verifyingContract"], "fee_domain", "verifyingContract"), PERMIT2, "fee_domain", "the verifying contract");
  if (td["primaryType"] !== "PermitWitnessTransferFrom" || JSON.stringify(td["types"]) !== JSON.stringify(FEE_PERMIT_TYPES)) throw new RectaCheckError("fee_types", "the typed data is not exactly Recta's PermitWitnessTransferFrom");

  const m = obj(td["message"], "fee_message", "typed_data.message");
  const permitted = obj(m["permitted"], "fee_message", "message.permitted");
  const witness = obj(m["witness"], "fee_message", "message.witness");
  expect(address(m["spender"], "fee_spender", "spender"), UPTO_PROXY, "fee_spender", "the spender");
  expect(address(permitted["token"], "fee_token", "token"), USDC_BASE, "fee_token", "the token");
  expect(address(witness["to"], "fee_recipient", "witness.to"), FEE_RECEIVER, "fee_recipient", "the fee recipient");
  expect(address(witness["facilitator"], "fee_facilitator", "witness.facilitator"), FEE_FACILITATOR, "fee_facilitator", "the facilitator");
  const amount = uint(permitted["amount"], "fee_amount", "the amount");
  const nonce = uint(m["nonce"], "fee_message", "the nonce");
  const deadline = uint(m["deadline"], "fee_deadline", "the deadline");
  const validAfter = uint(witness["validAfter"], "fee_message", "validAfter");

  const permit = o["permit"] === undefined ? undefined : obj(o["permit"], "fee_offer", "permit");
  if (permit?.["payer"] !== undefined && address(permit["payer"], "fee_payer", "permit.payer") !== limits.payer.toLowerCase()) throw new RectaCheckError("fee_payer", "the permit is offered to another payer");

  if (kind === "DECISION") {
    const cap = uint(o["max_fee_authorization_usdc_atomic"], "fee_amount", "max_fee_authorization_usdc_atomic");
    const carried = uint(o["carried_usdc_atomic"], "fee_amount", "carried_usdc_atomic");
    if (amount !== cap + carried) throw new RectaCheckError("fee_amount", `the permit amount ${amount} is not the cap ${cap} plus carried ${carried}`);
    const expiry = uint(o["commercial_expiry_unix"], "fee_deadline", "commercial_expiry_unix");
    if (limits.commercialExpiryUnix !== undefined && expiry !== limits.commercialExpiryUnix) throw new RectaCheckError("fee_deadline", "the offer's commercial expiry is not the artifact's");
    if (deadline > expiry + PERMIT_DEADLINE_AFTER_EXPIRY_SECONDS) throw new RectaCheckError("fee_deadline", "the deadline is later than the commercial expiry plus 37 days");
  } else {
    const owed = uint(o["amount_usdc_atomic"], "fee_amount", "amount_usdc_atomic");
    if (amount !== owed) throw new RectaCheckError("fee_amount", `the permit amount ${amount} is not the debt ${owed}`);
  }
  if (amount > limits.maxPermitUsdcAtomic) throw new RectaCheckError("fee_amount_limit", `the permit amount ${amount} exceeds your limit ${limits.maxPermitUsdcAtomic}`);
  if (deadline <= limits.nowUnix) throw new RectaCheckError("fee_deadline", "the deadline has passed");

  return {
    amount,
    deadline,
    typedData: {
      domain: { name: "Permit2", chainId: FEE_CHAIN_ID, verifyingContract: PERMIT2 as Hex },
      types: FEE_PERMIT_TYPES,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: USDC_BASE, amount },
        spender: UPTO_PROXY,
        nonce,
        deadline,
        witness: { to: FEE_RECEIVER, facilitator: FEE_FACILITATOR, validAfter },
      },
    },
  };
}
