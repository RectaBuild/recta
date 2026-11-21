import { CLIENT_VERSION, RECTA_ORIGIN } from "./constants.js";
import { PINNED_ROUTES } from "./pinned-routes.js";

/**
 * Recta Preflight (POST https://api.recta.build/v1/preflight): a free, unsigned check before a cross-chain USDC/USDT
 * transfer. It answers the route's total cost and arrival time, and whether Recta proves a cheaper route. No key, no
 * wallet; nothing is stored. `withPreflight` puts it in front of the bridge call an agent already makes, so the check
 * runs on every transfer without the model having to remember it.
 */
export const PREFLIGHT_PATH = "/v1/preflight";
/** Sent on every preflight this package makes, so Recta can count use of the wrapper apart from other clients. */
export const PREFLIGHT_USER_AGENT = `recta-client/${CLIENT_VERSION} (preflight)`;

export interface PreflightTransfer {
  /** Network keys as Recta names them: base, arbitrum, ethereum, optimism, polygon… */
  readonly source_network: string;
  /** USDC, USDT… */
  readonly source_asset: string;
  readonly destination_network: string;
  /** USDC, USDT… (required by the preflight, even when it is the source asset). */
  readonly destination_asset: string;
  /** Whole tokens: "1000" (or 1000) with USDC is 1,000 USDC. */
  readonly amount: string | number | bigint;
  /** The route you would use (lifi, across, stargate_v2, cctp_v2_standard…). Absent: LI.FI, or Across where LI.FI does not apply. */
  readonly baseline_provider?: string;
  /** Your sending address, for the most exact figure. */
  readonly sender?: string;
  readonly recipient?: string;
}

export interface PreflightRouteEstimate {
  readonly total_cost_usdc?: unknown;
  readonly arrival?: unknown;
  readonly [key: string]: unknown;
}

/** Recta's answer, as JSON, plus the HTTP status. `outcome` is set when Recta decided. */
export interface PreflightAnswer {
  readonly http_status: number;
  /** SAVING_FOUND, NO_SAVING, NOT_PROVEN or NO_SAVING_EXPECTED. */
  readonly outcome?: string;
  /** The proven saving (a lower bound), in USDC, when outcome is SAVING_FOUND. */
  readonly saving_usdc?: string;
  readonly your_route?: PreflightRouteEstimate;
  readonly via_recta?: PreflightRouteEstimate | null;
  /** How to get Recta's route: `body_to_sign`, `how`, `with_mcp`. */
  readonly execute_via_recta?: Record<string, unknown>;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export interface PreflightOptions {
  readonly fetch?: typeof fetch;
  /** Give up after this long (default 10 000 ms). The bridge is never held longer than this. */
  readonly timeoutMs?: number;
}

const REQUIRED_FIELDS = ["source_network", "source_asset", "destination_network", "destination_asset", "amount"] as const;
const FIELD_ALIASES: Readonly<Record<string, string>> = {
  sourceNetwork: "source_network",
  sourceAsset: "source_asset",
  destinationNetwork: "destination_network",
  destinationAsset: "destination_asset",
  baselineProvider: "baseline_provider",
};

/** Thrown by `preflight` before any request when the transfer lacks a needed field or holds a value it cannot send as given. */
export class PreflightInputError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly invalid: readonly string[] = [],
  ) {
    const parts = [
      ...(missing.length > 0 ? [`needs ${missing.join(", ")}`] : []),
      ...(invalid.length > 0 ? [`cannot send ${invalid.join("; ")}`] : []),
    ];
    super(
      `Recta Preflight ${parts.join(" and ")}. Pass { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: "1000" } ` +
        `(whole tokens; a positive number or bigint is accepted), or build it with lifiTransfer() / transferFromChainTokens().`,
    );
    this.name = "PreflightInputError";
  }
}

/** A value as the preflight reads it, or a reason it cannot be sent as given. Nothing is ever filled in or guessed. */
function wireValue(key: string, v: unknown): { readonly value?: string; readonly invalid?: string } {
  if (v === undefined || v === null) return {};
  if (typeof v === "string") return v.trim() === "" ? {} : { value: v.trim() };
  if (typeof v === "bigint") return v > 0n ? { value: v.toString() } : { invalid: `${key} = ${v.toString()} (must be positive)` };
  if (typeof v === "number") {
    // String(n) is the shortest decimal that is exactly this number; an exponent form (1e21, 1e-7) is not a plain decimal.
    const text = String(v);
    if (!Number.isFinite(v) || v <= 0) return { invalid: `${key} = ${text} (must be a positive finite number)` };
    if (/e/i.test(text)) return { invalid: `${key} = ${text} (pass it as a decimal string)` };
    if (key === "amount" && Number.isInteger(v) && !Number.isSafeInteger(v)) return { invalid: `${key} = ${text} (beyond exact number precision: pass a string or bigint)` };
    return { value: text };
  }
  return { invalid: `${key} (a ${typeof v}, not a string or number)` };
}

