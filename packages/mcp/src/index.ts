import { createInterface } from "node:readline";
import { createPublicClient, createWalletClient, http, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";
import { PINNED_ROUTES, RectaCheckError, viemChainReader, viemSigner, type RectaSigner } from "@recta/client";
import { createLocalServer } from "./server.js";

export { createLocalServer, TOOLS, MCP_PROTOCOL_VERSIONS, SERVER_INFO, type LocalServerOptions } from "./server.js";

/** Recta's network key → EVM chain id, from the client's pinned routes (`<network>:<asset>>…`). */
export function networkChainIds(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, route] of Object.entries(PINNED_ROUTES)) out.set(key.slice(0, key.indexOf(":")), route.source_chain_id);
  return out;
}

export interface EnvConfig {
  /** Absent: the server runs without a key and offers only recta_fit and recta_trial_evaluation (ASTRA T5). */
  readonly privateKey?: Hex;
  /** RECTA_ADDRESS: a public address the keyless trial uses as sender (never a key). */
  readonly address?: Hex;
  readonly rpcUrls: Readonly<Record<number, string>>;
  readonly maxPermitUsdcAtomic: bigint;
  readonly maxNativeValueWei: bigint;
  readonly minOutputBps: number;
  readonly allowExecute: boolean;
  /** Operator ceilings on the source gas price an evaluation may commit to, whatever the RPC estimates (Fable #260 B-1). */
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
  /** RECTA_REFERRER: who referred this agent (OD-REF-1), usually the author of the template or setup that runs it. */
  readonly referrer?: string;
}

const GWEI = /^\d+(\.\d{1,9})?$/;
function gweiToWei(value: string, name: string): bigint {
  if (!GWEI.test(value)) throw new Error(`${name} must be a decimal number of gwei, e.g. 50 or 0.5`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}

/** An https RPC URL, or http only on this machine (a local node). Anything else is refused, never silently replaced. */
const RPC_URL = /^(https:\/\/[^\s]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\s]*)?)$/;

/** The source gas caps an evaluation commits to: twice the estimate, never above the operator's ceilings. */
export function cappedGas(estimate: { readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }, config: Pick<EnvConfig, "maxFeePerGasWei" | "maxPriorityFeePerGasWei">): readonly [bigint, bigint] {
  const fee = estimate.maxFeePerGas * 2n < config.maxFeePerGasWei ? estimate.maxFeePerGas * 2n : config.maxFeePerGasWei;
  const tipCeiling = config.maxPriorityFeePerGasWei < fee ? config.maxPriorityFeePerGasWei : fee;
  const tip = estimate.maxPriorityFeePerGas < tipCeiling ? estimate.maxPriorityFeePerGas : tipCeiling;
  return [fee, tip];
}

