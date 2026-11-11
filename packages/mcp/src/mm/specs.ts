import type { Hex } from "viem";
import { RectaCheckError } from "@recta/client";
import { configFromEnv, networkChainIds } from "../index.js";
import { metaMaskRectaServer, selectedMetaMaskAddress, type MetaMaskPublicClientFor, type MetaMaskWalletExecutor, type MetaMaskWalletStateLike } from "../metamask.js";

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
  text("amount", "Amount in whole units of the asset, e.g. 100 for 100 USDC.", { required: true }),
  text("baseline-provider", "The route you would use without Recta, e.g. stargate_v2, across, relay, lifi.", { required: true }),
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
  run(call: ToolCall, args: Record<string, unknown>, flags: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
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
  if (r.isError) throw new RectaToolError(r.body);
  return r.body;
};

const one = (name: string): CommandSpec["run"] => (call, args) => answer(call, name, args);

/** Every chain a Recta route can start from (the client's pinned routes), and Base, where the fee is paid. */
const ROUTE_CHAINS: readonly number[] = [...new Set([...networkChainIds().values(), 8453])].sort((a, b) => a - b);

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
    run: async (call, args, flags) => {
      const evaluation = await answer(call, "recta_evaluate", args);
      const decision = evaluation["decision"];
      const state = typeof decision === "object" && decision !== null ? (decision as Record<string, unknown>)["state"] : undefined;
      const resultId = evaluation["result_id"];
      if (state !== "VERIFIED_POSITIVE" || typeof resultId !== "string") return { evaluation, next: NO_SAVING };
      if (flags["execute"] !== true) {
        return {
          evaluation,
          preview: await answer(call, "recta_preview", { result_id: resultId }),
          next: "Nothing was signed beyond the request or sent. To move it through Recta, run the same command with --execute: Recta evaluates again at the new chain state, then MetaMask signs the fee permit and sends the checked transactions.",
        };
      }
      return { evaluation, execution: await answer(call, "recta_execute", { result_id: resultId }) };
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
];

/** What a command reads of `PluginCommandContext` (@metamask/agent-wallet 7.3.0). */
export interface MmContextLike {
  readonly walletStateManager?: { read(): MetaMaskWalletStateLike };
  publicClient(chainId: number): ReturnType<MetaMaskPublicClientFor>;
  walletExecutor(io: unknown, source: string): Promise<MetaMaskWalletExecutor>;
}

const present = (v: unknown): v is string | boolean => (typeof v === "string" && v.length > 0) || typeof v === "boolean";

/** Runs one command: its flags in, the tool's JSON answer out (bigints as strings). Throws RectaToolError or RectaCheckError. */
export async function runCommand(spec: CommandSpec, ctx: MmContextLike, io: unknown, flags: Readonly<Record<string, unknown>>, fetchImpl?: typeof fetch): Promise<Record<string, unknown>> {
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
  if (spec.wallet !== "none" && address === undefined) {
    if (ctx.walletStateManager === undefined) throw new RectaCheckError("wallet_address", "mm gave this command no wallet state: pass --address");
    address = selectedMetaMaskAddress(ctx.walletStateManager.read());
  }
  const signs = spec.wallet === "sign" || spec.wallet === "send";
  const call = metaMaskRectaServer({
    keyless: spec.wallet === "none" || (spec.wallet === "read" && spec.id === "recta:trial"),
    ...(address === undefined ? {} : { address }),
    ...(signs ? { execute: await ctx.walletExecutor(io, spec.id) } : {}),
    publicClientFor: (id) => ctx.publicClient(id),
    limits: config,
    allowExecute: spec.wallet === "send",
    ...(config.referrer === undefined ? {} : { referrer: config.referrer }),
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
  const args: Record<string, unknown> = {};
  for (const input of spec.inputs) if (input.arg !== undefined && present(flags[input.flag])) args[input.arg] = flags[input.flag];
  const out = await spec.run(call, args, flags);
  return JSON.parse(JSON.stringify(out, (_, x) => (typeof x === "bigint" ? x.toString() : x))) as Record<string, unknown>;
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
    const kind = typeof e.body["error"] === "string" ? (e.body["error"] as string) : "FAILED";
    const hint = kind === "DEBT" ? "Pay it with: mm recta pay-debt --debt-offer '<the debt_offer JSON above>'" : HINT;
    return new sdk.CommandError(`RECTA_${kind.replace(/[^A-Z_]/g, "")}`, e.message, hint);
  }
  if (e instanceof RectaCheckError) return new sdk.CommandError("RECTA_CHECK_FAILED", JSON.stringify({ error: "CHECK_FAILED", check: e.check, message: e.message }), HINT);
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
