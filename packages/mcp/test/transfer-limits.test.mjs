// The operator's transfer limits (RECTA_MAX_AMOUNT, RECTA_ALLOWED_RECIPIENTS): an agent talked into a larger transfer,
// or into one to someone else's address, is refused before anything is signed. Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { checkTransfer, configFromEnv, DEFAULT_MAX_AMOUNT, keylessSigner } from "../dist/index.js";
import { createLocalServer } from "../dist/server.js";
import { metaMaskRectaServer } from "../dist/metamask.js";
import { COMMAND_SPECS, runCommand } from "../dist/mm/specs.js";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const wallet = account.address;
const friend = `0x${"Ab".repeat(20)}`;
const stranger = `0x${"cd".repeat(20)}`;
const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const args = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "100", baseline_provider: "stargate_v2" };

function server(transfer) {
  const calls = [];
  const signed = [];
  const f = async (url, init) => {
    if (String(url).endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ result_id: "r_1", decision: { state: "VERIFIED_ZERO" } }), { status: 200 });
  };
  const signer = { ...keylessSigner(wallet), signMessage: async (m) => { signed.push(m); return account.signMessage({ message: m }); } };
  const s = createLocalServer({ signer, chain: { waitForSuccess: async () => true, readFeeFunds: async () => { throw new Error("unused"); } }, limits, allowExecute: true, fetch: f, gasCapsFor: async () => [7_000_000n, 1_000_000n], ...(transfer === undefined ? {} : { transfer }) });
  return { s, calls, signed };
}

test("configFromEnv: 1000 whole tokens and the wallet only by default; malformed values stop the server", () => {
  const c = configFromEnv({});
  assert.equal(DEFAULT_MAX_AMOUNT, "1000");
  assert.equal(c.maxAmount, "1000");
  assert.deepEqual(c.allowedRecipients, []);
  const set = configFromEnv({ RECTA_MAX_AMOUNT: "250.5", RECTA_ALLOWED_RECIPIENTS: ` ${friend} , ${stranger}` });
  assert.equal(set.maxAmount, "250.5");
  assert.deepEqual(set.allowedRecipients, [friend.toLowerCase(), stranger.toLowerCase()]);
  for (const bad of ["0", "1e6", "-5", "lots", "1,000"]) assert.throws(() => configFromEnv({ RECTA_MAX_AMOUNT: bad }), /RECTA_MAX_AMOUNT/, bad);
  for (const bad of ["alice.eth", `${friend};${stranger}`, "0x12"]) assert.throws(() => configFromEnv({ RECTA_ALLOWED_RECIPIENTS: bad }), /RECTA_ALLOWED_RECIPIENTS/, bad);
});

test("checkTransfer: the cap is inclusive and exact to 18 decimals; the wallet itself is always allowed", () => {
  const l = { maxAmount: "1000", allowedRecipients: [friend.toLowerCase()] };
  checkTransfer(l, { amount: "1000", sender: wallet, recipient: wallet });
  checkTransfer(l, { amount: "999.999999999999999999", sender: wallet, recipient: friend.toUpperCase().replace("0X", "0x") });
  assert.throws(() => checkTransfer(l, { amount: "1000.000000000000000001", sender: wallet, recipient: wallet }), (e) => e.check === "amount_limit");
  assert.throws(() => checkTransfer(l, { amount: "1e3", sender: wallet, recipient: wallet }), (e) => e.check === "amount");
  assert.throws(() => checkTransfer(l, { amount: "5", sender: wallet, recipient: stranger }), (e) => e.check === "recipient_not_allowed");
  assert.throws(() => checkTransfer(l, { amount: "5", sender: wallet, recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }), (e) => e.check === "recipient_not_allowed");
});

