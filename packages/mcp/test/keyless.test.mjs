// ASTRA T5: without RECTA_PRIVATE_KEY the local server runs the free tools only, and never signs.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { configFromEnv, keylessSigner } from "../dist/index.js";
import { createLocalServer } from "../dist/server.js";

const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const args = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "100", baseline_provider: "stargate_v2" };
const addr = `0x${"Ab".repeat(20)}`;

function keyless(address) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ status: "TRIAL" }), { status: 200 }); };
  const server = createLocalServer({ signer: keylessSigner(address), chain: { waitForSuccess: async () => true, readFeeFunds: async () => { throw new Error("unused"); } }, limits, allowExecute: false, keyless: true, fetch: f, gasCapsFor: async () => [7_000_000n, 1_000_000n] });
  return { server, calls };
}

test("configFromEnv: no key is allowed and turns execution off; a malformed key or address still stops the server", () => {
  const c = configFromEnv({ RECTA_ALLOW_EXECUTE: "yes" });
  assert.equal(c.privateKey, undefined);
  assert.equal(c.allowExecute, false);
  assert.equal(configFromEnv({ RECTA_PRIVATE_KEY: "" }).privateKey, undefined);
  assert.equal(configFromEnv({ RECTA_ADDRESS: addr }).address, addr);
  assert.throws(() => configFromEnv({ RECTA_PRIVATE_KEY: "0x1234" }), /RECTA_PRIVATE_KEY/);
  assert.throws(() => configFromEnv({ RECTA_ADDRESS: "alice.eth" }), /RECTA_ADDRESS/);
  assert.equal(configFromEnv({ RECTA_PRIVATE_KEY: `0x${"11".repeat(32)}`, RECTA_ALLOW_EXECUTE: "yes" }).allowExecute, true);
});

test("keyless: tools/list offers only recta_fit and recta_trial_evaluation", async () => {
  const { server } = keyless(undefined);
  const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(r.result.tools.map((t) => t.name).sort(), ["recta_fit", "recta_trial_evaluation"]);
  const init = await server.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  assert.match(init.result.instructions, /without a key/);
});

test("keyless: every other tool is refused before any request", async () => {
  const { server, calls } = keyless(addr);
  for (const name of ["recta_evaluate", "recta_preview", "recta_execute", "recta_pay_debt", "recta_ledger", "recta_fee_funds", "recta_approve_fee", "recta_report"]) {
    await assert.rejects(server.call(name, { ...args, result_id: "r", origin_tx_hash: `0x${"aa".repeat(32)}` }), (e) => e.check === "no_key");
  }
  assert.equal(calls.length, 0);
});

test("keyless trial: the sender comes from the call or RECTA_ADDRESS, never the zero address, and nothing is signed", async () => {
  const none = keyless(undefined);
  await assert.rejects(none.server.call("recta_trial_evaluation", args), (e) => e.check === "sender");
  await assert.rejects(none.server.call("recta_trial_evaluation", { ...args, sender: "0x12" }), (e) => e.check === "input");
  assert.equal(none.calls.length, 0);
  await none.server.call("recta_trial_evaluation", { ...args, sender: addr });
  let body = JSON.parse(none.calls.at(-1).init.body);
  assert.equal(body.sender, addr);
  assert.equal(body.recipient, addr);
  assert.equal(none.calls.at(-1).init.headers["x-recta-signature"], undefined);

  const env = keyless(addr);
  await env.server.call("recta_trial_evaluation", args);
  body = JSON.parse(env.calls.at(-1).init.body);
  assert.equal(body.sender, addr);
  await assert.rejects(keylessSigner(addr).signMessage("x"), (e) => e.check === "no_key");
});
