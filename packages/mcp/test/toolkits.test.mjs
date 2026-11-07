// The AgentKit and GOAT adapters, with stand-in wallets shaped like the real ones (checked against @coinbase/agentkit
// 0.10.4 and @goat-sdk/core 0.5.0 when they were written). Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signedRequestMessage } from "@recta/client";
import { agentKitSigner, rectaActionProvider } from "../dist/agentkit.js";
import { recta } from "../dist/goat.js";
import { TOOLS } from "../dist/server.js";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const args = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "100", baseline_provider: "stargate_v2" };

function fakeFetch() {
  const calls = [];
  const f = async (url, init) => {
    if (String(url).endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    calls.push({ url: new URL(String(url)), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
    return new Response(JSON.stringify({ result_id: "r_test", decision: { state: "VERIFIED_ZERO" } }), { status: 200 });
  };
  return { f, calls };
}

function agentKitWallet({ chainId = "8453", code = "0x", sent = [] } = {}) {
  return {
    getAddress: () => account.address,
    getNetwork: () => ({ protocolFamily: "evm", chainId }),
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td),
    sendTransaction: async (tx) => { sent.push(tx); return `0x${"ab".repeat(32)}`; },
    waitForTransactionReceipt: async () => ({ status: "success" }),
    getPublicClient: () => ({ estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }), getCode: async () => code }),
  };
}

async function recovers(call) {
  const h = call.headers;
  const message = signedRequestMessage({ method: call.method, path: call.url.pathname, idempotencyKey: h["idempotency-key"] ?? "", bodyKeccak256: keccak256(call.body ?? new Uint8Array()), issuedAt: Number(h["x-recta-issued-at"]) });
  return (await recoverMessageAddress({ message, signature: h["x-recta-signature"] })) === account.address;
}

test("the local MCP server lists the unsigned trial with the evaluation's arguments", () => {
  const trial = TOOLS.find((t) => t.name === "recta_trial_evaluation");
  const evaluate = TOOLS.find((t) => t.name === "recta_evaluate");
  assert.ok(trial);
  assert.deepEqual(trial.inputSchema, evaluate.inputSchema);
});

test("AgentKit: read-only actions by default, a signed evaluation from the wallet, the trial unsigned", async () => {
  const { f, calls } = fakeFetch();
  const provider = rectaActionProvider({ limits, fetch: f });
  assert.equal(provider.supportsNetwork({ protocolFamily: "evm", chainId: "8453" }), true);
  assert.equal(provider.supportsNetwork({ protocolFamily: "svm" }), false);
  const actions = provider.getActions(agentKitWallet());
  assert.deepEqual(actions.map((a) => a.name).sort(), ["recta_evaluate", "recta_fit", "recta_ledger", "recta_preview", "recta_report", "recta_trial_evaluation"]);
  const by = Object.fromEntries(actions.map((a) => [a.name, a]));
  assert.throws(() => by.recta_evaluate.schema.parse({ source_network: "base" }));

  await by.recta_evaluate.invoke(by.recta_evaluate.schema.parse(args));
  const signed = calls.at(-1);
  assert.equal(signed.url.pathname, "/v1/golden-corridor/commercial-evaluations");
  assert.ok(await recovers(signed));
  const body = JSON.parse(new TextDecoder().decode(signed.body));
  assert.equal(body.sender, account.address);
  assert.equal(body.execution_authority.source_max_fee_per_gas_wei, "14000000");

  await by.recta_trial_evaluation.invoke(args);
  const trial = calls.at(-1);
  assert.equal(trial.url.pathname, "/v1/golden-corridor/trial-evaluation");
  assert.equal(trial.headers["x-recta-signature"], undefined);
  assert.deepEqual(JSON.parse(trial.body), body);
});

test("AgentKit: a route from another chain is refused before any request", async () => {
  const { f, calls } = fakeFetch();
  const by = Object.fromEntries(rectaActionProvider({ limits, fetch: f }).getActions(agentKitWallet()).map((a) => [a.name, a]));
  const out = JSON.parse(await by.recta_trial_evaluation.invoke({ ...args, source_network: "arbitrum", destination_network: "base" }));
  assert.equal(out.check, "source_network");
  assert.equal(calls.length, 0);
});

test("AgentKit: execution tools only when enabled, and never from a smart account", async () => {
  const { f } = fakeFetch();
  const names = rectaActionProvider({ limits, fetch: f, allowExecute: true }).getActions(agentKitWallet()).map((a) => a.name);
  assert.ok(names.includes("recta_execute") && names.includes("recta_pay_debt"));
  const tx = { chainId: 8453, to: `0x${"33".repeat(20)}`, data: "0x", value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  const sent = [];
  await assert.rejects(agentKitSigner(agentKitWallet({ code: "0x6080604052", sent })).sendTransaction(tx), /EOA wallet provider only/);
  await assert.rejects(agentKitSigner(agentKitWallet({ sent })).sendTransaction({ ...tx, chainId: 42161 }), /on chain 8453/);
  assert.equal(sent.length, 0);
  await agentKitSigner(agentKitWallet({ code: `0xef0100${"22".repeat(20)}`, sent })).sendTransaction(tx);
  await agentKitSigner(agentKitWallet({ sent })).sendTransaction(tx);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], { to: tx.to, data: tx.data, value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, type: "eip1559" });
});

test("GOAT: evaluation tools only, signed with the GOAT wallet, never sending", async () => {
  const { f, calls } = fakeFetch();
  const plugin = recta({ limits, fetch: f, estimateFeesPerGas: async () => ({ maxFeePerGas: 9_000_000n, maxPriorityFeePerGas: 1_000_000n }) });
  assert.equal(plugin.supportsChain({ type: "evm", id: 8453 }), true);
  assert.equal(plugin.supportsChain({ type: "solana" }), false);
  const goatWallet = {
    getAddress: () => account.address,
    getChain: () => ({ type: "evm", id: 8453 }),
    signMessage: async (message) => ({ signature: await account.signMessage({ message }) }),
    signTypedData: async (td) => ({ signature: await account.signTypedData(td) }),
  };
  const tools = plugin.getTools(goatWallet);
  assert.deepEqual(tools.map((t) => t.name).sort(), ["recta_evaluate", "recta_fit", "recta_ledger", "recta_preview", "recta_report", "recta_trial_evaluation"]);
  const evaluate = tools.find((t) => t.name === "recta_evaluate");
  await evaluate.execute(evaluate.parameters.parse(args));
  assert.ok(await recovers(calls.at(-1)));
  assert.equal(JSON.parse(new TextDecoder().decode(calls.at(-1).body)).execution_authority.source_max_fee_per_gas_wei, "18000000");
});
