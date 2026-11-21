// withPreflight and friends (BIT-OPS-190 in route-hint): Recta Preflight in front of the bridge an agent already calls.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight, withPreflight, withPreflightTool, lifiTransfer, transferFromChainTokens, decimalAmount, RectaSavingFoundError, PreflightInputError, preflightBody, PREFLIGHT_USER_AGENT, pins } from "../dist/index.js";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SAVING = { outcome: "SAVING_FOUND", saving_usdc: "2.390133", your_route: { provider: "lifi" }, via_recta: { total_cost_usdc: "0.1" }, execute_via_recta: { body_to_sign: {} }, message: "m" };

function fakeFetch(answer, status = 200) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(answer), { status }); };
  return { f, calls };
}

test("decimalAmount", () => {
  assert.equal(decimalAmount("1000000000", 6), "1000");
  assert.equal(decimalAmount(1234567n, 6), "1.234567");
  assert.equal(decimalAmount("1500000", 6), "1.5");
  assert.equal(decimalAmount("0", 6), "0");
});

test("chain ids and token addresses map to Recta's keys; a corridor Recta does not serve gives undefined", () => {
  assert.deepEqual(transferFromChainTokens({ fromChainId: 8453, toChainId: "42161", fromToken: BASE_USDC, toToken: ARB_USDC, fromAmount: "1000000000", fromAddress: "0xA" }), {
    source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: "1000", sender: "0xA",
  });
  assert.equal(transferFromChainTokens({ fromChainId: 8453, toChainId: 42161, fromToken: "0x0000000000000000000000000000000000000000", toToken: ARB_USDC, fromAmount: "1" }), undefined);
  assert.equal(transferFromChainTokens({ fromChainId: 8453, toChainId: 999999, fromToken: BASE_USDC, toToken: ARB_USDC, fromAmount: "1" }), undefined);
});

test("lifiTransfer reads a quote request and an executeRoute Route, against lifi", () => {
  const q = lifiTransfer({ fromChain: 8453, toChain: 42161, fromToken: BASE_USDC, toToken: ARB_USDC, fromAmount: "1000000000" });
  assert.equal(q.baseline_provider, "lifi");
  assert.equal(q.amount, "1000");
  const r = lifiTransfer({ fromChainId: 8453, toChainId: 42161, fromToken: { address: BASE_USDC }, toToken: { address: ARB_USDC }, fromAmount: "2500000", toAddress: "0xB" });
  assert.equal(r.amount, "2.5");
  assert.equal(r.recipient, "0xB");
  assert.equal(lifiTransfer({ fromAmount: "1" }), undefined);
});

const FULL = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: "1000" };

test("preflight: one unsigned POST to /v1/preflight with its own User-Agent; string fields go through unchanged", async () => {
  const { f, calls } = fakeFetch(SAVING);
  const a = await preflight(FULL, { fetch: f });
  assert.equal(a.outcome, "SAVING_FOUND");
  assert.equal(a.http_status, 200);
  assert.equal(calls[0].url, `${pins.RECTA_ORIGIN}/v1/preflight`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["user-agent"], PREFLIGHT_USER_AGENT);
  assert.match(PREFLIGHT_USER_AGENT, /^recta-client\/\d+\.\d+\.\d+ \(preflight\)$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), FULL);
});

// Regression for the 21-nov finding (29 × 422 PREFLIGHT_FIELDS_REQUIRED from recta-client 0.1.10): 0.1.10 dropped any
// non-string value, so `amount: 1000` left the body without amount.
test("preflight: a numeric or bigint amount is sent as its exact decimal text, never dropped", async () => {
  const { f, calls } = fakeFetch(SAVING);
  for (const amount of [1000, 1000n, 2.5, 0.000001, 9007199254740991]) await preflight({ ...FULL, amount }, { fetch: f });
  assert.deepEqual(calls.map((c) => JSON.parse(c.init.body).amount), ["1000", "1000", "2.5", "0.000001", "9007199254740991"]);
  for (const c of calls) assert.deepEqual(Object.keys(JSON.parse(c.init.body)).sort(), Object.keys(FULL).sort());
});

