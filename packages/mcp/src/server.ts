import { createRectaClient, RectaCheckError, RectaDebtError, RectaHttpError, pins, type RectaChainReader, type RectaClient, type RectaSigner } from "@recta/client";

/**
 * A local MCP server (stdio, JSON-RPC 2.0) that runs Recta's flow with a key that stays on the agent's machine. It is
 * a thin layer over @recta/client: every check of the client runs before any signature, and sending transactions is
 * off unless the operator turns it on (`allowExecute`).
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SERVER_INFO = { name: "recta-local", version: "0.1.5" } as const;
/** Sent on every request this package makes (its own and the client's), so Recta can count real use of it apart from
 *  other clients (no address, no key). */
export const MCP_USER_AGENT = `recta-mcp/${SERVER_INFO.version}`;

/** `fetch` with this package's User-Agent on every request, whatever headers the caller set. */
export function withRectaUserAgent(f: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers: Record<string, string> = {};
    // Fable J-2: a Request's own headers (a signature among them) are kept; init's override them, as fetch does.
    if (typeof Request !== "undefined" && input instanceof Request) input.headers.forEach((value, key) => { headers[key] = value; });
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    headers["user-agent"] = MCP_USER_AGENT;
    return f(input, { ...init, headers });
  };
}

export interface LocalServerOptions {
  readonly signer: RectaSigner;
  readonly chain: RectaChainReader;
  readonly limits: { readonly maxPermitUsdcAtomic: bigint; readonly maxNativeValueWei: bigint; readonly minOutputBps: number };
  /** Off by default: without it the server evaluates and previews, but never signs a fee permit or sends a transaction. */
  readonly allowExecute: boolean;
  /** Gas caps for a source chain when the tool call gives none: `[maxFeePerGasWei, maxPriorityFeePerGasWei]`. */
  readonly gasCapsFor: (network: string) => Promise<readonly [bigint, bigint]>;
  /** Who referred this agent (OD-REF-1): see `RectaClientOptions.referrer`. Usually set by the integration's author. */
  readonly referrer?: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

type Json = Record<string, unknown>;
const ROUTE = {
  source_network: { type: "string", description: "Source network key, e.g. base, arbitrum, ethereum, optimism, polygon." },
  source_asset: { type: "string", description: "Asset moved, e.g. USDC or USDT." },
  destination_network: { type: "string" },
  destination_asset: { type: "string", description: "Defaults to source_asset." },
} as const;

const EVALUATE_INPUT = {
  type: "object",
  properties: {
    ...ROUTE,
    amount: { type: "string", description: "Whole units, e.g. \"100\". Recta accepts 10 to 100000." },
    baseline_provider: { type: "string", description: "The route you would use without Recta, one of the corridor's declarable_baselines in recta_fit (GET /v1/golden-corridor/fit): across, stargate_v2, usdt0, usdg_oft, debridge_dln or lifi (LI.FI: declarable where recta_fit lists lifi in declarable_baselines, never with latency_class SECONDS or MINUTES; Recta reads LI.FI's own transaction, fee included) (thorchain or chainflip from Bitcoin). The saving is measured against it. Relay is compared but cannot be declared, and CCTP needs a destination execution authority this tool does not send." },
    recipient: { type: "string", description: "Destination address; defaults to the local wallet." },
    guarantee_class: { type: "string", enum: ["COMMITTED_ENFORCED", "ANY"], description: "Default ANY." },
    latency_class: { type: "string", enum: ["SECONDS", "MINUTES", "FINALITY_BOUND", "ANY"], description: "Default ANY." },
  },
  required: ["source_network", "source_asset", "destination_network", "amount", "baseline_provider"],
  additionalProperties: false,
} as const;

export const TOOLS = [
  {
    name: "recta_fit",
    description: "Free and unsigned: does Recta cover this corridor, and which contracts would a route call? Call it before recta_evaluate.",
    inputSchema: { type: "object", properties: ROUTE, required: ["source_network", "source_asset", "destination_network"], additionalProperties: false },
  },
  {
    name: "recta_evaluate",
    description: "Before a cross-chain stablecoin transfer: ask Recta, signed with the local key, whether a cheaper route than the one you would use (baseline_provider) can be proven at the same chain state. Free; returns a result_id. If there is no saving, keep your own route: nothing is owed.",
    inputSchema: EVALUATE_INPUT,
  },
  {
    name: "recta_trial_evaluation",
    description: "Free, unsigned and stored nowhere: the same question as recta_evaluate with the same arguments, answered only with whether a cheaper provable route exists, the saving (lower bound, USDC) and Recta's 5 % of it. Names no route and returns no result_id; 3 a day per address. Use it to see whether Recta is worth a signature.",
    inputSchema: EVALUATE_INPUT,
  },
  {
    name: "recta_preview",
    description: "For a result_id with a saving: shows the fee ceiling Recta asks you to authorize and, when no permit is needed, the transactions after this server's local checks. Signs nothing, sends nothing.",
    inputSchema: { type: "object", properties: { result_id: { type: "string" } }, required: ["result_id"], additionalProperties: false },
  },
  {
    name: "recta_execute",
    description: "For a result_id with a saving: signs the fee permit (never above the operator's cap), sends the committed transactions from the local wallet after the local checks, and reports them to Recta. Recta charges exactly 5 % of the saving it verifies on chain. Only available when the operator enabled execution.",
    inputSchema: { type: "object", properties: { result_id: { type: "string" } }, required: ["result_id"], additionalProperties: false },
  },
  {
    name: "recta_report",
    description: "Reports an executed route again (for example after a PENDING answer). Returns ACCRUED, PENDING or REFUSED.",
    inputSchema: { type: "object", properties: { result_id: { type: "string" }, origin_tx_hash: { type: "string" }, approval_tx_hash: { type: "string" } }, required: ["result_id", "origin_tx_hash"], additionalProperties: false },
  },
  {
    name: "recta_pay_debt",
    description: "When recta_evaluate answered DEBT: signs the debt permit Recta offered (after the same checks as a fee permit, never above the operator's cap) so evaluations can continue. Only available when the operator enabled execution.",
    inputSchema: { type: "object", properties: { debt_offer: { type: "object", description: "The debt_offer object exactly as recta_evaluate returned it." } }, required: ["debt_offer"], additionalProperties: false },
  },
  {
    name: "recta_ledger",
    description: "The local wallet's Recta fees and whether each was collected.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

/** The unsigned trial (api.recta.build, BIT-OPS-079). */
export const TRIAL_EVALUATION_PATH = "/v1/golden-corridor/trial-evaluation";
const EXECUTING_TOOLS: ReadonlySet<string> = new Set(["recta_execute", "recta_pay_debt"]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const str = (args: Json, k: string): string => {
  const v = args[k];
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new RectaCheckError("input", `${k} must be a non-empty string`);
  return v;
};
const opt = (args: Json, k: string): string | undefined => (args[k] === undefined ? undefined : str(args, k));

export function createLocalServer(options: LocalServerOptions) {
  const client: RectaClient = createRectaClient({
    signer: options.signer,
    chain: options.chain,
    limits: options.limits,
    ...(options.referrer === undefined ? {} : { referrer: options.referrer }),
    fetch: withRectaUserAgent(options.fetch ?? fetch),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const doFetch = withRectaUserAgent(options.fetch ?? fetch);
  /** The request behind each result_id this server evaluated: execute and preview check the artifact against it. */
  const requests = new Map<string, Json & { source_network: string; source_asset: string; destination_network: string; destination_asset: string; amount: string; sender: string; recipient: string }>();

  const requestOf = (args: Json) => {
    const id = str(args, "result_id");
    const request = requests.get(id);
    if (request === undefined) throw new RectaCheckError("result_id", "unknown result_id: evaluate with this server first");
    return { id, request };
  };

  /** The evaluation request for the local wallet, as recta_evaluate signs it and recta_trial_evaluation sends it unsigned. */
  async function evaluationRequestOf(args: Json) {
    const source = str(args, "source_network");
    const [maxFee, priority] = await options.gasCapsFor(source);
    return {
      schema: "RECTA_COMMERCIAL_ECONOMIC_REQUEST_V1",
      source_network: source,
      source_asset: str(args, "source_asset"),
      destination_network: str(args, "destination_network"),
      destination_asset: opt(args, "destination_asset") ?? str(args, "source_asset"),
      amount: str(args, "amount"),
      // The client executes only the source side: no destination transaction is ever committed to.
      constraints: { guarantee_class: opt(args, "guarantee_class") ?? "ANY", latency_class: opt(args, "latency_class") ?? "ANY", destination_execution: "NONE" },
      sender: options.signer.address,
      recipient: opt(args, "recipient") ?? options.signer.address,
      baseline_provider: str(args, "baseline_provider"),
      execution_authority: { headroom: "0.2", source_max_fee_per_gas_wei: maxFee.toString(), source_max_priority_fee_per_gas_wei: priority.toString() },
    };
  }

  async function call(name: string, args: Json): Promise<unknown> {
    switch (name) {
      case "recta_fit": {
        const q = new URLSearchParams({ source_network: str(args, "source_network"), source_asset: str(args, "source_asset"), destination_network: str(args, "destination_network"), destination_asset: opt(args, "destination_asset") ?? str(args, "source_asset") });
        const r = await doFetch(`${pins.RECTA_ORIGIN}/v1/golden-corridor/fit?${q.toString()}`, { headers: { accept: "application/json" } });
        return await r.json();
      }
      case "recta_evaluate": {
        const request = await evaluationRequestOf(args);
        const decision = (await client.evaluate(request)) as Json;
        const id = decision["result_id"];
        if (typeof id === "string") requests.set(id, request);
        return decision;
      }
      case "recta_trial_evaluation": {
        const r = await doFetch(`${pins.RECTA_ORIGIN}${TRIAL_EVALUATION_PATH}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(await evaluationRequestOf(args)) });
        const text = await r.text();
        try { return JSON.parse(text) as unknown; } catch { return { status: r.status, body: text }; }
      }
      case "recta_preview": {
        const { id, request } = requestOf(args);
        const fee = await client.authorizeFee(id, { dryRun: true });
        if (fee.fee.kind === "DRY_RUN") return { fee_permit_required: true, fee_ceiling_usdc_atomic: fee.fee.amountUsdcAtomic.toString(), within_operator_cap: true, note: "recta_execute signs this ceiling; Recta then charges exactly 5 % of the saving it verifies, never more than the ceiling." };
        return { fee_permit_required: false, transactions: (await client.check(id, fee.artifact, request)).transactions };
      }
      case "recta_execute": {
        if (!options.allowExecute) throw new RectaCheckError("execution_disabled", "the operator has not enabled execution (RECTA_ALLOW_EXECUTE=yes)");
        const { id, request } = requestOf(args);
        const { fee, artifact } = await client.authorizeFee(id);
        const sent = await client.execute(id, artifact, request);
        const report = await client.report(id, sent.originTxHash, sent.approvalTxHash);
        return { fee: fee.kind, ...sent, report: report.stage, recta: report.body };
      }
      case "recta_report": {
        const id = str(args, "result_id");
        const origin = str(args, "origin_tx_hash");
        const approval = opt(args, "approval_tx_hash");
        if (!HEX32.test(origin) || (approval !== undefined && !HEX32.test(approval))) throw new RectaCheckError("input", "transaction hashes must be 0x + 64 hex characters");
        const r = await client.report(id, origin as `0x${string}`, approval as `0x${string}` | undefined);
        return { report: r.stage, recta: r.body };
      }
      case "recta_pay_debt": {
        if (!options.allowExecute) throw new RectaCheckError("execution_disabled", "the operator has not enabled execution (RECTA_ALLOW_EXECUTE=yes)");
        return await client.payDebt(args["debt_offer"]);
      }
      case "recta_ledger":
        return await client.ledger();
      default:
        throw new RectaCheckError("tool", `unknown tool ${name}`);
    }
  }

  const text = (v: unknown) => [{ type: "text", text: JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) }];

  /** One JSON-RPC message in, at most one out (notifications get none). */
  async function handle(message: unknown): Promise<Json | undefined> {
    if (typeof message !== "object" || message === null || (message as Json)["jsonrpc"] !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    const m = message as Json;
    const id = m["id"];
    if (id === undefined) return undefined;
    const params = (typeof m["params"] === "object" && m["params"] !== null ? m["params"] : {}) as Json;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (m["method"]) {
      case "initialize": {
        const requested = params["protocolVersion"];
        const protocolVersion = typeof requested === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: "Before a cross-chain stablecoin transfer, call recta_evaluate with the route you would use anyway (baseline_provider). Use Recta's route only when it proves a saving; otherwise keep yours and nothing is owed." });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.filter((t) => options.allowExecute || !EXECUTING_TOOLS.has(t.name)) });
      case "tools/call": {
        const name = params["name"];
        const args = (typeof params["arguments"] === "object" && params["arguments"] !== null ? params["arguments"] : {}) as Json;
        if (typeof name !== "string") return { jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call needs a tool name" } };
        try {
          return ok({ content: text(await call(name, args)), isError: false });
        } catch (e) {
          const body = e instanceof RectaDebtError ? { error: "DEBT", debt_offer: e.offer } : e instanceof RectaHttpError ? { error: "HTTP", status: e.status, reason_code: e.reasonCode, body: e.body } : e instanceof RectaCheckError ? { error: "CHECK_FAILED", check: e.check, message: e.message } : { error: "FAILED", message: e instanceof Error ? e.message : String(e) };
          return ok({ content: text(body), isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
  }

  return { handle, call };
}
