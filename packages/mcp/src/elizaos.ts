import { createPublicClient, http, type Hex } from "viem";
import { chainOf, gasCapsFrom, keylessSigner, networkChainIds } from "./index.js";
import { createLocalServer, KEYLESS_TOOLS, TOOLS } from "./server.js";

/**
 * Recta as an elizaOS plugin (elizaOS 2.x actions with `parameters`): `RECTA_FIT` and `RECTA_TRIAL_EVALUATION`.
 *
 * Keyless by design: it holds no key, signs nothing and sends nothing. It asks Recta, unsigned, whether a cheaper
 * provable route exists for a cross-chain stablecoin transfer the agent would make anyway (for example with LI.FI or
 * Stargate), and how much Recta's 5 % of that saving would be. Each call is answered by the keyless `@recta/mcp`
 * server's own `tools/call`, so the checks are exactly those of `npx @recta/mcp` without a key.
 *
 * Typed by shape only, so this module does not depend on @elizaos/core.
 */

/** What this module reads of an elizaOS `IAgentRuntime`. */
export interface ElizaRuntimeLike {
  getSetting?(key: string): unknown;
}

/** JSON as Recta answers it (assignable to elizaOS `ProviderDataRecord`). */
export type ElizaJson = string | number | boolean | null | ElizaJson[] | { [key: string]: ElizaJson };

/** The parts of an elizaOS `ActionResult` this plugin returns. */
export interface ElizaActionResult {
  readonly success: boolean;
  readonly text: string;
  readonly data?: { [key: string]: ElizaJson };
  readonly error?: string;
}

/** An elizaOS `ActionParameter`: name, description, required, JSON schema. */
export interface ElizaActionParameter {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly schema: { readonly type: "string"; enum?: string[] };
}

export interface ElizaActionLike {
  readonly name: string;
  readonly description: string;
  readonly similes: string[];
  readonly routingHint: string;
  readonly parameters: ElizaActionParameter[];
  validate(runtime: ElizaRuntimeLike, message: unknown, state?: unknown, options?: unknown): Promise<boolean>;
  handler(
    runtime: ElizaRuntimeLike,
    message: unknown,
    state?: unknown,
    options?: unknown,
    callback?: (response: { text: string; actions?: string[] }) => Promise<unknown>,
  ): Promise<ElizaActionResult>;
}

export interface ElizaPluginLike {
  readonly name: string;
  readonly description: string;
  readonly actions: ElizaActionLike[];
}

export interface RectaElizaOptions {
  /**
   * The public EVM address the transfer would leave from, used when a call gives no `sender`. Without it the plugin
   * reads the runtime setting RECTA_ADDRESS. A public address, never a key.
   */
  readonly address?: string;
  /** Ceilings on the source gas price an evaluation may commit to (defaults 50 gwei and 2 gwei, as `@recta/mcp`). */
  readonly maxFeePerGasWei?: bigint;
  readonly maxPriorityFeePerGasWei?: bigint;
  /** The source chain's fee estimate. Default: viem's public client on the chain's public RPC, or the runtime setting
   *  RECTA_RPC_URL_<chainId> when it is set. */
  readonly estimateFeesPerGas?: (chainId: number) => Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const GWEI = 1_000_000_000n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Same limits as a keyless `@recta/mcp`: nothing is ever signed or sent, so they only fill the server's shape. */
const LIMITS = { maxPermitUsdcAtomic: 0n, maxNativeValueWei: 0n, minOutputBps: 10_000 };

const ACTIONS: Readonly<Record<string, { readonly action: string; readonly similes: string[]; readonly routingHint: string }>> = {
  recta_fit: {
    action: "RECTA_FIT",
    similes: ["RECTA_COVERAGE", "CHECK_BRIDGE_ROUTE_COVERAGE"],
    routingHint: "is a cross-chain stablecoin corridor covered by Recta, which baselines can be declared -> RECTA_FIT; free, read-only, never moves funds",
  },
  recta_trial_evaluation: {
    action: "RECTA_TRIAL_EVALUATION",
    similes: ["COMPARE_BRIDGE_COST", "CHECK_CHEAPER_BRIDGE_ROUTE", "BRIDGE_SAVING_CHECK"],
    routingHint:
      "before bridging USDC or USDT cross-chain (LI.FI, Stargate, deBridge, Across) -> RECTA_TRIAL_EVALUATION with the route you would use as baseline_provider; free, unsigned, read-only, never moves funds; it does not replace the bridge action",
  },
};

type JsonProperty = { readonly type?: string; readonly enum?: readonly string[]; readonly description?: string };

function parametersOf(schema: { readonly properties?: Readonly<Record<string, JsonProperty>>; readonly required?: readonly string[] }): ElizaActionParameter[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, p]) => ({
    name,
    description: name === "recipient" ? `${p.description ?? "Destination address."} To Solana, give a base58 Solana address: the EVM sender is not one.` : (p.description ?? name.replace(/_/g, " ")),
    required: required.has(name),
    schema: p.enum !== undefined && p.enum.length > 0 ? { type: "string", enum: [...p.enum] } : { type: "string" },
  }));
}

