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
  // A failure that still carries a hash may have been mined (Fable R-1 on #19).
  await assert.rejects(failed.sendTransaction(tx), /may have been sent/);
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

// ---- The money path through the plugin (Fable M-3 on #19), and what an agent is told once money moved (M-1). ----
import { encodeFunctionData, pad, parseAbi, recoverTypedDataAddress } from "viem";
import { pins } from "@recta/client";

const SPOKE = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"; // Across on Base, pinned for base:USDC>arbitrum:USDC
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const AMOUNT = 10_000_000n;
const expiry = () => String(Math.floor(Date.now() / 1000) + 3600);

function artifact() {
  const common = { chain_id: "8453", from: account.address, value_wei: "0", max_fee_per_gas_wei: "14000000", max_priority_fee_per_gas_wei: "1000000", transaction_type: "EIP1559", access_list: [] };
  return {
    schema: pins.EXECUTION_ARTIFACT_SCHEMA ?? "RECTA_COMMERCIAL_EXECUTION_ARTIFACT_V2",
    result_id: "r_test",
    commercial_expiry_unix: expiry(),
    transactions: [
      { ...common, role: "APPROVAL", to: pins.USDC_BASE, gas_limit: "60000", data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [SPOKE, AMOUNT] }) },
      {
        ...common,
        role: "EXECUTION",
        to: SPOKE,
        gas_limit: "200000",
        data: encodeFunctionData({
          abi: parseAbi(["function deposit(bytes32 depositor, bytes32 recipient, bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, bytes32 exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)"]),
          args: [pad(account.address), pad(account.address), pad(pins.USDC_BASE), pad(USDC_ARB), AMOUNT, 9_950_000n, 42161n, pad("0x"), 1, 2, 0, "0x"],
        }),
      },
    ],
  };
}

const feeOffer = (kind = "DECISION") => {
  const typed_data = {
    domain: { name: "Permit2", chainId: 8453, verifyingContract: pins.PERMIT2 },
    types: pins.FEE_PERMIT_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: { permitted: { token: pins.USDC_BASE, amount: "500000" }, spender: pins.UPTO_PROXY, nonce: "7", deadline: String(Number(expiry()) + 86_400), witness: { to: pins.FEE_RECEIVER, facilitator: pins.FEE_FACILITATOR, validAfter: "0" } },
  };
  return kind === "DEBT"
    ? { debt_id: "d_1", amount_usdc_atomic: "500000", typed_data }
    : { max_fee_authorization_usdc_atomic: "500000", carried_usdc_atomic: "0", commercial_expiry_unix: expiry(), typed_data };
};

/** Recta with collection on, positive decision, and a report answer of `reportStatus`. */
function collectingRecta({ reportStatus = 200 } = {}) {
  const seen = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    seen.push({ method: init?.method ?? "GET", path: u.pathname, headers: init?.headers ?? {}, body: init?.body });
    if (u.pathname.endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    if (u.pathname.endsWith("/execution-artifact")) return new Response(JSON.stringify({ status: "SIGNATURE_REQUIRED", commercial_expiry_unix: JSON.parse(JSON.stringify(feeOffer())).commercial_expiry_unix, fee_authorization: feeOffer() }), { status: 402 });
    if (u.pathname.endsWith("/fee-authorization")) return new Response(JSON.stringify({ artifact: artifact() }), { status: 200 });
    if (u.pathname.endsWith("/execution")) return new Response(JSON.stringify(reportStatus === 200 ? { status: "ACCRUED" } : { reason_code: "STORE_UNAVAILABLE" }), { status: reportStatus });
    if (u.pathname.endsWith("/fee-debts")) return new Response(JSON.stringify({ status: "AUTHORIZED" }), { status: 200 });
    return new Response(JSON.stringify({ result_id: "r_test", decision: { state: "VERIFIED_POSITIVE" } }), { status: 200 });
  };
  return { f, seen };
}

