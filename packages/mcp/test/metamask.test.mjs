// The MetaMask Agent Wallet (`mm`) plugin: the signer on MetaMask's wallet executor and the `mm recta …` commands, with
// stand-ins shaped like @metamask/agent-wallet 7.3.0 and @metamask/agent-sdk 7.3.0 (checked against their published
// declarations when this was written). Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { keccak256, recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signedRequestMessage } from "@recta/client";
import { metaMaskSigner, selectedMetaMaskAddress } from "../dist/metamask.js";
import { COMMAND_SPECS, commandErrorOf, rectaCommand, runCommand } from "../dist/mm/specs.js";
import { expectedMmManifest, oclifManifest } from "../scripts/mm-manifest.mjs";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const HASH = `0x${"ab".repeat(32)}`;
const tx = { chainId: 8453, to: `0x${"33".repeat(20)}`, data: "0x1234", value: 0n, gas: 90_000n, maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n };

/** MetaMask's executor (BYOK mode: synchronous results), signing with `signer`; it records every request. */
function executor(signer = account, { sendAs = (t) => t, result = {} } = {}) {
  const requests = [];
  const sent = new Map();
  const run = async (request, opts) => {
    requests.push({ request, opts });
    if (request.kind === "message") return { kind: "signature", status: "SIGNED", signature: await signer.signMessage({ message: request.message }), ...result };
    if (request.kind === "typed-data") return { kind: "signature", status: "SIGNED", signature: await signer.signTypedData(request.typedData), ...result };
    sent.set(HASH, { from: signer.address, to: request.transaction.to, input: request.transaction.data, chainId: request.chainId, ...sendAs(request.transaction), ...(request.transaction.data === undefined ? {} : { input: sendAs(request.transaction).data ?? request.transaction.data }) });
    return { kind: "transaction", status: "CONFIRMED", hash: HASH, ...result };
  };
  return { run, requests, sent };
}

/** `ctx.publicClient(chainId)`: a viem public client, as far as Recta reads it. */
function publicClients(sent = new Map(), reads = []) {
  return (chainId) => ({
    getChainId: async () => chainId,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    waitForTransactionReceipt: async ({ hash }) => { reads.push(["receipt", chainId, hash]); return { status: "success" }; },
    getTransaction: async ({ hash }) => { reads.push(["tx", chainId, hash]); return sent.get(hash); },
    readContract: async ({ functionName }) => { reads.push([functionName, chainId]); return functionName === "balanceOf" ? 5_000_000n : 0n; },
  });
}

