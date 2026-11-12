// The elizaOS plugin, against the elizaOS 2.x action shape (checked against @elizaos/core 2.0.5: Action.parameters,
// handler(runtime, message, state, options, callback) with options.parameters, ActionResult). Run after the build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rectaElizaPlugin, rectaPlugin } from "../dist/elizaos.js";
import defaultPlugin from "../dist/elizaos.js";

const addr = `0x${"Ab".repeat(20)}`;
const other = `0x${"Cd".repeat(20)}`;
const args = { source_network: "ethereum", source_asset: "USDC", destination_network: "arbitrum", amount: "10000", baseline_provider: "lifi" };

function plugin(extra = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ status: "SAVING_FOUND", saving_lower_bound_usdc: "4.4" }), { status: 200 });
  };
  const p = rectaElizaPlugin({ fetch, estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }), ...extra });
  const action = (name) => p.actions.find((a) => a.name === name);
  return { p, calls, action };
}

const runtime = (settings = {}) => ({ getSetting: (k) => settings[k] });

test("only the two free actions, with parameters from the MCP schemas", () => {
  const { p, action } = plugin();
  assert.equal(p.name, "recta");
  assert.deepEqual(p.actions.map((a) => a.name).sort(), ["RECTA_FIT", "RECTA_TRIAL_EVALUATION"]);
  const trial = action("RECTA_TRIAL_EVALUATION");
  const required = trial.parameters.filter((x) => x.required).map((x) => x.name).sort();
  assert.deepEqual(required, ["amount", "baseline_provider", "destination_network", "source_asset", "source_network"]);
  assert.ok(trial.parameters.some((x) => x.name === "sender" && !x.required));
  assert.deepEqual(trial.parameters.find((x) => x.name === "latency_class").schema.enum, ["SECONDS", "MINUTES", "FINALITY_BOUND", "ANY"]);
  assert.match(trial.routingHint, /never moves funds/);
  assert.equal(rectaPlugin.actions.length, 2);
  assert.equal(defaultPlugin, rectaPlugin);
});

test("trial: unsigned, sender from RECTA_ADDRESS, gas caps committed, callback gets the answer", async () => {
  const { calls, action } = plugin();
  const said = [];
  const r = await action("RECTA_TRIAL_EVALUATION").handler(runtime({ RECTA_ADDRESS: addr }), {}, undefined, { parameters: args }, async (c) => { said.push(c); return []; });
  assert.equal(r.success, true);
  assert.equal(r.data.status, "SAVING_FOUND");
  assert.equal(said.length, 1);
  assert.deepEqual(said[0].actions, ["RECTA_TRIAL_EVALUATION"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/golden-corridor\/trial-evaluation$/);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-recta-signature"), null);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.sender, addr);
  assert.equal(body.recipient, addr);
  assert.equal(body.baseline_provider, "lifi");
  assert.equal(body.execution_authority.source_max_fee_per_gas_wei, "14000000");
  assert.equal(body.execution_authority.source_max_priority_fee_per_gas_wei, "1000000");
});

test("trial: the call's sender wins; no sender at all is refused before any request", async () => {
  const { calls, action } = plugin();
  const trial = action("RECTA_TRIAL_EVALUATION");
  const r = await trial.handler(runtime(), {}, undefined, { parameters: args });
  assert.equal(r.success, false);
  assert.match(r.text, /CHECK_FAILED/);
  assert.equal(calls.length, 0);
  await trial.handler(runtime({ RECTA_ADDRESS: addr }), {}, undefined, { parameters: { ...args, sender: other } });
  assert.equal(JSON.parse(calls[0].init.body).sender, other);
});

test("missing or absent parameters (elizaOS 1.x passes none) never reach Recta", async () => {
  const { calls, action } = plugin({ address: addr });
  const trial = action("RECTA_TRIAL_EVALUATION");
  const none = await trial.handler(runtime(), {}, undefined, undefined);
  assert.equal(none.success, false);
  assert.equal(none.error, "MISSING_PARAMETERS");
  const { amount, ...rest } = args;
  const partial = await trial.handler(runtime(), {}, undefined, { parameters: rest });
  assert.equal(partial.success, false);
  assert.match(partial.text, /amount/);
  assert.equal(calls.length, 0);
});

test("a malformed address is refused, as an option and as a setting, and never signs", async () => {
  assert.throws(() => rectaElizaPlugin({ address: "alice.eth" }), /EVM address/);
  const { calls, action } = plugin();
  const r = await action("RECTA_TRIAL_EVALUATION").handler(runtime({ RECTA_ADDRESS: "0x12" }), {}, undefined, { parameters: args });
  assert.equal(r.success, false);
  assert.match(r.text, /RECTA_ADDRESS/);
  assert.equal(calls.length, 0);
});

test("fit: free GET with the corridor, no sender needed", async () => {
  const { calls, action } = plugin();
  const r = await action("RECTA_FIT").handler(runtime(), {}, undefined, { parameters: { source_network: "base", source_asset: "USDC", destination_network: "arbitrum" } });
  assert.equal(r.success, true);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v1/golden-corridor/fit");
  assert.equal(u.searchParams.get("destination_asset"), "USDC");
  assert.equal(calls[0].init.method ?? "GET", "GET");
});