function settingOf(runtime: ElizaRuntimeLike | undefined, key: string): string | undefined {
  const v = runtime?.getSetting?.(key);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** The action's arguments as elizaOS 2.x passes them (`options.parameters`), strings only. */
function argsOf(options: unknown): Record<string, string> | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const params = (options as { readonly parameters?: unknown }).parameters;
  if (typeof params !== "object" || params === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

/** Recta's free tools as an elizaOS plugin. */
export function rectaElizaPlugin(options: RectaElizaOptions = {}): ElizaPluginLike {
  if (options.address !== undefined && !ADDRESS.test(options.address)) throw new Error("address must be an EVM address, 0x + 40 hex characters");
  const ids = networkChainIds();
  const ceilings = { maxFeePerGasWei: options.maxFeePerGasWei ?? 50n * GWEI, maxPriorityFeePerGasWei: options.maxPriorityFeePerGasWei ?? 2n * GWEI };
  // One keyless server per runtime and sender address, so each runtime keeps its own RPC settings (Fable L-3 on #20).
  const servers = new WeakMap<object, Map<string, ReturnType<typeof createLocalServer>>>();
  const noRuntime = {};
  let next = 0;

  function serverFor(runtime: ElizaRuntimeLike | undefined) {
    const address = options.address ?? settingOf(runtime, "RECTA_ADDRESS");
    if (address !== undefined && !ADDRESS.test(address)) throw new Error("RECTA_ADDRESS must be an EVM address, 0x + 40 hex characters (a public address, never a key)");
    const key = address?.toLowerCase() ?? "";
    const scope = typeof runtime === "object" && runtime !== null ? runtime : noRuntime;
    let byAddress = servers.get(scope);
    if (byAddress === undefined) {
      byAddress = new Map();
      servers.set(scope, byAddress);
    }
    const known = byAddress.get(key);
    if (known !== undefined) return known;
    const estimate =
      options.estimateFeesPerGas ??
      ((id: number) => createPublicClient({ chain: chainOf(id), transport: http(settingOf(runtime, `RECTA_RPC_URL_${id}`)) }).estimateFeesPerGas());
    const server = createLocalServer({
      signer: keylessSigner(address as Hex | undefined),
      keyless: true,
      chain: {
        waitForSuccess: async () => {
          throw new Error("the elizaOS plugin never sends");
        },
        readFeeFunds: async () => {
          throw new Error("the elizaOS plugin reads no fee funds");
        },
      },
      limits: LIMITS,
      allowExecute: false,
      gasCapsFor: gasCapsFrom(ceilings, ids, estimate),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    byAddress.set(key, server);
    return server;
  }

  const actions = TOOLS.filter((t) => KEYLESS_TOOLS.has(t.name)).map((tool): ElizaActionLike => {
    const meta = ACTIONS[tool.name];
    if (meta === undefined) throw new Error(`no elizaOS action for ${tool.name}`);
    const parameters = parametersOf(tool.inputSchema as Parameters<typeof parametersOf>[0]);
    return {
      name: meta.action,
      description: tool.description,
      similes: meta.similes,
      routingHint: meta.routingHint,
      parameters,
      validate: async () => true,
      handler: async (runtime, _message, _state, handlerOptions, callback) => {
        const args = argsOf(handlerOptions);
        const missing = parameters.filter((p) => p.required && (args?.[p.name] === undefined || args[p.name] === "")).map((p) => p.name);
        if (args === undefined || missing.length > 0) {
          const text = `${meta.action} needs ${missing.length > 0 ? missing.join(", ") : parameters.filter((p) => p.required).map((p) => p.name).join(", ")} (elizaOS 2.x action parameters).`;
          return { success: false, text, error: "MISSING_PARAMETERS" };
        }
        let reply: { readonly result?: { readonly content?: readonly { readonly text?: string }[]; readonly isError?: boolean }; readonly error?: { readonly message?: string } } | undefined;
        try {
          reply = (await serverFor(runtime).handle({ jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name: tool.name, arguments: args } })) as typeof reply;
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          return { success: false, text, error: "FAILED" };
        }
        const text = reply?.result?.content?.[0]?.text ?? JSON.stringify({ error: "FAILED", message: reply?.error?.message ?? "no answer" });
        let data: { [key: string]: ElizaJson } | undefined;
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) data = parsed as { [key: string]: ElizaJson };
        } catch {
          data = undefined;
        }
        const success = reply?.result !== undefined && reply.result.isError !== true;
        if (callback !== undefined) await callback({ text, actions: [meta.action] });
        return data === undefined ? { success, text } : { success, text, data };
      },
    };
  });

  return {
    name: "recta",
    description:
      "Recta (api.recta.build): before a cross-chain stablecoin transfer, check for free and without a key whether a cheaper provable route exists than the one you would use. Never signs or moves funds.",
    actions,
  };
}

/** The plugin with its defaults (sender from the runtime setting RECTA_ADDRESS, or from each call). */
export const rectaPlugin: ElizaPluginLike = rectaElizaPlugin();
export default rectaPlugin;