/**
 * What one transfer becomes on the wire: strings as given (trimmed), positive finite numbers and bigints as their exact
 * decimal text (amount: 1000 → "1000"), camelCase names under Recta's (sourceNetwork → source_network). `missing` and
 * `invalid` say what keeps it from being sent; no value is ever replaced by a default or an example.
 */
export function preflightBody(transfer: PreflightTransfer | Readonly<Record<string, unknown>>): { readonly body: Record<string, string>; readonly missing: readonly string[]; readonly invalid: readonly string[] } {
  const body: Record<string, string> = {};
  const invalid: string[] = [];
  for (const [k, v] of Object.entries(transfer)) {
    const key = FIELD_ALIASES[k] ?? k;
    const read = wireValue(key, v);
    if (read.invalid !== undefined) invalid.push(read.invalid);
    if (read.value === undefined) continue;
    if (body[key] !== undefined && body[key] !== read.value) invalid.push(`${key} given twice with different values (${body[key]}, ${read.value})`);
    else body[key] = read.value;
  }
  const missing = REQUIRED_FIELDS.filter((k) => body[k] === undefined && !invalid.some((i) => i.startsWith(`${k} `)));
  return { body, missing, invalid };
}

/**
 * One preflight. A transfer without the fields the preflight needs, or with a value it cannot send as given, throws
 * PreflightInputError before any request; network failures, timeouts and non-JSON replies throw; a refusal
 * (4xx/5xx JSON) is returned as is.
 */
