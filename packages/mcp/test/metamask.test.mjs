// The MetaMask Agent Wallet (`mm`) plugin: the signer on MetaMask's wallet executor and the `mm recta …` commands, with
// stand-ins shaped like @metamask/agent-wallet 7.3.0 and @metamask/agent-sdk 7.3.0 (checked against their published
// declarations when this was written). Run after the build: node --test test/
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    getTransactionCount: async () => 7,
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
function wallet({ rewrite = (t) => t, readback = () => undefined, balance = 20_000_000n, allowance = 1_000_000n, status = () => "CONFIRMED", receipt = () => "success", answer = () => undefined, sign = () => undefined, nonce = () => undefined, journalDir = mkdtempSync(join(tmpdir(), "recta-journal-")), confirmed = undefined } = {}) {
  const requests = [];
  const mined = new Map();
  /** MetaMask's pendingJobs (`mm wallet requests list`), as a test sets them. */
  const jobs = [];
  let n = 0;
  const run = async (request, opts) => {
    requests.push({ request, opts });
    if (request.kind !== "transaction") { const r = sign(request); if (r !== undefined) return r; }
    if (request.kind === "message") return { kind: "signature", status: "SIGNED", signature: await account.signMessage({ message: request.message }) };
    if (request.kind === "typed-data") return { kind: "signature", status: "SIGNED", signature: await account.signTypedData(request.typedData) };
    const i = n++;
    // `answer(i)` may throw (the call dies) or return MetaMask's answer without a hash.
    const instead = answer(i);
    if (instead !== undefined) return instead;
    const hash = `0x${String(i + 1).padStart(2, "0").repeat(32)}`;
    const t = rewrite(request.transaction, i);
    mined.set(hash, { i, tx: { from: account.address, to: t.to, input: t.data, value: t.value, gas: t.gas, maxFeePerGas: t.maxFeePerGas, maxPriorityFeePerGas: t.maxPriorityFeePerGas, chainId: request.chainId, nonce: 7 + i, blockNumber: 100n + BigInt(i) } });
    return { kind: "transaction", status: status(i), hash };
  };
  const publicClient = (chainId) => ({
    getChainId: async () => chainId,
    // The pending nonce: 7 plus every send asked of MetaMask so far.
    // `latest` (recover): the confirmed nonce, 7 plus every mined transaction unless the test says otherwise.
    getTransactionCount: async ({ blockTag }) => { if (blockTag === "latest") return confirmed ?? 7 + [...mined.values()].filter((m) => m.tx.blockNumber !== null).length; nonce(n); return 7 + n; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    waitForTransactionReceipt: async ({ hash }) => ({ status: receipt(mined.get(hash).i) }),
    getTransaction: async ({ hash }) => { const m = mined.get(hash); if (m === undefined) throw new Error("TransactionNotFoundError"); readback(m.i); return m.tx; },
    getTransactionReceipt: async ({ hash }) => { const m = mined.get(hash); if (m === undefined || m.tx.blockNumber === null) throw new Error("TransactionReceiptNotFoundError"); return { status: receipt(m.i) }; },
    readContract: async ({ functionName }) => (functionName === "balanceOf" ? balance : allowance),
  });
  const c = { walletStateManager: { read: () => ({ byokWallets: [{ id: "w1", address: account.address, namespace: "eip155" }], selectedWallet: { mode: "byok", namespace: "eip155", ref: { id: "w1" } }, pendingJobs: jobs }) }, publicClient, walletExecutor: async () => run, journalDir };
  return { c, requests, mined, jobs, journalDir };
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
  assert.equal(body.execution_state, "SENT");
  assert.match(shown.hint, /never send it again/);
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
  assert.equal(JSON.parse(shown.message).transfer_sent, "NO");
  assert.equal(JSON.parse(shown.message).execution_state, "APPROVAL_ONLY");
  assert.match(shown.hint, /no transfer/);
});