test("recta_evaluate: above the cap or to an unlisted recipient is refused before any signature or request", async () => {
  const { s, calls, signed } = server({ maxAmount: "1000", allowedRecipients: [friend.toLowerCase()] });
  await assert.rejects(s.call("recta_evaluate", { ...args, amount: "1000.5" }), (e) => e.check === "amount_limit" && /nothing was signed/.test(e.message));
  await assert.rejects(s.call("recta_evaluate", { ...args, recipient: stranger }), (e) => e.check === "recipient_not_allowed");
  assert.equal(signed.length, 0);
  assert.equal(calls.length, 0);
  // The wallet itself (the default) and a listed address go through, signed.
  await s.call("recta_evaluate", args);
  await s.call("recta_evaluate", { ...args, recipient: friend });
  assert.equal(signed.length, 2);
  assert.equal(JSON.parse(new TextDecoder().decode(calls.at(-1).init.body)).recipient, friend);
});

test("the MCP error names the check, so the agent sees why it was refused", async () => {
  const { s } = server({ maxAmount: "1000", allowedRecipients: [] });
  const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recta_evaluate", arguments: { ...args, recipient: stranger } } });
  assert.equal(r.result.isError, true);
  assert.equal(JSON.parse(r.result.content[0].text).check, "recipient_not_allowed");
});

test("the trial signs and moves nothing, so the limits do not apply to it; without limits nothing is checked", async () => {
  const limited = server({ maxAmount: "10", allowedRecipients: [] });
  await limited.s.call("recta_trial_evaluation", { ...args, amount: "5000", recipient: stranger });
  assert.equal(limited.signed.length, 0);
  const open = server(undefined);
  await open.s.call("recta_evaluate", { ...args, amount: "5000", recipient: stranger });
  assert.equal(open.signed.length, 1);
});

test("metaMaskRectaServer carries the limits; mm recta move takes --max-amount and --allowed-recipients, default 1000 and the wallet", async () => {
  const call = metaMaskRectaServer({ keyless: false, address: wallet, execute: async () => { throw new Error("must not be asked"); }, publicClientFor: () => ({}), limits: { ...limits, maxFeePerGasWei: 1n, maxPriorityFeePerGasWei: 1n, maxAmount: "50", allowedRecipients: [] }, allowExecute: false, fetch: async () => { throw new Error("must not fetch"); } });
  const out = await call("recta_evaluate", { ...args, amount: "51" });
  assert.equal(out.isError, true);
  assert.equal(out.body.check, "amount_limit");

  const move = COMMAND_SPECS.find((c) => c.id === "recta:move");
  for (const flag of ["max-amount", "allowed-recipients"]) assert.ok(move.inputs.some((i) => i.flag === flag), flag);
  const route = { "source-network": "base", "source-asset": "USDC", "destination-network": "arbitrum", "baseline-provider": "stargate_v2", execute: false };
  const asked = [];
  const ctx = {
    walletStateManager: { read: () => ({ byokWallets: [{ id: "w1", address: wallet, namespace: "eip155" }], selectedWallet: { namespace: "eip155", ref: { id: "w1" } } }) },
    publicClient: () => ({ estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }) }),
    walletExecutor: async () => async (request) => { asked.push(request.kind); throw new Error("must not be asked"); },
  };
  const f = async () => { throw new Error("must not fetch"); };
  const refused = (check) => (e) => e.body?.check === check && /nothing was signed/.test(e.body.message);
  await assert.rejects(runCommand(move, ctx, {}, { ...route, amount: "1000.01" }, f), refused("amount_limit"));
  await assert.rejects(runCommand(move, ctx, {}, { ...route, amount: "100", recipient: stranger }, f), refused("recipient_not_allowed"));
  await assert.rejects(runCommand(move, ctx, {}, { ...route, amount: "100", "max-amount": "99" }, f), refused("amount_limit"));
  // A listed recipient passes the limits and goes on to Recta (which this test's fetch refuses).
  await assert.rejects(runCommand(move, ctx, {}, { ...route, amount: "100", recipient: stranger, "allowed-recipients": stranger }, f), /must not fetch/);
  await assert.rejects(runCommand(move, ctx, {}, { ...route, amount: "100", "max-amount": "none" }, f), /--max-amount must be/);
  assert.deepEqual(asked, []);
});
