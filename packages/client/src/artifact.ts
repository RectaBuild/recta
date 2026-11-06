import { decodeFunctionData, padHex, parseAbi, parseUnits, type Hex } from "viem";
import { EXECUTION_ARTIFACT_SCHEMA } from "./constants.js";
import { RectaCheckError } from "./errors.js";
import { PINNED_ROUTES, type PinnedRoute } from "./pinned-routes.js";
import type { RectaTransaction } from "./signer.js";

const APPROVE_ABI = parseAbi(["function approve(address spender, uint256 amount)"]);
const ACROSS_DEPOSIT_ABI = parseAbi([
  "function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)",
]);
const CCTP_DEPOSIT_FOR_BURN_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
]);
const OFT_SEND_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "function send(SendParam _sendParam, MessagingFee _fee, address _refundAddress) payable",
]);

const UINT = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_WORD = `0x${"0".repeat(64)}`;
const word = (a: string): string => padHex(a.toLowerCase() as Hex, { size: 32 }).toLowerCase();
const same = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** The fields of the evaluation request this package checks the artifact against. */
export interface EvaluationRequestView {
  readonly source_network: string;
  readonly source_asset: string;
  readonly destination_network: string;
  readonly destination_asset?: string;
  readonly amount: string;
  readonly sender: string;
  readonly recipient: string;
  readonly execution_authority?: { readonly source_max_fee_per_gas_wei?: string; readonly source_max_priority_fee_per_gas_wei?: string };
}

export interface ArtifactLimits {
  readonly signer: string;
  readonly nowUnix: bigint;
  /** The most native value (wei) this agent agrees to attach to one transaction (LayerZero-based routes pay their
   *  messaging fee this way; Across and CCTP attach none). */
  readonly maxNativeValueWei: bigint;
  /** The least the recipient must be guaranteed to receive, in basis points of the amount sent (e.g. 9950 = 99.5 %):
   *  Across's `outputAmount`, CCTP's amount minus its `maxFee`, LayerZero's `minAmountLD`. Required. */
  readonly minOutputBps: number;
}

export interface CheckedArtifact {
  readonly resultId: string;
  readonly transactions: readonly (RectaTransaction & { readonly role: "APPROVAL" | "EXECUTION" })[];
}

/** The pinned route of a request's corridor, or a refusal. */
export function pinnedRouteOf(request: Pick<EvaluationRequestView, "source_network" | "source_asset" | "destination_network" | "destination_asset">): PinnedRoute {
  const key = `${request.source_network}:${request.source_asset}>${request.destination_network}:${request.destination_asset ?? request.source_asset}`;
  const route = Object.hasOwn(PINNED_ROUTES, key) ? PINNED_ROUTES[key] : undefined;
  if (route === undefined) throw new RectaCheckError("corridor", `${key} is not an EVM corridor this release of the package knows`);
  return route;
}

/**
 * Checks every transaction of an execution artifact before any is sent, against the request the agent made and the
 * route table pinned in this package (generated from Recta's server configuration; a served wallet policy never adds
 * to it):
 *  - the artifact is Recta's, of this decision, and not expired; approvals come first and there is exactly one execution;
 *  - every transaction is EIP-1559 with an empty access list, on the source chain, from the signer, within the request's
 *    own gas price ceilings;
 *  - an approval is `approve` of the pinned source token to a pinned contract of the corridor, for exactly the transfer
 *    amount, and its spender is the contract the execution calls;
 *  - the execution calls a pinned contract of the corridor and decodes as that contract's protocol call (Across
 *    `deposit`, CCTP V2 `depositForBurn`, LayerZero OFT/Stargate `send`) naming the request's sender, recipient, source
 *    token and exact amount, the pinned destination (Across chain id and output token, CCTP domain with any caller, OFT
 *    endpoint id), and a guaranteed output of at least `minOutputBps` of the amount; its native value is the one the
 *    call declares, within the agent's limit.
 * Anything else is refused.
 */