test("approve-fee: one bounded approve to Permit2 on Base; a foreign --address is refused before anything is sent (B-1)", async () => {
  const w = wallet({ allowance: 0n });
  const out = await runCommand(spec("recta:approve-fee"), w.c, {}, { "amount-usdc": "0.5" }, collectingRecta().f);
  assert.equal(out.approved_usdc_atomic, "500000");
  assert.equal(out.execution_state, "SENT");
  // B-1 (owner 21:16): the identity is proven by a signature before the approval is asked for.
  assert.deepEqual(w.requests.map((r) => r.request.kind), ["message", "transaction"]);
  assert.match(w.requests[0].request.message, new RegExp(`^Recta: ${account.address} approves USDC to Permit2`));
  const { request } = w.requests[1];
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

test("R-1: MetaMask stops tracking the transfer but gives its hash: UNKNOWN, never 'did not send'", async () => {
  for (const state of ["CONFIRMATION_TRACKING_EXPIRED", "BROADCAST_TRACKING_EXPIRED"]) {
    const { shown } = await transferSent({ status: (i) => (i === 1 ? state : "CONFIRMED") });
    assert.equal(shown.code, "RECTA_SEND_UNKNOWN", state);
    const body = JSON.parse(shown.message);
    assert.equal(body.check, "wallet_unconfirmed");
    assert.equal(body.execution_state, "UNKNOWN");
    assert.equal(body.transfer_sent, "UNKNOWN");
    assert.equal(body.unconfirmed_tx_hash, `0x${"02".repeat(32)}`);
    assert.equal(body.nonce, 8);
    assert.match(shown.hint, /Recta will send nothing more from this wallet until this is resolved.*mm recta recover/);
    assert.match(shown.hint, new RegExp(`mm recta report --result-id r_test --origin-tx-hash 0x${"02".repeat(32)}`));
    assert.doesNotMatch(shown.message, /did not send/);
  }
});

/** U-1: every way a send can end without a hash. */
const unknownTransfer = (shown) => {
  assert.equal(shown.code, "RECTA_SEND_UNKNOWN");
  const body = JSON.parse(shown.message);
  assert.equal(body.execution_state, "UNKNOWN");
  assert.equal(body.transfer_sent, "UNKNOWN");
  assert.equal(body.result_id, "r_test");
  assert.equal(body.chain_id, 8453);
  assert.equal(body.address, account.address);
  assert.equal(body.to, artifact().transactions[1].to);
  assert.equal(body.nonce, 8, "the nonce read before the transfer (the approval used 7)");
  assert.equal(body.unconfirmed_tx_hash, undefined);
  assert.deepEqual(body.approval_tx_hashes, [`0x${"01".repeat(32)}`]);
  assert.match(shown.hint, /nonce 8 when it was asked; no hash is known\), now or later.*Recta will send nothing more from this wallet until this is resolved.*Run mm recta recover/);
  assert.match(shown.hint, /mm recta report --result-id r_test --origin-tx-hash <its hash>/);
  assert.doesNotMatch(shown.message + shown.hint, /did not send|no transfer/);
  return body;
};

test("U-1 (Y1): the call that sends the transfer dies without an answer: UNKNOWN with result_id, nonce, to", async () => {
  const { shown } = await transferSent({ answer: (i) => { if (i === 1) throw new Error("socket hang up"); } });
  assert.equal(unknownTransfer(shown).check, "wallet_send_unknown");
});

test("U-1 (Y4): MetaMask answers a failure or a tracking timeout without a hash: UNKNOWN, never 'did not send'", async () => {
  for (const status of ["CONFIRMATION_TRACKING_EXPIRED", "BROADCAST_TRACKING_EXPIRED", "BROADCAST_FAILED", "FAILED", undefined]) {
    const { shown } = await transferSent({ answer: (i) => (i === 1 ? { kind: "transaction", ...(status === undefined ? {} : { status }) } : undefined) });
    unknownTransfer(shown);
  }
  const { shown } = await transferSent({ answer: (i) => (i === 1 ? { kind: "transaction", status: "FAILED", failureCode: "SIGN_FAILED" } : undefined) });
  unknownTransfer(shown);
});

test("U-1: only DENIED or EXPIRED without a hash prove the transfer was not signed", async () => {
  for (const status of ["DENIED", "EXPIRED"]) {
    const { shown, w } = await transferSent({ answer: (i) => (i === 1 ? { kind: "transaction", status } : undefined) });
    assert.equal(shown.code, "RECTA_APPROVAL_SENT", status);
    const body = JSON.parse(shown.message);
    assert.equal(body.execution_state, "APPROVAL_ONLY");
    assert.equal(body.transfer_sent, "NO");
    assert.match(body.message, /MetaMask did not send/);
    assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 2, "nothing is retried");
  }
});

