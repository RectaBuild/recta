// @recta/plugin-recta (BIT-OPS-191 in route-hint): the elizaOS registry package re-exports @recta/mcp/elizaos.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, { rectaPlugin, rectaElizaPlugin } from "../dist/index.js";
import { rectaPlugin as fromMcp } from "@recta/mcp/elizaos";

test("the default export is the Recta plugin from @recta/mcp/elizaos, with RECTA_PREFLIGHT", () => {
  assert.equal(plugin, rectaPlugin);
  assert.equal(plugin, fromMcp);
  assert.equal(plugin.name, "recta");
  assert.deepEqual(plugin.actions.map((a) => a.name).sort(), ["RECTA_FIT", "RECTA_PREFLIGHT", "RECTA_TRIAL_EVALUATION"]);
  assert.equal(typeof rectaElizaPlugin, "function");
});

test("RECTA_PREFLIGHT posts the transfer to /v1/preflight, unsigned", async () => {
  const calls = [];
  const p = rectaElizaPlugin({ fetch: async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ outcome: "SAVING_FOUND", saving_usdc: "2.390133" }), { status: 200 }); } });
  const r = await p.actions.find((a) => a.name === "RECTA_PREFLIGHT").handler({ getSetting: () => undefined }, {}, undefined, { parameters: { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "1000", baseline_provider: "lifi" } });
  assert.equal(r.success, true);
  assert.equal(r.data.saving_usdc, "2.390133");
  assert.match(calls[0].url, /\/v1\/preflight$/);
  assert.equal(new Headers(calls[0].init.headers).get("x-recta-signature"), null);
});

test("package.json is what the elizaOS registry asks for", async () => {
  const { readFileSync, statSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.name.split("/").pop(), /^plugin-/);
  assert.ok(pkg.description.length > 40);
  assert.ok(pkg.files.includes("images"));
  assert.ok(statSync(new URL("../images/logo.jpg", import.meta.url)).size <= 500 * 1024);
  assert.ok(statSync(new URL("../images/banner.jpg", import.meta.url)).size <= 1024 * 1024);
});
