import { z } from "zod";
import { cappedGas } from "./index.js";
import { createLocalServer, TOOLS, type LocalServerOptions } from "./server.js";

/**
 * The local MCP server's tools as plain framework actions (name, description, zod schema, invoke), for agent toolkits
 * that are not MCP clients (AgentKit, GOAT). Each call is answered by the server's own `tools/call`, so every check of
 * @recta/client runs before anything is signed or sent, exactly as in `npx @recta/mcp`.
 */
export interface RectaToolkitOptions {
  readonly limits: LocalServerOptions["limits"];
  /** Off by default: the agent evaluates and previews, but never signs a fee permit or sends a transaction. */
  readonly allowExecute?: boolean;
  /** Ceilings on the source gas price an evaluation may commit to (defaults 50 gwei and 2 gwei, as `@recta/mcp`). */
  readonly maxFeePerGasWei?: bigint;
  readonly maxPriorityFeePerGasWei?: bigint;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface RectaTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodTypeAny;
  invoke(args: Record<string, unknown>): Promise<string>;
}

const GWEI = 1_000_000_000n;
export const EXECUTING_TOOLS: ReadonlySet<string> = new Set(["recta_execute", "recta_pay_debt"]);

type JsonProperty = { readonly type?: string | readonly string[]; readonly enum?: readonly string[]; readonly description?: string };

/** The zod schema of one of the MCP server's input schemas (flat objects of strings, enums and objects). */
export function zodOf(schema: { readonly properties?: Readonly<Record<string, JsonProperty>>; readonly required?: readonly string[] }): z.ZodTypeAny {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    let field: z.ZodTypeAny =
      p.enum !== undefined && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : p.type === "object" ? z.record(z.string(), z.unknown()) : z.string();
    if (p.description !== undefined) field = field.describe(p.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape).strict();
}

/**
 * The tools for one wallet. `feeEstimate` returns the source chain's current fee estimate for a network key (and throws
 * when the wallet cannot start a route there); it is capped exactly as `@recta/mcp` caps it.
 */
export function rectaTools(
  wallet: Pick<LocalServerOptions, "signer" | "chain"> & { readonly feeEstimate: (network: string) => Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }> },
  options: RectaToolkitOptions,
  only?: ReadonlySet<string>,
): RectaTool[] {
  const ceilings = { maxFeePerGasWei: options.maxFeePerGasWei ?? 50n * GWEI, maxPriorityFeePerGasWei: options.maxPriorityFeePerGasWei ?? 2n * GWEI };
  const server = createLocalServer({
    signer: wallet.signer,
    chain: wallet.chain,
    limits: options.limits,
    allowExecute: options.allowExecute === true,
    gasCapsFor: async (network) => cappedGas(await wallet.feeEstimate(network), ceilings),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let next = 0;
  return TOOLS.filter((t) => (options.allowExecute === true || !EXECUTING_TOOLS.has(t.name)) && (only === undefined || only.has(t.name))).map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: zodOf(tool.inputSchema as Parameters<typeof zodOf>[0]),
    invoke: async (args: Record<string, unknown>) => {
      const reply = (await server.handle({ jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name: tool.name, arguments: args } })) as
        | { readonly result?: { readonly content?: readonly { readonly text?: string }[] }; readonly error?: { readonly message?: string } }
        | undefined;
      return reply?.result?.content?.[0]?.text ?? JSON.stringify({ error: "FAILED", message: reply?.error?.message ?? "no answer" });
    },
  }));
}
