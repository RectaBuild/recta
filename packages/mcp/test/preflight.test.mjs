// recta_preflight (BIT-OPS-188 in route-hint): the free one-call check of api.recta.build/v1/preflight, with or without a key.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { keylessSigner } from "../dist/index.js";
import { createLocalServer, TOOLS } from "../dist/server.js";
import { rectaElizaPlugin } from "../dist/elizaos.js";

const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const chain = { waitForSuccess: async () => true, readFeeFunds: async () => { throw new Error("unused"); } };
const args = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "1000" };
const addr = `0x${"Ab".repeat(20)}`;
const wallet = `0x${"Cd".repeat(20)}`;

function server({ keyless = true, address, signer } = {}) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ status: "SAVING_FOUND" }), { status: 200 }); };
  const s = createLocalServer({ signer: signer ?? keylessSigner(address), chain, limits, allowExecute: false, keyless, fetch: f, gasCapsFor: async () => { throw new Error("the preflight reads no gas"); } });
  return { s, calls };
}

test("recta_preflight is the first tool, and only the corridor and the amount are required", () => {
  assert.equal(TOOLS[0].name, "recta_preflight");
  assert.deepEqual([...TOOLS[0].inputSchema.required].sort(), ["amount", "destination_network", "source_asset", "source_network"]);
});

test("keyless preflight: one unsigned POST to /v1/preflight with only the given fields, no sender when none is known", async () => {
  const { s, calls } = server();
  const r = await s.call("recta_preflight", { ...args, baseline_provider: "lifi" });
  assert.equal(r.status, "SAVING_FOUND");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/preflight$/);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { ...args, baseline_provider: "lifi" });
  assert.equal(calls[0].init.headers["x-recta-signature"], undefined);
  assert.match(calls[0].init.headers["user-agent"], /^recta-mcp\//);
});

test("keyless preflight: sender from the call or RECTA_ADDRESS; a malformed one is refused before any request", async () => {
  const env = server({ address: addr });
  await env.s.call("recta_preflight", args);
  assert.equal(JSON.parse(env.calls[0].init.body).sender, addr);
  const given = server();
  await given.s.call("recta_preflight", { ...args, sender: wallet });
  assert.equal(JSON.parse(given.calls[0].init.body).sender, wallet);
  await assert.rejects(given.s.call("recta_preflight", { ...args, sender: "0x12" }), (e) => e.check === "input");
  await assert.rejects(given.s.call("recta_preflight", { source_network: "base" }), (e) => e.check === "input");
  assert.equal(given.calls.length, 1);
});

test("with a key the sender is always the wallet and nothing is signed", async () => {
  const signer = { ...keylessSigner(wallet), address: wallet, signMessage: async () => { throw new Error("signed"); }, signTypedData: async () => { throw new Error("signed"); } };
  const { s, calls } = server({ keyless: false, signer });
  await s.call("recta_preflight", { ...args, sender: addr });
  assert.equal(JSON.parse(calls[0].init.body).sender, wallet);
});

test("the server answers a non-JSON reply with its status", async () => {
  const s = createLocalServer({ signer: keylessSigner(undefined), chain, limits, allowExecute: false, keyless: true, fetch: async () => new Response("busy", { status: 503 }), gasCapsFor: async () => [1n, 1n] });
  assert.deepEqual(await s.call("recta_preflight", args), { status: 503, body: "busy" });
});

test("elizaOS: RECTA_PREFLIGHT is routed before bridging and calls the preflight", async () => {
  const calls = [];
  const p = rectaElizaPlugin({ fetch: async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ status: "SAVING_FOUND" }), { status: 200 }); } });
  const action = p.actions.find((a) => a.name === "RECTA_PREFLIGHT");
  assert.match(action.routingHint, /before bridging/);
  const r = await action.handler({ getSetting: () => undefined }, {}, undefined, { parameters: { ...args, amount: 1000 } });
  assert.equal(r.success, true);
  assert.match(calls[0].url, /\/v1\/preflight$/);
  assert.equal(JSON.parse(calls[0].init.body).amount, "1000");
});