test("U-1 (Y2): the call that sends the route's approval dies: UNKNOWN for the approval, and the transfer is never asked for", async () => {
  const { shown, w } = await transferSent({ answer: (i) => { if (i === 0) throw new Error("socket hang up"); } });
  assert.equal(shown.code, "RECTA_SEND_UNKNOWN");
  const body = JSON.parse(shown.message);
  assert.equal(body.execution_state, "UNKNOWN");
  assert.equal(body.transfer_sent, "NO");
  assert.equal(body.nonce, 7);
  assert.equal(body.to.toLowerCase(), pins.USDC_BASE.toLowerCase());
  assert.match(shown.hint, /may have broadcast an approval/);
  assert.match(shown.hint, /Recta will send nothing more from this wallet until this is resolved.*mm recta recover/);
  assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 1);
});

test("U-1: the nonce cannot be read before a send: nothing is asked of MetaMask, NOT_SENT", async () => {
  const { shown, w } = await transferSent({ nonce: (n) => { if (n === 1) throw new Error("429"); } });
  assert.equal(shown.code, "RECTA_APPROVAL_SENT", "the approval left, the transfer was never asked for");
  assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 1);
  const w0 = wallet({ allowance: 0n, nonce: () => { throw new Error("429"); } });
  const e = await runCommand(spec("recta:approve-fee"), w0.c, {}, { "amount-usdc": "0.5" }, collectingRecta().f).catch((x) => x);
  const shown0 = commandErrorOf(sdkErr, e);
  assert.equal(shown0.code, "RECTA_NOT_SENT");
  assert.equal(JSON.parse(shown0.message).check, "wallet_nonce");
  assert.equal(w0.requests.filter((r) => r.request.kind === "transaction").length, 0);
});

/** approve-fee's answer as mm shows it. */
const approveFee = async (opts) => {
  const w = wallet({ allowance: 0n, ...opts });
  const e = await runCommand(spec("recta:approve-fee"), w.c, {}, { "amount-usdc": "0.5" }, collectingRecta().f).catch((x) => x);
  return { shown: commandErrorOf(sdkErr, e), w };
};

test("U-2 (Y3): approve-fee: the send dies, fails without a hash, or fails with one: UNKNOWN with nonce and to", async () => {
  for (const opts of [
    { answer: () => { throw new Error("socket hang up"); } },
    { answer: () => ({ kind: "transaction", status: "BROADCAST_FAILED" }) },
    { status: () => "CONFIRMATION_TRACKING_EXPIRED" },
  ]) {
    const { shown } = await approveFee(opts);
    assert.equal(shown.code, "RECTA_SEND_UNKNOWN");
    const body = JSON.parse(shown.message);
    assert.equal(body.execution_state, "UNKNOWN");
    assert.equal(body.nonce, 7);
    assert.equal(body.to.toLowerCase(), pins.USDC_BASE.toLowerCase());
    assert.match(shown.hint, /may have broadcast an approval/);
    assert.match(shown.hint, /do not send the approval again/i);
  }
});