function fakeFetch(answer = { result_id: "r_test", decision: { state: "VERIFIED_ZERO" } }) {
  const calls = [];
  const f = async (url, init) => {
    if (String(url).endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    calls.push({ url: new URL(String(url)), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { f, calls };
}

const recovers = async (call, address = account.address) => {
  const h = call.headers;
  const message = signedRequestMessage({ method: call.method, path: `${call.url.pathname}${call.url.search}`, idempotencyKey: h["idempotency-key"] ?? "", bodyKeccak256: keccak256(call.body ?? new Uint8Array()), issuedAt: Number(h["x-recta-issued-at"]) });
  return (await recoverMessageAddress({ message, signature: h["x-recta-signature"] })) === address;
};

test("signer: messages and permits go through MetaMask's executor and must recover to the wallet's address", async () => {
  const ex = executor();
  const signer = metaMaskSigner({ address: account.address, execute: ex.run, publicClientFor: publicClients() });
  const sig = await signer.signMessage("hello");
  assert.equal(await recoverMessageAddress({ message: "hello", signature: sig }), account.address);
  assert.deepEqual(ex.requests[0].request, { kind: "message", chainId: 8453, message: "hello" });

  // A wallet that signs as someone else (another wallet selected in mm) is refused before Recta sees the signature.
  const wrong = metaMaskSigner({ address: account.address, execute: executor(other).run, publicClientFor: publicClients() });
  await assert.rejects(wrong.signMessage("hello"), /does not recover/);
  // MetaMask's policy or the user's 2FA said no.
  const denied = metaMaskSigner({ address: account.address, execute: executor(account, { result: { status: "DENIED", signature: undefined } }).run, publicClientFor: publicClients() });
  await assert.rejects(denied.signMessage("hello"), /MetaMask did not sign Recta's request \(DENIED\)/);
});

test("signer: a transaction is sent with Recta's exact gas and fee caps, and refused once mined if MetaMask changed any of them", async () => {
  const ex = executor();
  const reads = [];
  const signer = metaMaskSigner({ address: account.address, execute: ex.run, publicClientFor: publicClients(ex.sent, reads) });
  assert.equal(await signer.sendTransaction(tx), HASH);
  const { request, opts } = ex.requests[0];
  assert.deepEqual(request, { kind: "transaction", chainId: 8453, transaction: { to: tx.to, data: tx.data, value: 0n, gas: 90_000n, maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n } });
  assert.deepEqual(opts, { waitForReceipt: true });
  assert.deepEqual(reads, [["receipt", 8453, HASH], ["tx", 8453, HASH]]);

  for (const change of [{ gas: 120_000n }, { maxFeePerGas: 9_000_000n }, { maxPriorityFeePerGas: 2n }, { data: "0xdead" }, { to: `0x${"44".repeat(20)}` }]) {
    const rewriting = executor(account, { sendAs: (t) => ({ ...t, ...change }) });
    const s = metaMaskSigner({ address: account.address, execute: rewriting.run, publicClientFor: publicClients(rewriting.sent) });
    await assert.rejects(s.sendTransaction(tx), (e) => e.check === "wallet_changed_transaction", `change ${Object.keys(change)}`);
  }
  const failed = metaMaskSigner({ address: account.address, execute: executor(account, { result: { status: "BROADCAST_FAILED" } }).run, publicClientFor: publicClients() });
  await assert.rejects(failed.sendTransaction(tx), /MetaMask did not send/);
});

test("the selected mm wallet's address, or a clear request for --address", () => {
  const a = account.address;
  const b = other.address;
  const state = { byokWallets: [{ id: "w1", name: "main", address: a, namespace: "eip155" }], remoteWallets: [{ name: "srv", address: b, namespace: "eip155" }] };
  assert.equal(selectedMetaMaskAddress({ ...state, selectedWallet: { namespace: "eip155", ref: { id: "w1" } } }), a);
  assert.equal(selectedMetaMaskAddress({ ...state, selectedWallet: { namespace: "eip155", ref: { address: b.toLowerCase() } } }), b);
  assert.equal(selectedMetaMaskAddress({ ...state, selectedWallet: { namespace: "eip155", ref: { name: "srv" } } }), b);
  assert.throws(() => selectedMetaMaskAddress(state), /pass --address/);
  assert.throws(() => selectedMetaMaskAddress({ ...state, selectedWallet: { namespace: "solana", ref: { id: "w1" } } }), /pass --address/);
});

function ctx({ ex = executor(), state = { byokWallets: [{ id: "w1", address: account.address, namespace: "eip155" }], selectedWallet: { namespace: "eip155", ref: { id: "w1" } } }, reads = [] } = {}) {
  const asked = [];
  return {
    asked,
    ex,
    walletStateManager: { read: () => state },
    publicClient: publicClients(ex.sent, reads),
    walletExecutor: async (_io, source) => { asked.push(source); return ex.run; },
  };
}
const spec = (id) => COMMAND_SPECS.find((c) => c.id === id);
const route = { "source-network": "base", "source-asset": "USDC", "destination-network": "arbitrum", amount: "100", "baseline-provider": "stargate_v2" };

test("mm recta fit and trial sign nothing and never ask MetaMask for its executor", async () => {
  const { f, calls } = fakeFetch({ fit: true });
  const c = ctx();
  assert.deepEqual(await runCommand(spec("recta:fit"), c, {}, route, f), { fit: true });
  assert.equal(calls[0].url.pathname, "/v1/golden-corridor/fit");
  await runCommand(spec("recta:trial"), c, {}, route, f);
  const trial = calls.at(-1);
  assert.equal(trial.url.pathname, "/v1/golden-corridor/trial-evaluation");
  assert.equal(trial.headers["x-recta-signature"], undefined);
  assert.equal(JSON.parse(trial.body).sender, account.address);
  assert.deepEqual(c.asked, []);
  assert.equal(c.ex.requests.length, 0);
});

test("mm recta move: the evaluation is signed by the MetaMask wallet; no saving means keep your own route", async () => {
  const { f, calls } = fakeFetch();
  const c = ctx();
  const out = await runCommand(spec("recta:move"), c, {}, { ...route, execute: false }, f);
  assert.deepEqual(c.asked, ["recta:move"]);
  const signed = calls.at(-1);
  assert.equal(signed.url.pathname, "/v1/golden-corridor/commercial-evaluations");
  assert.ok(await recovers(signed));
  const body = JSON.parse(new TextDecoder().decode(signed.body));
  assert.equal(body.sender, account.address);
  assert.equal(body.execution_authority.source_max_fee_per_gas_wei, "14000000");
  assert.equal(out.evaluation.decision.state, "VERIFIED_ZERO");
  assert.match(out.next, /keep your own route/);
  assert.equal(out.execution, undefined);
  // The only thing MetaMask was asked for: one request signature.
  assert.deepEqual(c.ex.requests.map((r) => r.request.kind), ["message"]);
});

test("limits come from flags with @recta/mcp's defaults and messages; a bad one names the flag", async () => {
  const { f } = fakeFetch();
  await assert.rejects(runCommand(spec("recta:move"), ctx(), {}, { ...route, "max-fee-usdc": "lots" }, f), /--max-fee-usdc must be a decimal USDC amount/);
  await assert.rejects(runCommand(spec("recta:move"), ctx(), {}, { ...route, referrer: "me" }, f), /--referrer must be/);
});

test("mm recta fee-funds reads Base through MetaMask's client and asks for no executor", async () => {
  const reads = [];
  const c = ctx({ reads });
  const out = await runCommand(spec("recta:fee-funds"), c, {}, {}, fakeFetch().f);
  assert.equal(out.ready, false);
  assert.deepEqual(reads.map((r) => r[1]), [8453, 8453]);
  assert.deepEqual(c.asked, []);
});

test("errors carry the MCP server's JSON answer and a code an agent can branch on", async () => {
  const sdk = { CommandError: class extends Error { constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; } } };
  const { f } = fakeFetch();
  const err = await runCommand(spec("recta:report"), ctx(), {}, { "result-id": "r_1", "origin-tx-hash": "0x12" }, f).catch((e) => e);
  const shown = commandErrorOf(sdk, err);
  assert.equal(shown.code, "RECTA_CHECK_FAILED");
  assert.match(shown.message, /transaction hashes must be 0x \+ 64 hex characters/);
  const debt = commandErrorOf(sdk, Object.assign(Object.create((await import("../dist/mm/specs.js")).RectaToolError.prototype), { body: { error: "DEBT", debt_offer: {} }, message: "{}" }));
  assert.equal(debt.code, "RECTA_DEBT");
  assert.match(debt.hint, /mm recta pay-debt --debt-offer/);
});

test("the oclif command class: statics, the manifest id, and execute on mm's resolved flags", async () => {
  class PluginCommand { constructor(ctx) { this.ctx = ctx; } }
  const sdk = { PluginCommand, InputFieldType: { Text: "text", Boolean: "boolean" }, schemaToFlags: (schema) => ({ ...schema }), CommandError: class extends Error { constructor(code, message) { super(message); this.code = code; } } };
  const Fit = rectaCommand(sdk, "recta:fit");
  assert.equal(Fit.requiresAuth, false);
  assert.equal(Fit.requiresInit, false);
  assert.deepEqual(Object.keys(Fit.flags), ["source-network", "source-asset", "destination-network", "destination-asset"]);
  assert.equal(Fit.flags["source-network"].required, true);
  const Move = rectaCommand(sdk, "recta:move");
  assert.equal(Move.requiresAuth, true);
  assert.equal(Move.flags.execute.type, "boolean");
  const cmd = new Move(ctx());
  assert.equal(cmd.pluginCommandId, "recta:move");
  // The only members it defines: execute and pluginCommandId (mm seals the rest of the lifecycle).
  assert.deepEqual(Object.getOwnPropertyNames(Move.prototype).sort(), ["constructor", "execute"]);
  await assert.rejects(cmd.execute({ resolveInputs: async () => ({ ...route, "max-fee-usdc": "x" }) }), (e) => e.code === "RECTA_CHECK_FAILED" && /--max-fee-usdc/.test(e.message));
});

test("package.json#mm, oclif.manifest.json and the command files match the command table", () => {
  assert.deepEqual(pkg.mm, expectedMmManifest(pkg.mm.minCliVersion));
  assert.deepEqual(pkg.oclif, { bin: "mm", commands: "./dist/mm/commands" });
  assert.ok(pkg.keywords.includes("oclif-plugin"));
  assert.equal(pkg.peerDependenciesMeta["@metamask/agent-wallet"].optional, true);
  assert.ok(pkg.files.includes("oclif.manifest.json"));
  const manifest = JSON.parse(readFileSync(new URL("../oclif.manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest, oclifManifest(pkg.version, pkg.name));
  for (const c of COMMAND_SPECS) {
    const file = new URL(`../${manifest.commands[c.id].relativePath.join("/")}`, import.meta.url);
    assert.ok(existsSync(file), `${c.id}: ${file}`);
    assert.match(readFileSync(file, "utf8"), new RegExp(`rectaCommand\\(sdk, "${c.id}"\\)`));
  }
  // Only the commands that sign or send ask for wallet-submit.
  for (const c of COMMAND_SPECS) assert.equal(c.capabilities.includes("wallet-submit"), c.wallet === "sign" || c.wallet === "send", c.id);
});