export function checkExecutionArtifact(artifact: unknown, args: {
  readonly resultId: string;
  readonly request: EvaluationRequestView;
  readonly limits: ArtifactLimits;
}): CheckedArtifact {
  const fail = (check: string, message: string): never => { throw new RectaCheckError(check, message); };
  const { request, limits } = args;
  if (!Number.isInteger(limits.minOutputBps) || limits.minOutputBps < 1 || limits.minOutputBps > 10_000) fail("limits", "minOutputBps must be an integer from 1 to 10000");
  const a = typeof artifact === "object" && artifact !== null ? (artifact as Record<string, unknown>) : fail("artifact", "the artifact is not an object");
  if (a["schema"] !== EXECUTION_ARTIFACT_SCHEMA) fail("artifact", `the artifact schema is ${String(a["schema"])}, not ${EXECUTION_ARTIFACT_SCHEMA}`);
  if (a["result_id"] !== args.resultId) fail("artifact", "the artifact belongs to another decision");
  const expiry = typeof a["commercial_expiry_unix"] === "string" && UINT.test(a["commercial_expiry_unix"]) ? BigInt(a["commercial_expiry_unix"]) : fail("artifact", "commercial_expiry_unix is not an integer");
  if (expiry <= limits.nowUnix) fail("artifact_expired", "the decision's commercial expiry has passed");

  const signer = limits.signer.toLowerCase();
  if (!same(request.sender, signer)) fail("sender", "the request's sender is not the signer");
  if (!ADDRESS.test(request.recipient)) fail("recipient", "this version only checks EVM recipients (0x addresses)");
  const route = pinnedRouteOf(request);
  const amount = parseUnits(request.amount, route.source_decimals);
  const minimum = { amount, bps: BigInt(limits.minOutputBps), route };
  const maxFee = request.execution_authority?.source_max_fee_per_gas_wei;
  const maxPriority = request.execution_authority?.source_max_priority_fee_per_gas_wei;

  const raw = Array.isArray(a["transactions"]) ? (a["transactions"] as unknown[]) : fail("artifact", "transactions is not a list");
  const out: (RectaTransaction & { role: "APPROVAL" | "EXECUTION" })[] = [];
  let executionTo: string | undefined;
  const approvalSpenders: string[] = [];
  for (const [i, item] of raw.entries()) {
    const t = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : fail("transaction", `transaction ${i} is not an object`);
    if (t["role"] !== "APPROVAL" && t["role"] !== "EXECUTION") fail("transaction", `transaction ${i} has role ${String(t["role"])}`);
    const role = t["role"] as "APPROVAL" | "EXECUTION";
    if (executionTo !== undefined) fail("transaction_order", role === "APPROVAL" ? "an approval follows the execution" : "more than one execution");
    if (t["transaction_type"] !== "EIP1559" || !Array.isArray(t["access_list"]) || (t["access_list"] as unknown[]).length !== 0) fail("transaction_type", `transaction ${i} is not EIP-1559 with an empty access list`);
    const n = (k: string): bigint => (typeof t[k] === "string" && UINT.test(t[k] as string) ? BigInt(t[k] as string) : fail("transaction", `transaction ${i}: ${k} is not an integer`));
    if (n("chain_id") !== BigInt(route.source_chain_id)) fail("transaction_chain", `transaction ${i} is not on ${request.source_network} (${route.source_chain_id})`);
    if (!same(t["from"], signer)) fail("transaction_from", `transaction ${i} is not from the signer`);
    const to = typeof t["to"] === "string" && ADDRESS.test(t["to"]) ? t["to"].toLowerCase() : fail("transaction", `transaction ${i}: to is not an address`);
    const data = typeof t["data"] === "string" && /^0x([0-9a-fA-F]{2})*$/.test(t["data"]) ? (t["data"] as Hex) : fail("transaction", `transaction ${i}: data is not hex`);
    const value = n("value_wei");
    const fee = n("max_fee_per_gas_wei");
    const priority = n("max_priority_fee_per_gas_wei");
    if (maxFee !== undefined && fee > BigInt(maxFee)) fail("transaction_gas_price", `transaction ${i} pays more per gas than the request allows`);
    if (maxPriority !== undefined && priority > BigInt(maxPriority)) fail("transaction_gas_price", `transaction ${i} tips more per gas than the request allows`);

    if (role === "APPROVAL") {
      if (to !== route.source_token || value !== 0n) fail("approval", `transaction ${i} is not an approval on the source token`);
      const d = (() => { try { return decodeFunctionData({ abi: APPROVE_ABI, data }); } catch { return fail("approval", `transaction ${i} is not approve(spender, amount)`); } })();
      const spender = d.args[0].toLowerCase();
      if (!route.contracts.some((c) => c.address === spender)) fail("approval_spender", `transaction ${i} approves ${spender}, which is not a pinned contract of this corridor`);
      if (d.args[1] !== amount) fail("approval_amount", `transaction ${i} approves ${d.args[1]}, not exactly the transfer amount ${amount}`);
      approvalSpenders.push(spender);
    } else {
      const candidates = route.contracts.filter((c) => c.address === to);
      if (candidates.length === 0) fail("execution_target", `the execution calls ${to}, which is not a pinned contract of this corridor`);
      checkExecutionCall(data, value, candidates, { token: route.source_token, sender: signer, recipient: request.recipient, maxNativeValueWei: limits.maxNativeValueWei, minimum });
      executionTo = to;
    }
    out.push({ role, chainId: route.source_chain_id, to: to as Hex, data, value, gas: n("gas_limit"), maxFeePerGas: fee, maxPriorityFeePerGas: priority });
  }
  if (executionTo === undefined) fail("transaction_order", "the artifact has no execution");
  if (approvalSpenders.some((s) => s !== executionTo)) fail("approval_spender", "an approval's spender is not the contract the execution calls");
  return { resultId: args.resultId, transactions: out };
}