test("U-2: approve-fee: MetaMask denies (NOT_SENT), or the approval cannot be read back (sent: not again)", async () => {
  const denied = await approveFee({ answer: () => ({ kind: "transaction", status: "DENIED" }) });
  assert.equal(denied.shown.code, "RECTA_NOT_SENT");
  assert.equal(JSON.parse(denied.shown.message).execution_state, "NOT_SENT");
  const unread = await approveFee({ readback: () => { throw new Error("TransactionNotFoundError"); } });
  assert.equal(unread.shown.code, "RECTA_APPROVAL_SENT");
  assert.deepEqual(JSON.parse(unread.shown.message).approval_tx_hashes, [`0x${"01".repeat(32)}`]);
  assert.match(unread.shown.hint, /Do not send the approval again/);
  // A refused identity proof sends nothing.
  const refusedProof = await approveFee({ sign: () => ({ kind: "signature", status: "DENIED" }) });
  assert.equal(refusedProof.shown.code, "RECTA_NOT_SENT");
  assert.equal(refusedProof.w.requests.filter((r) => r.request.kind === "transaction").length, 0);
});

test("U-2: pay-debt refuses an offer for another payer and stops at a denied signature, sending nothing to Recta", async () => {
  const { f, seen } = collectingRecta();
  const offer = { ...feeOffer("DEBT"), permit: { payer: other.address } };
  const w = wallet();
  await assert.rejects(runCommand(spec("recta:pay-debt"), w.c, {}, { "debt-offer": JSON.stringify(offer) }, f), /another payer/);
  assert.equal(w.requests.length, 0);
  const d = wallet({ sign: (r) => (r.kind === "typed-data" ? { kind: "signature", status: "DENIED" } : undefined) });
  await assert.rejects(runCommand(spec("recta:pay-debt"), d.c, {}, { "debt-offer": JSON.stringify(feeOffer("DEBT")) }, f), /MetaMask did not sign/);
  assert.equal(seen.filter((r) => r.path.endsWith("/fee-debts")).length, 0);
  const t = wallet({ sign: (r) => { if (r.kind === "typed-data") throw new Error("socket hang up"); } });
  await assert.rejects(runCommand(spec("recta:pay-debt"), t.c, {}, { "debt-offer": JSON.stringify(feeOffer("DEBT")) }, f));
  assert.equal(seen.filter((r) => r.path.endsWith("/fee-debts")).length, 0);
});

test("U-1: a successful move --execute says SENT; a run that stops before sending says NOT_SENT", async () => {
  const { f } = collectingRecta();
  assert.equal((await runCommand(spec("recta:move"), wallet().c, {}, move, f)).execution_state, "SENT");
  const e = await runCommand(spec("recta:move"), wallet().c, {}, { ...move, amount: "1" }, f).catch((x) => x);
  const shown = commandErrorOf(sdkErr, e);
  assert.equal(shown.code, "RECTA_NOT_SENT");
  assert.equal(JSON.parse(shown.message).transfer_sent, "NO");
});

test("R-2: a transfer that reverted on chain moved nothing: the agent is told its own route is free", async () => {
  const { shown } = await transferSent({ receipt: (i) => (i === 1 ? "reverted" : "success") });
  assert.equal(shown.code, "RECTA_TRANSFER_REVERTED");
  const body = JSON.parse(shown.message);
  assert.equal(body.transfer_sent, "NO");
  assert.equal(body.reverted_tx_hash, `0x${"02".repeat(32)}`);
  assert.match(shown.hint, /moved nothing/);
  assert.match(shown.hint, new RegExp(`approval 0x${"01".repeat(32)} to the route's contract was mined and still stands`));
  assert.equal(body.execution_state, "REVERTED");
  assert.doesNotMatch(shown.hint, /do not send/i);
});

// ---- Owner 2026-11-11 21:22, Fable P-1/P-2/P-3 on e2636b9: the journal, the block, and recover. ----

const TRANSFER_HASH = `0x${"7e".repeat(32)}`;
const transferOnChain = (overrides = {}) => {
  const t = artifact().transactions[1];
  return { from: account.address, to: t.to, input: t.data, value: 0n, gas: BigInt(t.gas_limit), maxFeePerGas: 14_000_000n, maxPriorityFeePerGas: 1_000_000n, chainId: 8453, nonce: 8, blockNumber: 120n, ...overrides };
};
const journalOf = (w) => JSON.parse(readFileSync(join(w.journalDir, `${account.address.toLowerCase()}.json`), "utf8")).attempts;
const dies = { answer: (i) => { if (i === 1) throw new Error("timeout waiting for MFA"); } };
const recoverRun = async (w, flags = {}) => runCommand(spec("recta:recover"), w.c, {}, flags, collectingRecta().f);