export async function preflight(transfer: PreflightTransfer, options: PreflightOptions = {}): Promise<PreflightAnswer> {
  const { body, missing, invalid } = preflightBody(transfer);
  if (missing.length > 0 || invalid.length > 0) throw new PreflightInputError(missing, invalid);
  const f = options.fetch ?? fetch;
  const response = await f(`${RECTA_ORIGIN}${PREFLIGHT_PATH}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": PREFLIGHT_USER_AGENT },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const parsed: unknown = JSON.parse(await response.text());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`preflight answered ${response.status} without a JSON object`);
  return { ...(parsed as Record<string, unknown>), http_status: response.status };
}

// --- Mapping chain ids and token addresses (what LI.FI, viem and most SDKs use) to Recta's keys ---

type TokenKey = { readonly network: string; readonly asset: string };
let tokenIndex: Map<string, TokenKey> | undefined;
let networkIndex: Map<number, string> | undefined;

function indexes(): { readonly tokens: Map<string, TokenKey>; readonly networks: Map<number, string> } {
  if (tokenIndex === undefined || networkIndex === undefined) {
    const tokens = new Map<string, TokenKey>();
    const networks = new Map<number, string>();
    for (const [key, route] of Object.entries(PINNED_ROUTES)) {
      const [from, to] = key.split(">") as [string, string];
      const [srcNet, srcAsset] = from.split(":") as [string, string];
      const [dstNet, dstAsset] = to.split(":") as [string, string];
      networks.set(route.source_chain_id, srcNet);
      tokens.set(`${route.source_chain_id}:${route.source_token.toLowerCase()}`, { network: srcNet, asset: srcAsset });
      tokens.set(`${dstNet}:${route.output_token.toLowerCase()}`, { network: dstNet, asset: dstAsset });
    }
    tokenIndex = tokens;
    networkIndex = networks;
  }
  return { tokens: tokenIndex, networks: networkIndex };
}

/** A decimal string of whole tokens from an atomic amount: ("1000000000", 6) → "1000". */
export function decimalAmount(atomic: string | bigint, decimals: number): string {
  const v = BigInt(atomic);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? (v / unit).toString() : `${v / unit}.${frac}`;
}

export interface ChainTokenTransfer {
  readonly fromChainId: number | string;
  readonly toChainId: number | string;
  readonly fromToken: string;
  readonly toToken: string;
  /** Atomic units of fromToken, as the SDKs pass it ("1000000000" is 1,000 USDC). */
  readonly fromAmount: string | bigint;
  readonly fromAddress?: string;
  readonly toAddress?: string;
  readonly baseline_provider?: string;
}

/**
 * The preflight transfer for a transfer named by chain ids and token addresses, or undefined when Recta does not serve
 * that corridor (then there is nothing to check, and the bridge runs as it would).
 */
export function transferFromChainTokens(t: ChainTokenTransfer): PreflightTransfer | undefined {
  const { tokens, networks } = indexes();
  const fromId = Number(t.fromChainId);
  const toNetwork = networks.get(Number(t.toChainId));
  const source = tokens.get(`${fromId}:${t.fromToken.toLowerCase()}`);
  if (source === undefined || toNetwork === undefined) return undefined;
  const destination = tokens.get(`${toNetwork}:${t.toToken.toLowerCase()}`);
  if (destination === undefined) return undefined;
  const route = PINNED_ROUTES[`${source.network}:${source.asset}>${destination.network}:${destination.asset}`];
  if (route === undefined) return undefined;
  return {
    source_network: source.network,
    source_asset: source.asset,
    destination_network: destination.network,
    destination_asset: destination.asset,
    amount: decimalAmount(t.fromAmount, route.source_decimals),
    ...(t.baseline_provider === undefined ? {} : { baseline_provider: t.baseline_provider }),
    ...(t.fromAddress === undefined ? {} : { sender: t.fromAddress }),
    ...(t.toAddress === undefined ? {} : { recipient: t.toAddress }),
  };
}

type LifiToken = string | { readonly address: string };
const addressOf = (t: LifiToken | undefined): string | undefined => (t === undefined ? undefined : typeof t === "string" ? t : t.address);

/**
 * The preflight transfer for what LI.FI's SDK and API take or return, compared against LI.FI itself: a quote or routes
 * request (`getQuote`, `getRoutes`, `GET /v1/quote`: fromChain, toChain, fromToken, toToken, fromAmount, fromAddress,
 * toAddress) or a `Route` passed to `executeRoute` (fromChainId, toChainId, fromToken.address, toToken.address…).
 */
export function lifiTransfer(request: {
  readonly fromChain?: number | string;
  readonly fromChainId?: number | string;
  readonly toChain?: number | string;
  readonly toChainId?: number | string;
  readonly fromToken?: LifiToken;
  readonly fromTokenAddress?: string;
  readonly toToken?: LifiToken;
  readonly toTokenAddress?: string;
  readonly fromAmount: string | bigint;
  readonly fromAddress?: string;
  readonly toAddress?: string;
}): PreflightTransfer | undefined {
  const fromChainId = request.fromChain ?? request.fromChainId;
  const toChainId = request.toChain ?? request.toChainId;
  const fromToken = addressOf(request.fromToken) ?? request.fromTokenAddress;
  const toToken = addressOf(request.toToken) ?? request.toTokenAddress;
  if (fromChainId === undefined || toChainId === undefined || fromToken === undefined || toToken === undefined) return undefined;
  return transferFromChainTokens({
    fromChainId,
    toChainId,
    fromToken,
    toToken,
    fromAmount: request.fromAmount,
    baseline_provider: "lifi",
    ...(request.fromAddress === undefined ? {} : { fromAddress: request.fromAddress }),
    ...(request.toAddress === undefined ? {} : { toAddress: request.toAddress }),
  });
}

// --- The wrapper ---

/** Thrown by a wrapped call with `stopOnSaving` when Recta proves a cheaper route: the bridge was not called. */
export class RectaSavingFoundError extends Error {
  constructor(readonly answer: PreflightAnswer) {
    super(`Recta Preflight proved a cheaper route (saving ${answer.saving_usdc ?? "?"} USDC); the bridge was not called. Sign answer.execute_via_recta.body_to_sign to get it, or call again with the preflight off.`);
    this.name = "RectaSavingFoundError";
  }
}

export interface WithPreflightOptions extends PreflightOptions {
  /** Every answer (or the error when the preflight could not be made). Never awaited longer than the bridge needs. */
  readonly onPreflight?: (result: { readonly transfer: PreflightTransfer; readonly answer?: PreflightAnswer; readonly error?: unknown }) => void;
  /**
   * Off by default: the bridge always runs. On: when Recta proves a saving, the wrapped call throws
   * RectaSavingFoundError before the bridge is called, so the agent can choose Recta's route.
   */
  readonly stopOnSaving?: boolean;
  /** Without onPreflight, the first refused or failed preflight is reported once with console.warn; true hides it. */
  readonly quiet?: boolean;
}

type WarnState = { warned: boolean };
/** Without onPreflight a refused or failed preflight would go unseen: say so once per wrapped call, on the console. */
function warnOnce(options: WithPreflightOptions, state: WarnState, problem: string): void {
  if (options.onPreflight !== undefined || options.quiet === true || state.warned) return;
  state.warned = true;
  console.warn(`[@recta/client] Recta Preflight did not run: ${problem} The bridge still ran. Pass onPreflight to see every answer, or quiet: true to hide this.`);
}

/** The preflight for one call, or undefined; never throws (a failed preflight never blocks the bridge). */
async function check(transfer: PreflightTransfer | undefined, options: WithPreflightOptions, state: WarnState): Promise<PreflightAnswer | undefined> {
  if (transfer === undefined) return undefined;
  try {
    const answer = await preflight(transfer, options);
    options.onPreflight?.({ transfer, answer });
    if (answer.outcome === undefined && answer.http_status >= 400) warnOnce(options, state, `HTTP ${answer.http_status}${typeof answer["reason_code"] === "string" ? ` ${answer["reason_code"]}` : ""}${typeof answer.message === "string" ? `: ${answer.message}` : "."}`);
    return answer;
  } catch (error) {
    options.onPreflight?.({ transfer, error });
    warnOnce(options, state, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/**
 * `bridge` with Recta Preflight in front: each call first asks the preflight about the transfer `toTransfer` reads
 * from the call's arguments (undefined: not a corridor Recta serves, no check), then calls `bridge` with the same
 * arguments and returns its result unchanged. A failed or slow preflight never blocks the bridge.
 *
 *   const executeRoute = withPreflight(lifi.executeRoute, (route) => lifiTransfer(route));
 */
export function withPreflight<A extends unknown[], R>(bridge: (...args: A) => Promise<R>, toTransfer: (...args: A) => PreflightTransfer | undefined, options: WithPreflightOptions = {}): (...args: A) => Promise<R> {
  const state: WarnState = { warned: false };
  return async (...args: A) => {
    const answer = await check(toTransfer(...args), options, state);
    if (options.stopOnSaving === true && answer?.outcome === "SAVING_FOUND") throw new RectaSavingFoundError(answer);
    return bridge(...args);
  };
}

/** The part of a preflight answer worth showing a model next to the bridge's own result. */
export function preflightSummary(answer: PreflightAnswer): Record<string, unknown> {
  return {
    outcome: answer.outcome ?? `HTTP ${answer.http_status}`,
    ...(answer.saving_usdc === undefined ? {} : { saving_usdc: answer.saving_usdc }),
    ...(answer.your_route === undefined ? {} : { your_route: answer.your_route }),
    ...(answer.via_recta === undefined || answer.via_recta === null ? {} : { via_recta: answer.via_recta }),
    ...(answer.outcome === "SAVING_FOUND" && answer.execute_via_recta !== undefined ? { execute_via_recta: answer.execute_via_recta } : {}),
    ...(answer.message === undefined ? {} : { message: answer.message }),
  };
}

/**
 * A tool (Vercel AI SDK `tool()`, or any `{ execute(input, ...rest) }`) with Recta Preflight in front of `execute`.
 * The tool's result gets a `recta_preflight` field (when it is a plain object) so the model sees the cost, arrival and
 * any proven saving. With `stopOnSaving`, a proven saving returns `{ status: "RECTA_SAVING_FOUND", recta_preflight }`
 * instead of bridging, so the model can choose; call the tool again with `skip_preflight: true` in its input to bridge
 * anyway (the field is removed before `execute` sees it).
 */
export function withPreflightTool<T extends { execute?: (input: never, ...rest: never[]) => unknown }>(tool: T, toTransfer: (input: Parameters<NonNullable<T["execute"]>>[0]) => PreflightTransfer | undefined, options: WithPreflightOptions = {}): T {
  const execute = tool.execute as ((input: unknown, ...rest: unknown[]) => unknown) | undefined;
  if (execute === undefined) return tool;
  const state: WarnState = { warned: false };
  const wrapped = async (input: unknown, ...rest: unknown[]) => {
    const skip = typeof input === "object" && input !== null && (input as Record<string, unknown>)["skip_preflight"] === true;
    const clean = skip ? Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([k]) => k !== "skip_preflight")) : input;
    const answer = skip ? undefined : await check(toTransfer(clean as never), options, state);
    if (answer !== undefined && options.stopOnSaving === true && answer.outcome === "SAVING_FOUND") {
      return { status: "RECTA_SAVING_FOUND", recta_preflight: preflightSummary(answer), note: "Recta proved a cheaper route; the bridge was not called. Sign recta_preflight.execute_via_recta.body_to_sign to get it, or call this tool again with skip_preflight: true to bridge anyway." };
    }
    const result = await execute.call(tool, clean, ...rest);
    if (answer === undefined || typeof result !== "object" || result === null || Array.isArray(result)) return result;
    return { ...(result as Record<string, unknown>), recta_preflight: preflightSummary(answer) };
  };
  return { ...tool, execute: wrapped } as T;
}