/** MetaMask with distinct hashes per transaction; `rewrite(tx, i)` changes what is mined; `readback(i)` may throw. */
function wallet({ rewrite = (t) => t, readback = () => undefined, balance = 20_000_000n, allowance = 1_000_000n, status = () => "CONFIRMED", receipt = () => "success" } = {}) {
  const requests = [];
  const mined = new Map();
  let n = 0;
  const run = async (request, opts) => {
    requests.push({ request, opts });
    if (request.kind === "message") return { kind: "signature", status: "SIGNED", signature: await account.signMessage({ message: request.message }) };
    if (request.kind === "typed-data") return { kind: "signature", status: "SIGNED", signature: await account.signTypedData(request.typedData) };
    const i = n++;
    const hash = `0x${String(i + 1).padStart(2, "0").repeat(32)}`;
    const t = rewrite(request.transaction, i);
    mined.set(hash, { i, tx: { from: account.address, to: t.to, input: t.data, value: t.value, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, chainId: request.chainId } });
    return { kind: "transaction", status: status(i), hash };
  };
  const publicClient = (chainId) => ({
    getChainId: async () => chainId,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    waitForTransactionReceipt: async ({ hash }) => ({ status: receipt(mined.get(hash).i) }),
    getTransaction: async ({ hash }) => { const m = mined.get(hash); readback(m.i); return m.tx; },
    readContract: async ({ functionName }) => (functionName === "balanceOf" ? balance : allowance),
  });
  const c = { walletStateManager: { read: () => ({ byokWallets: [{ id: "w1", address: account.address, namespace: "eip155" }], selectedWallet: { mode: "byok", namespace: "eip155", ref: { id: "w1" } } }) }, publicClient, walletExecutor: async () => run };
  return { c, requests, mined };
}

const move = { "source-network": "base", "source-asset": "USDC", "destination-network": "arbitrum", amount: "10", "baseline-provider": "across", execute: true };
const sdkErr = { CommandError: class extends Error { constructor(code, message, hint) { super(message); this.code = code; this.hint = hint; } } };

test("M-3: mm recta move --execute signs the fee permit, sends Recta's two transactions exactly, reports both", async () => {
  const { f, seen } = collectingRecta();
  const w = wallet();
  const out = await runCommand(spec("recta:move"), w.c, {}, move, f);
  assert.equal(out.execution.report, "ACCRUED");
  assert.equal(out.execution.fee, "AUTHORIZED");
  const permit = w.requests.find((r) => r.request.kind === "typed-data").request;
  assert.equal(permit.chainId, 8453);
  assert.equal(await recoverTypedDataAddress({ ...permit.typedData, signature: await account.signTypedData(permit.typedData) }), account.address);
  const txs = w.requests.filter((r) => r.request.kind === "transaction");
  assert.equal(txs.length, 2);
  const a = artifact().transactions;
  for (const [i, { request }] of txs.entries()) {
    assert.deepEqual(request.transaction, { to: a[i].to, data: a[i].data, value: 0n, gas: BigInt(a[i].gas_limit), maxFeePerGas: 14_000_000n, maxPriorityFeePerGas: 1_000_000n });
  }
  const report = JSON.parse(new TextDecoder().decode(seen.find((r) => r.path.endsWith("/execution")).body));
  assert.deepEqual(report, { origin_tx_hash: `0x${"02".repeat(32)}`, approval_tx_hash: `0x${"01".repeat(32)}` });
  // B-4: Recta can tell mm's use apart from the MCP server's.
  assert.match(seen.at(-1).headers["user-agent"], /^recta-mcp\/0\.1\.12 \(mm\)$/);
});

const transferSent = async (opts, recta = collectingRecta()) => {
  const w = wallet(opts);
  const e = await runCommand(spec("recta:move"), w.c, {}, move, recta.f).catch((x) => x);
  return { shown: commandErrorOf(sdkErr, e), w };
};