test("P-1: the attempt is on disk (fsynced, 0600) before MetaMask is asked; a process killed mid-send leaves it UNKNOWN and the rerun is refused", async () => {
  let onDisk;
  let asked;
  const reached = new Promise((r) => { asked = r; });
  const w = wallet({ answer: (i) => {
    if (i !== 1) return undefined;
    onDisk = journalOf(w);
    asked();
    return new Promise(() => {}); // the process dies here: MetaMask never answers
  } });
  void runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch(() => {});
  await reached;
  const transfer = onDisk.find((a) => !a.approval);
  assert.equal(transfer.state, "UNKNOWN");
  assert.equal(transfer.result_id, "r_test");
  assert.equal(transfer.nonce, 8);
  assert.equal(transfer.to, artifact().transactions[1].to.toLowerCase());
  assert.deepEqual(transfer.economic, { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "10" });
  assert.equal(statSync(join(w.journalDir, `${account.address.toLowerCase()}.json`)).mode & 0o777, 0o600);
  // The dead process's lock is left behind with a pid that no longer runs.
  writeFileSync(join(w.journalDir, `${account.address.toLowerCase()}.lock`), "2147483646");
  const again = wallet({ journalDir: w.journalDir });
  const { f, seen } = collectingRecta();
  const shown = commandErrorOf(sdkErr, await runCommand(spec("recta:move"), again.c, {}, move, f).catch((x) => x));
  assert.equal(shown.code, "RECTA_SEND_UNKNOWN");
  const body = JSON.parse(shown.message);
  assert.equal(body.error, "UNRESOLVED_SEND");
  assert.equal(body.this_run, "NOT_SENT");
  assert.equal(body.unresolved_attempts[0].result_id, "r_test");
  assert.match(shown.hint, /mm recta recover/);
  assert.equal(again.requests.length, 0, "nothing is signed or sent");
  assert.equal(seen.length, 0, "Recta is not even asked to evaluate");
});

test("P-2: MetaMask's MFA times out on the transfer: the identical rerun, and approve-fee, are refused until recover resolves it", async () => {
  const w = wallet(dies);
  const first = commandErrorOf(sdkErr, await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch((x) => x));
  assert.equal(first.code, "RECTA_SEND_UNKNOWN");
  assert.doesNotMatch(first.hint, /nothing from this attempt was broadcast|still unused/);
  const before = w.requests.length;
  for (const [id, flags] of [["recta:move", move], ["recta:approve-fee", { "amount-usdc": "0.5" }]]) {
    const shown = commandErrorOf(sdkErr, await runCommand(spec(id), w.c, {}, flags, collectingRecta().f).catch((x) => x));
    assert.equal(shown.code, "RECTA_SEND_UNKNOWN", id);
  }
  assert.equal(w.requests.length, before, "no request reaches MetaMask");
  // Free and read-only commands still work.
  assert.equal((await runCommand(spec("recta:move"), w.c, {}, { ...move, execute: false }, collectingRecta().f)).execution_state, undefined);
});

test("P-3: the MFA request is approved late: recover finds MetaMask's job and its transaction, says SENT CONFIRMED and how to report, and unblocks", async () => {
  const w = wallet(dies);
  await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch(() => {});
  w.jobs.push({ pollingId: "job-late", kind: "transaction", status: "CONFIRMED", txHash: TRANSFER_HASH, chainId: 8453, submittedAt: new Date().toISOString() });
  w.mined.set(TRANSFER_HASH, { i: 50, tx: transferOnChain() });
  const out = await recoverRun(w);
  assert.equal(out.blocked, false);
  const [a] = out.attempts;
  assert.equal(a.state, "SENT");
  assert.equal(a.chain_status, "CONFIRMED");
  assert.equal(a.tx_hash, TRANSFER_HASH);
  assert.equal(a.mm_request, "job-late");
  assert.match(out.next, new RegExp(`never send it again.*mm recta report --result-id r_test --origin-tx-hash ${TRANSFER_HASH} --approval-tx-hash 0x${"01".repeat(32)}`));
  assert.equal((await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f)).execution_state, "SENT", "a new move runs once resolved");
});