test("preflight: networks and assets given as strings are kept exactly; camelCase names go under Recta's", async () => {
  const { f, calls } = fakeFetch(SAVING);
  await preflight({ sourceNetwork: "optimism", sourceAsset: "USDT", destinationNetwork: "polygon", destinationAsset: "USDT", amount: "7", baselineProvider: "across" }, { fetch: f });
  assert.deepEqual(JSON.parse(calls[0].init.body), { source_network: "optimism", source_asset: "USDT", destination_network: "polygon", destination_asset: "USDT", amount: "7", baseline_provider: "across" });
});

test("preflight: missing or invalid values throw PreflightInputError before any request; nothing is filled in", async () => {
  const { f, calls } = fakeFetch(SAVING);
  const rejects = async (transfer, missing, invalid) =>
    assert.rejects(preflight(transfer, { fetch: f }), (e) => {
      assert.ok(e instanceof PreflightInputError, String(e));
      assert.deepEqual(e.missing, missing);
      assert.equal(e.invalid.length, invalid);
      return true;
    });
  const { destination_asset, ...noDestAsset } = FULL;
  await rejects(noDestAsset, ["destination_asset"], 0); // never defaulted to the source asset
  await rejects({}, ["source_network", "source_asset", "destination_network", "destination_asset", "amount"], 0);
  for (const amount of [Number.NaN, Infinity, 0, -5, 1e21, 1e-7, 2 ** 60, 0n, -1n, { v: 1 }]) await rejects({ ...FULL, amount }, [], 1);
  await rejects({ ...FULL, sourceNetwork: "ethereum" }, [], 1); // two names, two values: refused, not one picked
  assert.equal(calls.length, 0);
  const e = await preflight({ ...FULL, amount: Number.NaN }, { fetch: f }).catch((x) => x);
  assert.match(e.message, /amount = NaN/);
  assert.deepEqual(preflightBody({ ...FULL, sender: "" }).body, FULL);
});

test("withPreflight: checks first, then bridges with the same arguments and returns its result unchanged", async () => {
  const { f, calls } = fakeFetch(SAVING);
  const order = [];
  const seen = [];
  const bridge = async (a, b) => { order.push("bridge"); return { a, b }; };
  const wrapped = withPreflight(bridge, (a) => { order.push("map"); return lifiTransfer(a); }, { fetch: f, onPreflight: (r) => { order.push("answer"); seen.push(r); } });
  const req = { fromChain: 8453, toChain: 42161, fromToken: BASE_USDC, toToken: ARB_USDC, fromAmount: "1000000000" };
  assert.deepEqual(await wrapped(req, 7), { a: req, b: 7 });
  assert.deepEqual(order, ["map", "answer", "bridge"]);
  assert.equal(calls.length, 1);
  assert.equal(seen[0].answer.saving_usdc, "2.390133");
});

test("withPreflight: an uncovered transfer is not checked; a failed preflight never blocks the bridge", async () => {
  const { f, calls } = fakeFetch(SAVING);
  assert.equal(await withPreflight(async () => "ok", () => undefined, { fetch: f })(), "ok");
  assert.equal(calls.length, 0);
  const errors = [];
  const down = async () => { throw new Error("network down"); };
  const notJson = async () => new Response("<html>", { status: 502 });
  for (const bad of [down, notJson]) {
    assert.equal(await withPreflight(async () => "ok", () => ({ source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "1" }), { fetch: bad, stopOnSaving: true, onPreflight: (r) => errors.push(r.error) })(), "ok");
  }
  assert.equal(errors.length, 2);
});

