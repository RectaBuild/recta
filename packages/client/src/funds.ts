import { encodeFunctionData, type Hex } from "viem";
import { FEE_CHAIN_ID, PERMIT2, USDC_BASE } from "./constants.js";
import { RectaCheckError } from "./errors.js";

/**
 * Whether a fee permit can actually be collected (ASTRA T2). Signing a Permit2 permit is not enough: when Recta settles
 * it, Permit2 pulls the fee with USDC's own `transferFrom`, which needs (1) the payer's USDC balance on Base and (2) the
 * payer's ERC-20 allowance from USDC to Permit2. A permit signed without them lets the route execute and then the fee
 * fail, which leaves a debt that blocks the next evaluation. This package therefore reads both before it signs a fee or
 * debt permit and refuses when either is short. It never approves anything by itself.
 */

/** What the payer holds on Base, read at signing time (both in USDC atomic units, 6 decimals). */
export interface FeeFunds {
  readonly balanceUsdcAtomic: bigint;
  readonly permit2AllowanceUsdcAtomic: bigint;
}

export interface FeeReadiness {
  readonly ready: boolean;
  /** The permit's amount: the most this fee can pull. */
  readonly requiredUsdcAtomic: bigint;
  /** USDC on Base the route itself will spend before the fee is pulled (a route that starts from Base USDC); the
   *  balance must cover it plus the fee (Fable B-1 on recta #12). */
  readonly reservedForRouteUsdcAtomic: bigint;
  readonly balanceUsdcAtomic: bigint;
  readonly permit2AllowanceUsdcAtomic: bigint;
  /** What is short, if anything: `balance` (hold more USDC on Base), `allowance` (approve Permit2 for at least the amount). */
  readonly missing: readonly ("balance" | "allowance")[];
}

export const ERC20_READ_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
const APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

/**
 * The fee's amount against the payer's funds. `reservedForRouteUsdcAtomic`: USDC on Base the route will spend first
 * (see `routeReserveOf`); the balance must cover it plus the fee. The allowance only needs to cover the fee: a route's
 * own approval goes to the bridge, not to Permit2.
 */
export function feeReadiness(funds: FeeFunds, requiredUsdcAtomic: bigint, reservedForRouteUsdcAtomic = 0n): FeeReadiness {
  const missing: ("balance" | "allowance")[] = [];
  if (funds.balanceUsdcAtomic < requiredUsdcAtomic + reservedForRouteUsdcAtomic) missing.push("balance");
  if (funds.permit2AllowanceUsdcAtomic < requiredUsdcAtomic) missing.push("allowance");
  return { ready: missing.length === 0, requiredUsdcAtomic, reservedForRouteUsdcAtomic, balanceUsdcAtomic: funds.balanceUsdcAtomic, permit2AllowanceUsdcAtomic: funds.permit2AllowanceUsdcAtomic, missing };
}

const DECIMAL_USDC = /^(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$/;

/**
 * USDC on Base that a route spends before Recta pulls its fee: the request's amount when the route starts from USDC on
 * Base (the same balance pays both), otherwise 0. Throws when such an amount is not a plain decimal: fail closed.
 */
export function routeReserveOf(request: { readonly source_network: string; readonly source_asset: string; readonly amount: string }): bigint {
  if (request.source_network !== "base" || request.source_asset.toUpperCase() !== "USDC") return 0n;
  if (!DECIMAL_USDC.test(request.amount)) throw new RectaCheckError("amount", "the request's amount is not a decimal USDC amount");
  const [whole, frac = ""] = request.amount.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** A read error's text without what an RPC URL may carry (an API key in the path or query): viem's short message,
 *  and any URL replaced (Fable M-2 on recta #12). */
export function safeErrorText(e: unknown): string {
  const short = typeof e === "object" && e !== null && typeof (e as { shortMessage?: unknown }).shortMessage === "string" ? (e as { shortMessage: string }).shortMessage : e instanceof Error ? e.message : String(e);
  return short.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>").split("\n")[0]!.slice(0, 300);
}

const usdc = (atomic: bigint): string => {
  const whole = atomic / 1_000_000n;
  const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
};

/** Throws a RectaCheckError naming what is short and how to fix it; nothing has been signed when it throws. */
export function assertFeeReady(r: FeeReadiness): void {
  if (r.ready) return;
  const parts: string[] = [];
  if (r.missing.includes("balance")) parts.push(`hold at least ${usdc(r.requiredUsdcAtomic + r.reservedForRouteUsdcAtomic)} USDC on Base (now ${usdc(r.balanceUsdcAtomic)}${r.reservedForRouteUsdcAtomic > 0n ? `; ${usdc(r.reservedForRouteUsdcAtomic)} of it is the transfer itself, which leaves Base first` : ""})`);
  if (r.missing.includes("allowance")) parts.push(`approve Permit2 (${PERMIT2}) to spend at least ${usdc(r.requiredUsdcAtomic)} USDC on Base (now ${usdc(r.permit2AllowanceUsdcAtomic)}); permit2ApprovalTransaction(amount) builds that exact, bounded approval for you to send`);
  throw new RectaCheckError(r.missing.includes("allowance") ? "fee_allowance" : "fee_balance", `Recta could not collect this fee: ${parts.join("; ")}. Nothing was signed.`);
}

/** The one transaction that lets Permit2 pull up to `amountUsdcAtomic` of USDC on Base: `USDC.approve(Permit2, amount)`. */
export interface Permit2Approval {
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
  readonly value: bigint;
  readonly amountUsdcAtomic: bigint;
}

/**
 * Builds the exact approval for the agent's operator to send with their own wallet. Bounded on purpose: it refuses 0
 * and anything of 2^128 or more, so an "unlimited" approval (2^256 − 1, 2^160 − 1) cannot be built here. Approving
 * replaces, not adds to, the current allowance; each collected fee lowers it, so approve again when a check reports
 * `allowance` short.
 */
export function permit2ApprovalTransaction(amountUsdcAtomic: bigint): Permit2Approval {
  if (amountUsdcAtomic <= 0n) throw new RectaCheckError("fee_approval", "the approval must be more than 0");
  if (amountUsdcAtomic >= 2n ** 128n) throw new RectaCheckError("fee_approval", "refusing an unlimited approval: approve a bounded amount");
  return {
    chainId: FEE_CHAIN_ID,
    to: USDC_BASE as Hex,
    data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [PERMIT2 as Hex, amountUsdcAtomic] }),
    value: 0n,
    amountUsdcAtomic,
  };
}