/** The least output allowed, in output-token units: ⌈amount · bps / 10 000⌉ scaled from source to output decimals. */
function minimumOutput(m: { amount: bigint; bps: bigint; route: PinnedRoute }, inOutputUnits: boolean): bigint {
  const inSource = (m.amount * m.bps + 9_999n) / 10_000n;
  if (!inOutputUnits) return inSource;
  const d = m.route.output_decimals - m.route.source_decimals;
  return d >= 0 ? inSource * 10n ** BigInt(d) : (inSource + 10n ** BigInt(-d) - 1n) / 10n ** BigInt(-d);
}

function checkExecutionCall(data: Hex, value: bigint, candidates: readonly PinnedRoute["contracts"][number][], e: {
  token: string; sender: string; recipient: string; maxNativeValueWei: bigint; minimum: { amount: bigint; bps: bigint; route: PinnedRoute };
}): void {
  const fail = (check: string, message: string): never => { throw new RectaCheckError(check, message); };
  const amount = e.minimum.amount;
  const destinations = (protocol: string) => candidates.filter((c) => c.protocol === protocol).map((c) => c.destination_id);
  const decode = <A extends readonly unknown[]>(abi: A) => { try { return decodeFunctionData({ abi: abi as never, data }) as { functionName: string; args: readonly unknown[] }; } catch { return undefined; } };

  const across = destinations("across").length > 0 ? decode(ACROSS_DEPOSIT_ABI) : undefined;
  if (across !== undefined) {
    const [depositor, recipient, inputToken, outputToken, inputAmount, outputAmount, destinationChainId, , , , , message] = across.args as [string, string, string, string, bigint, bigint, bigint, string, number, number, number, string];
    if (depositor.toLowerCase() !== word(e.sender) || recipient.toLowerCase() !== word(e.recipient)) fail("execution_parties", "the Across deposit does not name the request's sender and recipient");
    if (inputToken.toLowerCase() !== word(e.token) || inputAmount !== amount) fail("execution_amount", "the Across deposit is not the request's token and amount");
    if (!destinations("across").some((id) => BigInt(id) === destinationChainId)) fail("execution_destination", `the Across deposit goes to chain ${destinationChainId}, not the request's destination`);
    if (outputToken.toLowerCase() !== word(e.minimum.route.output_token)) fail("execution_destination", "the Across deposit's output token is not the request's destination token");
    if (message !== "0x") fail("execution_destination", "the Across deposit carries a message (the recipient would run it as a handler)");
    if (outputAmount < minimumOutput(e.minimum, true)) fail("execution_min_output", `the Across deposit guarantees ${outputAmount}, less than your minimum`);
    if (value !== 0n) fail("execution_value", "the Across deposit attaches native value");
    return;
  }
  const cctp = destinations("cctp_v2").length > 0 ? decode(CCTP_DEPOSIT_FOR_BURN_ABI) : undefined;
  if (cctp !== undefined) {
    const [burnAmount, domain, mintRecipient, burnToken, destinationCaller, maxFee] = cctp.args as [bigint, number, string, string, string, bigint];
    if (mintRecipient.toLowerCase() !== word(e.recipient)) fail("execution_parties", "the CCTP burn does not mint to the request's recipient");
    if (!same(burnToken, e.token) || burnAmount !== amount) fail("execution_amount", "the CCTP burn is not the request's token and amount");
    if (!destinations("cctp_v2").includes(domain)) fail("execution_destination", `the CCTP burn goes to domain ${domain}, not the request's destination`);
    if (destinationCaller.toLowerCase() !== ZERO_WORD) fail("execution_destination", "the CCTP burn restricts who may complete it");
    if (maxFee >= burnAmount || burnAmount - maxFee < minimumOutput(e.minimum, true)) fail("execution_min_output", "the CCTP burn's max fee leaves less than your minimum");
    if (value !== 0n) fail("execution_value", "the CCTP burn attaches native value");
    return;
  }
  const oft = destinations("oft").length > 0 ? decode(OFT_SEND_ABI) : undefined;
  if (oft !== undefined) {
    const [param, fee, refund] = oft.args as [{ dstEid: number; to: string; amountLD: bigint; minAmountLD: bigint; extraOptions: string; composeMsg: string; oftCmd: string }, { nativeFee: bigint; lzTokenFee: bigint }, string];
    if (param.to.toLowerCase() !== word(e.recipient) || !same(refund, e.sender)) fail("execution_parties", "the OFT send does not name the request's recipient and refund the sender");
    if (param.amountLD !== amount) fail("execution_amount", "the OFT send is not the request's amount");
    if (!destinations("oft").includes(param.dstEid)) fail("execution_destination", `the OFT send goes to endpoint ${param.dstEid}, not the request's destination`);
    // Recta's own OFT routes are plain sends: no executor options (which could add a native drop to another address),
    // no compose message, no OFT command.
    if (param.composeMsg !== "0x") fail("execution_destination", "the OFT send carries a compose message");
    if (param.extraOptions !== "0x") fail("execution_destination", "the OFT send carries executor options");
    if (param.oftCmd !== "0x") fail("execution_destination", "the OFT send carries an OFT command");
    if (param.minAmountLD < minimumOutput(e.minimum, false)) fail("execution_min_output", `the OFT send guarantees ${param.minAmountLD}, less than your minimum`);
    if (fee.lzTokenFee !== 0n || fee.nativeFee !== value) fail("execution_value", "the OFT send's native fee is not the value it attaches");
    if (value > e.maxNativeValueWei) fail("execution_value_limit", `the OFT send attaches ${value} wei, more than your limit ${e.maxNativeValueWei}`);
    return;
  }
  fail("execution_call", "the execution is not the reviewed call of this contract (Across deposit, CCTP V2 depositForBurn, OFT send)");
}