/** Reads the operator's configuration. Every limit has a conservative default; execution is off unless asked for. */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): EnvConfig {
  const rawKey = env["RECTA_PRIVATE_KEY"];
  const key = rawKey === undefined || rawKey === "" ? undefined : rawKey;
  if (key !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RECTA_PRIVATE_KEY must be the agent wallet's 0x-prefixed private key (use a dedicated wallet holding only what the agent may move), or unset to run only the free tools");
  const rawAddress = env["RECTA_ADDRESS"];
  const address = rawAddress === undefined || rawAddress === "" ? undefined : rawAddress;
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("RECTA_ADDRESS must be a 0x-prefixed EVM address (public, never a key)");
  const rpcUrls: Record<number, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^RECTA_RPC_(\d+)$/.exec(k);
    if (m === null || v === undefined) continue;
    if (!RPC_URL.test(v)) throw new Error(`${k} must be an https URL (http is allowed only for localhost)`);
    rpcUrls[Number(m[1])] = v;
  }
  const usdc = env["RECTA_MAX_FEE_USDC"] ?? "1";
  if (!/^\d+(\.\d{1,6})?$/.test(usdc)) throw new Error("RECTA_MAX_FEE_USDC must be a decimal USDC amount, e.g. 1 or 0.5");
  const [whole, frac = ""] = usdc.split(".");
  const native = env["RECTA_MAX_NATIVE_WEI"] ?? "0";
  if (!/^\d+$/.test(native)) throw new Error("RECTA_MAX_NATIVE_WEI must be an integer number of wei");
  const referrer = env["RECTA_REFERRER"];
  if (referrer !== undefined && referrer !== "" && !/^0x[0-9a-fA-F]{40}$/.test(referrer)) throw new Error("RECTA_REFERRER must be the referrer's 0x-prefixed EVM address");
  const bps = Number(env["RECTA_MIN_OUTPUT_BPS"] ?? "9900");
  if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) throw new Error("RECTA_MIN_OUTPUT_BPS must be an integer from 1 to 10000");
  return {
    ...(key === undefined ? {} : { privateKey: key as Hex }),
    ...(address === undefined ? {} : { address: address as Hex }),
    rpcUrls,
    maxPermitUsdcAtomic: BigInt(whole!) * 1_000_000n + BigInt(frac.padEnd(6, "0")),
    maxNativeValueWei: BigInt(native),
    minOutputBps: bps,
    // Without a key nothing can be signed or sent, whatever RECTA_ALLOW_EXECUTE says.
    allowExecute: key !== undefined && env["RECTA_ALLOW_EXECUTE"] === "yes",
    maxFeePerGasWei: gweiToWei(env["RECTA_MAX_FEE_GWEI"] ?? "50", "RECTA_MAX_FEE_GWEI"),
    maxPriorityFeePerGasWei: gweiToWei(env["RECTA_MAX_PRIORITY_FEE_GWEI"] ?? "2", "RECTA_MAX_PRIORITY_FEE_GWEI"),
    ...(referrer === undefined || referrer === "" ? {} : { referrer }),
  };
}

/** The server's `gasCapsFor`: the source chain's estimate from the operator's RPC, capped by `cappedGas`. */
export function gasCapsFrom(
  config: Pick<EnvConfig, "maxFeePerGasWei" | "maxPriorityFeePerGasWei">,
  ids: ReadonlyMap<string, number>,
  estimate: (chainId: number) => Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>,
): (network: string) => Promise<readonly [bigint, bigint]> {
  return async (network) => {
    const id = ids.get(network);
    if (id === undefined) throw new Error(`${network} is not an EVM source this client can execute`);
    return cappedGas(await estimate(id), config);
  };
}

function chainOf(id: number): Chain {
  const chain = Object.values(chains).find((c) => typeof c === "object" && c !== null && (c as Chain).id === id) as Chain | undefined;
  if (chain === undefined) throw new Error(`no known chain ${id}`);
  return chain;
}

/** A signer that only names an address and refuses to sign or send: the keyless server never asks it to. */
export function keylessSigner(address: Hex | undefined): RectaSigner {
  const refuse = async (): Promise<never> => {
    throw new RectaCheckError("no_key", "no key: set RECTA_PRIVATE_KEY to sign");
  };
  return { address: address ?? "0x0000000000000000000000000000000000000000", signMessage: refuse, signTypedData: refuse, sendTransaction: refuse };
}

export async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const transport = (id: number) => http(config.rpcUrls[id]);
  const ids = networkChainIds();
  const account = config.privateKey === undefined ? undefined : privateKeyToAccount(config.privateKey);
  if (account === undefined) process.stderr.write("recta-mcp: no RECTA_PRIVATE_KEY, running the free tools only (recta_fit, recta_trial_evaluation)\n");
  const server = createLocalServer({
    signer: account === undefined ? keylessSigner(config.address) : viemSigner({ account, walletClientFor: (id) => createWalletClient({ account, chain: chainOf(id), transport: transport(id) }) }),
    keyless: account === undefined,
    chain: viemChainReader((id) => createPublicClient({ chain: chainOf(id), transport: transport(id) })),
    limits: { maxPermitUsdcAtomic: config.maxPermitUsdcAtomic, maxNativeValueWei: config.maxNativeValueWei, minOutputBps: config.minOutputBps },
    allowExecute: config.allowExecute,
    ...(config.referrer === undefined ? {} : { referrer: config.referrer }),
    gasCapsFor: gasCapsFrom(config, ids, (id) => createPublicClient({ chain: chainOf(id), transport: transport(id) }).estimateFeesPerGas()),
  });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let message: unknown;
    try { message = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); continue; }
    const reply = await server.handle(message);
    if (reply !== undefined) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}