test("withPreflight stopOnSaving: a proven saving throws before the bridge; no saving bridges", async () => {
  let bridged = 0;
  const bridge = async () => { bridged++; return "sent"; };
  const t = () => ({ source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: "1000" });
  await assert.rejects(withPreflight(bridge, t, { fetch: fakeFetch(SAVING).f, stopOnSaving: true })(), (e) => e instanceof RectaSavingFoundError && e.answer.saving_usdc === "2.390133");
  assert.equal(bridged, 0);
  assert.equal(await withPreflight(bridge, t, { fetch: fakeFetch({ outcome: "NO_SAVING" }).f, stopOnSaving: true })(), "sent");
  assert.equal(await withPreflight(bridge, t, { fetch: fakeFetch(SAVING).f })(), "sent");
});

test("withPreflightTool: the tool's object result carries recta_preflight; other results are untouched", async () => {
  const t = (input) => ({ source_network: input.from, source_asset: "USDC", destination_network: input.to, destination_asset: "USDC", amount: input.amount });
  const tool = { description: "bridge", execute: async (input, ctx) => ({ tx: "0x1", got: input, ctx }) };
  const wrapped = withPreflightTool(tool, t, { fetch: fakeFetch(SAVING).f });
  assert.equal(wrapped.description, "bridge");
  const r = await wrapped.execute({ from: "base", to: "arbitrum", amount: "1000" }, { toolCallId: "c" });
  assert.equal(r.tx, "0x1");
  assert.equal(r.ctx.toolCallId, "c");
  assert.equal(r.recta_preflight.outcome, "SAVING_FOUND");
  assert.equal(r.recta_preflight.saving_usdc, "2.390133");
  assert.ok(r.recta_preflight.execute_via_recta);
  const s = withPreflightTool({ execute: async () => "0xhash" }, t, { fetch: fakeFetch(SAVING).f });
  assert.equal(await s.execute({ from: "base", to: "arbitrum", amount: "1" }), "0xhash");
  const noExec = { description: "x" };
  assert.equal(withPreflightTool(noExec, t), noExec);
});

test("withPreflightTool stopOnSaving: returns RECTA_SAVING_FOUND without bridging; skip_preflight bridges and is stripped", async () => {
  const inputs = [];
  const tool = { execute: async (input) => { inputs.push(input); return { tx: "0x1" }; } };
  const { f, calls } = fakeFetch(SAVING);
  const wrapped = withPreflightTool(tool, (i) => ({ source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: i.amount }), { fetch: f, stopOnSaving: true });
  const stopped = await wrapped.execute({ amount: "1000" });
  assert.equal(stopped.status, "RECTA_SAVING_FOUND");
  assert.equal(inputs.length, 0);
  const sent = await wrapped.execute({ amount: "1000", skip_preflight: true });
  assert.deepEqual(sent, { tx: "0x1" });
  assert.deepEqual(inputs[0], { amount: "1000" });
  assert.equal(calls.length, 1);
});

test("withPreflight without onPreflight: the first failed or refused preflight is warned once; quiet hides it; the bridge always runs", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const { f, calls } = fakeFetch({ status: "REFUSED", reason_code: "PREFLIGHT_FIELDS_REQUIRED", message: "missing: amount" }, 422);
    assert.equal(await withPreflight(async () => "quiet", () => ({}), { fetch: f, quiet: true })(), "quiet");
    assert.equal(warnings.length, 0);
    const wrapped = withPreflight(async () => "ok", (t) => t, { fetch: f });
    assert.equal(await wrapped({ source_network: "base", source_asset: "USDC", destination_network: "arbitrum", destination_asset: "USDC", amount: "1" }), "ok");
    assert.equal(await wrapped({}), "ok");
    assert.equal(calls.length, 1); // the empty transfer never reached the network
    assert.equal(warnings.length, 1); // once per wrapped call
    assert.match(warnings[0], /HTTP 422 PREFLIGHT_FIELDS_REQUIRED: missing: amount/);
    assert.equal(await withPreflight(async () => "ok", () => ({ source_network: "base" }), { fetch: f })(), "ok");
    assert.equal(warnings.length, 2);
    assert.match(warnings[1], /needs source_asset, destination_network, destination_asset, amount/);
  } finally {
    console.warn = original;
  }
});