test("P-3: recover never reads absence as 'not sent': open, failed or missing evidence stays UNKNOWN and blocked", async () => {
  const cases = [
    ["an MFA request still open", (w) => w.jobs.push({ pollingId: "j", kind: "transaction", status: "AWAITING_MFA", chainId: 8453, submittedAt: new Date().toISOString() }), /still open/],
    ["a request that FAILED without a hash", (w) => w.jobs.push({ pollingId: "j", kind: "transaction", status: "FAILED", chainId: 8453, submittedAt: new Date().toISOString() }), /ended FAILED without a hash/],
    ["no request and the nonce unused", () => {}, /nonce 8 of this wallet is not used yet.*does not prove/],
    ["a hash MetaMask gave that the chain does not know yet", (w) => w.jobs.push({ pollingId: "j", kind: "transaction", status: "BROADCASTED", txHash: TRANSFER_HASH, chainId: 8453, submittedAt: new Date().toISOString() }), /not on chain 8453 yet \(that is not proof/],
    ["the nonce used, by a transaction not found", (w) => { w.mined.set(`0x${"99".repeat(32)}`, { i: 60, tx: transferOnChain({ nonce: 3 }) }); }, /nonce 8 of this wallet has been used .*pass it with --tx-hash/],
  ];
  for (const [what, arrange, evidence] of cases) {
    const w = wallet({ ...dies, ...(what.startsWith("the nonce used") ? { confirmed: 9 } : {}) });
    await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch(() => {});
    arrange(w);
    const out = await recoverRun(w);
    assert.equal(out.blocked, true, what);
    assert.equal(out.attempts[0].state, "UNKNOWN", what);
    assert.match(out.attempts[0].evidence, evidence, what);
    assert.equal(commandErrorOf(sdkErr, await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch((x) => x)).code, "RECTA_SEND_UNKNOWN", what);
  }
});

test("P-3: recover resolves only on evidence: DENIED request → NOT_SENT; nonce taken by another identified mined tx → NOT_SENT; pending → SENT PENDING (blocked); reverted → REVERTED", async () => {
  const run = async (arrange, flags = {}) => {
    const w = wallet(dies);
    await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch(() => {});
    arrange(w);
    return { out: await recoverRun(w, flags), w };
  };
  const denied = await run((w) => w.jobs.push({ pollingId: "j", kind: "transaction", status: "DENIED", chainId: 8453, submittedAt: new Date().toISOString() }));
  assert.equal(denied.out.attempts[0].state, "NOT_SENT");
  assert.equal(denied.out.blocked, false);
  const other = `0x${"aa".repeat(32)}`;
  const taken = await run((w) => w.mined.set(other, { i: 70, tx: { ...transferOnChain(), to: account.address, input: "0x", nonce: 8 } }), { "tx-hash": other });
  assert.equal(taken.out.attempts[0].state, "NOT_SENT");
  assert.match(taken.out.attempts[0].evidence, /nonce 8 .* taken by another mined transaction/);
  const pending = await run((w) => w.mined.set(TRANSFER_HASH, { i: 71, tx: transferOnChain({ blockNumber: null }) }), { "tx-hash": TRANSFER_HASH });
  assert.equal(pending.out.attempts[0].state, "SENT");
  assert.equal(pending.out.attempts[0].chain_status, "PENDING");
  assert.equal(pending.out.blocked, true, "a transfer not yet mined still blocks");
  const reverted = await run((w) => w.mined.set(TRANSFER_HASH, { i: 72, tx: transferOnChain() }), { "tx-hash": TRANSFER_HASH });
  // wallet() reports receipt "success" by default; a reverted one:
  const rw = wallet({ ...dies, receipt: (i) => (i === 73 ? "reverted" : "success") });
  await runCommand(spec("recta:move"), rw.c, {}, move, collectingRecta().f).catch(() => {});
  rw.mined.set(TRANSFER_HASH, { i: 73, tx: transferOnChain() });
  const r = await recoverRun(rw, { "tx-hash": TRANSFER_HASH });
  assert.equal(r.attempts[0].state, "REVERTED");
  assert.equal(r.blocked, false);
  assert.equal(reverted.out.attempts[0].chain_status, "CONFIRMED");
});

test("P-3: recover checks a given hash, never trusts it: another sender, or another tx with an open MetaMask request, stays UNKNOWN", async () => {
  const w = wallet(dies);
  await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch(() => {});
  w.mined.set(TRANSFER_HASH, { i: 80, tx: transferOnChain({ from: other.address }) });
  let out = await recoverRun(w, { "tx-hash": TRANSFER_HASH });
  assert.equal(out.attempts[0].state, "UNKNOWN");
  assert.match(out.attempts[0].evidence, /sent from 0x.*not from this wallet/);
  const x = `0x${"bb".repeat(32)}`;
  w.mined.set(x, { i: 81, tx: { ...transferOnChain(), to: account.address, input: "0x", nonce: 8 } });
  w.jobs.push({ pollingId: "j", kind: "transaction", status: "AWAITING_MFA", chainId: 8453, submittedAt: new Date().toISOString() });
  out = await recoverRun(w, { "tx-hash": x });
  assert.equal(out.attempts[0].state, "UNKNOWN", "MetaMask may still send it with another nonce");
  await assert.rejects(recoverRun(w, { "tx-hash": "0x12" }), /--tx-hash must be/);
});

test("P-1: a journal that cannot be written or read sends nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "recta-journal-"));
  const asFile = join(dir, "file");
  writeFileSync(asFile, "x");
  for (const journalDir of [asFile, dir]) {
    if (journalDir === dir) mkdirSync(join(dir, `${account.address.toLowerCase()}.json`)); // unreadable: a directory
    const w = wallet({ journalDir });
    const shown = commandErrorOf(sdkErr, await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch((x) => x));
    assert.equal(shown.code, "RECTA_NOT_SENT", journalDir);
    assert.equal(JSON.parse(shown.message).check, "journal");
    assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 0);
  }
  // A corrupt journal is never read as empty.
  const bad = mkdtempSync(join(tmpdir(), "recta-journal-"));
  writeFileSync(join(bad, `${account.address.toLowerCase()}.json`), "{");
  const w = wallet({ journalDir: bad });
  assert.equal(commandErrorOf(sdkErr, await runCommand(spec("recta:approve-fee"), w.c, {}, { "amount-usdc": "0.5" }, collectingRecta().f).catch((x) => x)).code, "RECTA_NOT_SENT");
  assert.equal(w.requests.filter((r) => r.request.kind === "transaction").length, 0);
});