test("M-1 (a): MetaMask changes the transfer's gas: the error says it was sent, not to send it again, and how to report it", async () => {
  const { shown } = await transferSent({ rewrite: (t, i) => (i === 1 ? { ...t, gas: t.gas + 1n } : t) });
  assert.equal(shown.code, "RECTA_TRANSFER_SENT");
  const body = JSON.parse(shown.message);
  assert.equal(body.check, "wallet_changed_transaction");
  assert.equal(body.result_id, "r_test");
  assert.equal(body.origin_tx_hash, `0x${"02".repeat(32)}`);
  assert.deepEqual(body.approval_tx_hashes, [`0x${"01".repeat(32)}`]);
  assert.match(shown.hint, /do not send it again/);
  assert.match(shown.hint, new RegExp(`mm recta report --result-id r_test --origin-tx-hash 0x${"02".repeat(32)} --approval-tx-hash 0x${"01".repeat(32)}`));
  assert.doesNotMatch(body.message, /wallet_changed_transaction:/, "no duplicated prefix (B-2)");
});

test("M-1 (b): the transfer cannot be read back: same answer, with the hash", async () => {
  const { shown } = await transferSent({ readback: (i) => { if (i === 1) throw new Error("TransactionNotFoundError"); } });
  assert.equal(shown.code, "RECTA_TRANSFER_SENT");
  const body = JSON.parse(shown.message);
  assert.equal(body.check, "wallet_readback");
  assert.equal(body.origin_tx_hash, `0x${"02".repeat(32)}`);
  assert.match(shown.hint, /mm recta report --result-id r_test/);
});

test("M-1 (c): the report fails: the result_id and both hashes are kept for mm recta report", async () => {
  const { shown } = await transferSent({}, collectingRecta({ reportStatus: 503 }));
  assert.equal(shown.code, "RECTA_TRANSFER_SENT");
  const body = JSON.parse(shown.message);
  assert.equal(body.error, "HTTP");
  assert.equal(body.result_id, "r_test");
  assert.equal(body.origin_tx_hash, `0x${"02".repeat(32)}`);
  assert.match(shown.hint, /mm recta report --result-id r_test/);
});

test("M-1: MetaMask changes the approval: only the approval was sent, the transfer never is", async () => {
  const { shown, w } = await transferSent({ rewrite: (t, i) => (i === 0 ? { ...t, maxFeePerGas: 1n } : t) });
  assert.equal(shown.code, "RECTA_APPROVAL_SENT");
  assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 1);
  assert.equal(JSON.parse(shown.message).transfer_sent, undefined);
  assert.match(shown.hint, /no transfer/);
});

test("approve-fee: one bounded approve to Permit2 on Base; a foreign --address is refused before anything is sent (B-1)", async () => {
  const w = wallet({ allowance: 0n });
  const out = await runCommand(spec("recta:approve-fee"), w.c, {}, { "amount-usdc": "0.5" }, collectingRecta().f);
  assert.equal(out.approved_usdc_atomic, "500000");
  const [{ request }] = w.requests;
  assert.equal(request.chainId, 8453);
  assert.equal(request.transaction.to.toLowerCase(), pins.USDC_BASE.toLowerCase());
  assert.equal(request.transaction.data, encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), args: [pins.PERMIT2, 500_000n] }));

  const other_ = wallet();
  await assert.rejects(runCommand(spec("recta:approve-fee"), other_.c, {}, { address: other.address }, collectingRecta().f), /is not the wallet selected in mm/);
  assert.equal(other_.requests.length, 0);
  // mm's selection unreadable: one signature proves the address first, and a mismatch sends nothing.
  const blind = wallet();
  blind.c.walletStateManager = { read: () => ({}) };
  await assert.rejects(runCommand(spec("recta:approve-fee"), blind.c, {}, { address: other.address }, collectingRecta().f), /does not recover/);
  assert.deepEqual(blind.requests.map((r) => r.request.kind), ["message"]);
});

