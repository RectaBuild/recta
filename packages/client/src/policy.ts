import { FEE_CHAIN_ID, FEE_RECEIVER, PERMIT2, UPTO_PROXY, USDC_BASE, WALLET_POLICY_SCHEMA } from "./constants.js";
import { RectaCheckError } from "./errors.js";

export interface WalletPolicyNetwork {
  readonly network: string;
  readonly chain_id: number;
  readonly approvals: readonly { readonly asset: string; readonly token: string; readonly spenders: readonly string[] }[];
  readonly call_targets: readonly { readonly address: string }[];
}

export interface WalletPolicy {
  readonly networks: readonly WalletPolicyNetwork[];
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads Recta's wallet policy (`/v1/golden-corridor/wallet-policy`) into the shape the artifact checks use, and refuses
 * it unless its fee block names exactly this package's pinned network, Permit2, spender, token and recipient. A policy
 * that disagrees with the pins means the server is not the Recta this release was built for: nothing is signed.
 */
export function parseWalletPolicy(body: unknown): WalletPolicy {
  const fail = (message: string): never => { throw new RectaCheckError("wallet_policy", message); };
  const p = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : fail("not an object");
  if (p["schema"] !== WALLET_POLICY_SCHEMA) fail(`schema ${String(p["schema"])}, not ${WALLET_POLICY_SCHEMA}`);
  const fee = typeof p["recta_fee"] === "object" && p["recta_fee"] !== null ? (p["recta_fee"] as Record<string, unknown>) : fail("no recta_fee");
  const pinned: [string, unknown, string | number][] = [
    ["chain_id", fee["chain_id"], FEE_CHAIN_ID],
    ["permit2", lower(fee["permit2"]), PERMIT2],
    ["spender", lower(fee["spender"]), UPTO_PROXY],
    ["token", lower(fee["token"]), USDC_BASE],
    ["recipient", lower(fee["recipient"]), FEE_RECEIVER],
  ];
  for (const [field, served, pin] of pinned) if (served !== pin) fail(`recta_fee.${field} is ${String(served)}, not the pinned ${pin}`);

  const networks = Array.isArray(p["networks"]) ? (p["networks"] as unknown[]) : fail("networks is not a list");
  return {
    networks: networks.map((raw, i): WalletPolicyNetwork => {
      const n = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : fail(`networks[${i}] is not an object`);
      if (typeof n["network"] !== "string" || !Number.isSafeInteger(n["chain_id"])) fail(`networks[${i}] has no network or chain_id`);
      const approvals = Array.isArray(n["approvals"]) ? (n["approvals"] as Record<string, unknown>[]) : fail(`networks[${i}].approvals is not a list`);
      const targets = Array.isArray(n["call_targets"]) ? (n["call_targets"] as Record<string, unknown>[]) : fail(`networks[${i}].call_targets is not a list`);
      return {
        network: n["network"] as string,
        chain_id: n["chain_id"] as number,
        approvals: approvals.map((a) => ({
          asset: typeof a["asset"] === "string" ? a["asset"] : fail(`networks[${i}]: an approval has no asset`),
          token: address(a["token"], fail),
          spenders: Array.isArray(a["spenders"]) ? (a["spenders"] as unknown[]).map((s) => address(s, fail)) : fail(`networks[${i}]: an approval has no spenders`),
        })),
        call_targets: targets.map((t) => ({ address: address(t["address"], fail) })),
      };
    }),
  };
}

const lower = (v: unknown): unknown => (typeof v === "string" ? v.toLowerCase() : v);
const address = (v: unknown, fail: (m: string) => never): string => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : fail(`${String(v)} is not an address`));