test("P-2: a live mm recta process sending from the same wallet blocks a second one", async () => {
  const w = wallet();
  writeFileSync(join(w.journalDir, `${account.address.toLowerCase()}.lock`), String(process.ppid));
  const shown = commandErrorOf(sdkErr, await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch((x) => x));
  assert.equal(shown.code, "RECTA_NOT_SENT");
  assert.equal(JSON.parse(shown.message).check, "wallet_busy");
  assert.equal(w.requests.length, 0);
});

test("a mined transaction from another sender (a smart account's bundle) is UNKNOWN, not SENT", async () => {
  const w = wallet({ rewrite: (t, i) => t });
  const executor = await w.c.walletExecutor();
  // MetaMask's transfer hash turns out to be mined from another address.
  w.c.walletExecutor = async () => async (req, opts) => {
    const out = await executor(req, opts);
    if (req.kind === "transaction" && w.mined.size === 2) w.mined.get(out.hash).tx.from = other.address;
    return out;
  };
  const shown = commandErrorOf(sdkErr, await runCommand(spec("recta:move"), w.c, {}, move, collectingRecta().f).catch((x) => x));
  assert.equal(shown.code, "RECTA_SEND_UNKNOWN");
  assert.equal(JSON.parse(shown.message).check, "wallet_foreign_sender");
  assert.equal(journalOf(w).find((x) => !x.approval).state, "UNKNOWN");
});