test("pay-debt: signs the offered debt permit after the same checks, never above --max-fee-usdc", async () => {
  const { f, seen } = collectingRecta();
  const w = wallet();
  const out = await runCommand(spec("recta:pay-debt"), w.c, {}, { "debt-offer": JSON.stringify(feeOffer("DEBT")) }, f);
  assert.equal(out.status, "AUTHORIZED");
  // The permit, then the signed request that carries it.
  assert.deepEqual(w.requests.map((r) => r.request.kind), ["typed-data", "message"]);
  assert.equal(JSON.parse(new TextDecoder().decode(seen.at(-1).body)).debt_id, "d_1");
  await assert.rejects(runCommand(spec("recta:pay-debt"), wallet().c, {}, { "debt-offer": JSON.stringify(feeOffer("DEBT")), "max-fee-usdc": "0.4" }, f), (e) => JSON.stringify(e.body ?? e.message).includes("fee_amount_limit"));
  await assert.rejects(runCommand(spec("recta:pay-debt"), wallet().c, {}, { "debt-offer": "{" }, f), /not valid JSON/);
});

test("M-2 and B-2: agent texts name only declarable baselines and mm commands", async () => {
  const baseline = spec("recta:move").inputs.find((i) => i.flag === "baseline-provider").message;
  assert.doesNotMatch(baseline, /relay|cctp/i);
  assert.match(spec("recta:move").inputs.find((i) => i.flag === "amount").message, /3\.5/);
  const skill = readFileSync(new URL("../../../skills/recta-metamask-agent-wallet/SKILL.md", import.meta.url), "utf8");
  assert.doesNotMatch(skill, /CCTP|Relay|mm swap\)/);
  const { f } = collectingRecta();
  const out = await runCommand(spec("recta:move"), wallet().c, {}, { ...move, execute: false }, f);
  assert.doesNotMatch(out.preview.note, /recta_execute|recta_fee_funds|recta_approve_fee/);
  assert.match(out.preview.note, /mm recta move --execute/);
});

test("R-1: MetaMask stops tracking the transfer but gives its hash: it may have been sent, never 'did not send'", async () => {
  for (const state of ["CONFIRMATION_TRACKING_EXPIRED", "BROADCAST_TRACKING_EXPIRED"]) {
    const { shown } = await transferSent({ status: (i) => (i === 1 ? state : "CONFIRMED") });
    assert.equal(shown.code, "RECTA_TRANSFER_SENT", state);
    const body = JSON.parse(shown.message);
    assert.equal(body.check, "wallet_unconfirmed");
    assert.equal(body.origin_tx_hash, `0x${"02".repeat(32)}`);
    assert.equal(body.unconfirmed_tx_hash, `0x${"02".repeat(32)}`);
    assert.match(shown.hint, /may have been sent/);
    assert.match(shown.hint, /mm recta report --result-id r_test/);
    assert.doesNotMatch(shown.message, /did not send/);
  }
  // Without a hash, MetaMask did not send it.
  const signer = metaMaskSigner({ address: account.address, execute: async () => ({ kind: "transaction", status: "BROADCAST_FAILED" }), publicClientFor: publicClients() });
  await assert.rejects(signer.sendTransaction(tx), /MetaMask did not send/);
});

test("R-2: a transfer that reverted on chain moved nothing: the agent is told its own route is free", async () => {
  const { shown } = await transferSent({ receipt: (i) => (i === 1 ? "reverted" : "success") });
  assert.equal(shown.code, "RECTA_TRANSFER_REVERTED");
  const body = JSON.parse(shown.message);
  assert.equal(body.transfer_sent, false);
  assert.equal(body.reverted_tx_hash, `0x${"02".repeat(32)}`);
  assert.match(shown.hint, /nothing moved/);
  assert.doesNotMatch(shown.hint, /do not send/);
});
