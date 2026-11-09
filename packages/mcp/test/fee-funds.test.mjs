// ASTRA T2 / K2: a fee permit is never signed, and no route transaction is sent, unless the payer holds the permit's
// amount in USDC on Base and has approved Permit2 for it; the approval this package builds is always bounded.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRectaClient, permit2ApprovalTransaction, pins } from "@recta/client";
import { createLocalServer } from "../dist/server.js";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const args = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "100", baseline_provider: "stargate_v2" };
const NOW = 1_800_000_000_000;
const expiry = String(NOW / 1000 + 3600);

const offer = (amount = "500000") => ({
  max_fee_authorization_usdc_atomic: amount,
  carried_usdc_atomic: "0",
  commercial_expiry_unix: expiry,
  typed_data: {
    domain: { name: "Permit2", chainId: 8453, verifyingContract: pins.PERMIT2 },
    types: pins.FEE_PERMIT_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: pins.USDC_BASE, amount },
      spender: pins.UPTO_PROXY,
      nonce: "7",
      deadline: String(Number(expiry) + 86_400),
      witness: { to: pins.FEE_RECEIVER, facilitator: pins.FEE_FACILITATOR, validAfter: "0" },
    },
  },
});

/** Recta with collection on: the evaluation has a saving and the artifact asks for the fee permit first. */
function collectingRecta() {
  const posted = [];
  const f = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    if (path.endsWith("/fee-authorization") || path.endsWith("/fee-debts")) { posted.push(path); return new Response(JSON.stringify({ artifact: {} }), { status: 200 }); }
    if (path.endsWith("/execution-artifact")) return new Response(JSON.stringify({ status: "SIGNATURE_REQUIRED", commercial_expiry_unix: expiry, fee_authorization: offer() }), { status: 402 });
    return new Response(JSON.stringify({ result_id: "r_test", decision: { state: "VERIFIED_POSITIVE" } }), { status: 200 });
  };
  return { f, posted };
}

function wallet(funds) {
  const signed = [];
  const sent = [];
  return {
    signed,
    sent,
    signer: {
      address: account.address,
      signMessage: (message) => account.signMessage({ message }),
      signTypedData: async (td) => { signed.push(td); return account.signTypedData(td); },
      sendTransaction: async (tx) => { sent.push(tx); return `0x${"cd".repeat(32)}`; },
    },
    chain: { waitForSuccess: async () => true, readFeeFunds: async () => funds },
  };
}

function server(w, f, allowExecute = true) {
  return createLocalServer({ signer: w.signer, chain: w.chain, limits, allowExecute, fetch: f, now: () => NOW, gasCapsFor: async () => [7_000_000n, 1_000_000n] });
}

const usdc = (n) => BigInt(Math.round(n * 1e6));

for (const [label, funds, check] of [
  ["a new wallet: USDC but allowance zero", { balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: 0n }, "fee_allowance"],
  ["allowance but too little USDC", { balanceUsdcAtomic: usdc(0.1), permit2AllowanceUsdcAtomic: usdc(1) }, "fee_balance"],
  ["an allowance revoked down to below the permit", { balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: usdc(0.4) }, "fee_allowance"],
]) {
  test(`K2, ${label}: execute refuses before signing the permit or sending anything`, async () => {
    const { f, posted } = collectingRecta();
    const w = wallet(funds);
    const s = server(w, f);
    await s.call("recta_evaluate", args);
    await assert.rejects(s.call("recta_execute", { result_id: "r_test" }), (e) => e.check === check && /Nothing was signed/.test(e.message));
    assert.equal(w.signed.length, 0);
    assert.equal(w.sent.length, 0);
    assert.equal(posted.length, 0);
  });
}

test("K2, preview: reports what is short and still signs nothing", async () => {
  const { f, posted } = collectingRecta();
  const w = wallet({ balanceUsdcAtomic: usdc(200), permit2AllowanceUsdcAtomic: 0n });
  const s = server(w, f, false);
  await s.call("recta_evaluate", args);
  const p = await s.call("recta_preview", { result_id: "r_test" });
  assert.equal(p.fee_funds.ready, false);
  assert.deepEqual(p.fee_funds.missing, ["allowance"]);
  assert.match(p.note, /allowance short/);
  assert.equal(w.signed.length, 0);
  assert.equal(posted.length, 0);
});

test("K2, preview with a reader that cannot reach Base: funds unchecked, nothing signed", async () => {
  const { f } = collectingRecta();
  const w = wallet(undefined);
  w.chain.readFeeFunds = async () => { throw new Error("no Base RPC"); };
  const s = server(w, f, false);
  await s.call("recta_evaluate", args);
  const p = await s.call("recta_preview", { result_id: "r_test" });
  assert.deepEqual(p.fee_funds, { checked: false, error: "no Base RPC" });
  assert.equal(w.signed.length, 0);
});

test("with balance and allowance covering the permit, the permit is signed and stored", async () => {
  const { f, posted } = collectingRecta();
  const w = wallet({ balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: usdc(0.5) });
  const client = createRectaClient({ signer: w.signer, chain: w.chain, limits, fetch: f, now: () => NOW });
  const out = await client.authorizeFee("r_test");
  assert.equal(out.fee.kind, "AUTHORIZED");
  assert.equal(w.signed.length, 1);
  assert.equal(posted.length, 1);
});

test("a debt permit is refused the same way when the allowance is short", async () => {
  const { f, posted } = collectingRecta();
  const w = wallet({ balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: 0n });
  const client = createRectaClient({ signer: w.signer, chain: w.chain, limits, fetch: f, now: () => NOW });
  const debt = { ...offer(), debt_id: "d_1", amount_usdc_atomic: "500000" };
  await assert.rejects(client.payDebt(debt), (e) => e.check === "fee_allowance");
  assert.equal(w.signed.length, 0);
  assert.equal(posted.length, 0);
});

test("the approval is exact and bounded: USDC.approve(Permit2, amount) on Base, never unlimited, never above the cap", async () => {
  const tx = permit2ApprovalTransaction(1_000_000n);
  assert.equal(tx.chainId, 8453);
  assert.equal(tx.to.toLowerCase(), pins.USDC_BASE);
  const { functionName, args: a } = decodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), data: tx.data });
  assert.equal(functionName, "approve");
  assert.equal(a[0].toLowerCase(), pins.PERMIT2);
  assert.equal(a[1], 1_000_000n);
  assert.throws(() => permit2ApprovalTransaction(0n), (e) => e.check === "fee_approval");
  assert.throws(() => permit2ApprovalTransaction(2n ** 256n - 1n), (e) => e.check === "fee_approval");
  assert.throws(() => permit2ApprovalTransaction(2n ** 160n - 1n), (e) => e.check === "fee_approval");
  const client = createRectaClient({ signer: wallet({}).signer, chain: wallet({}).chain, limits, fetch: async () => new Response("{}"), now: () => NOW });
  assert.throws(() => client.feeApproval(1_000_001n), (e) => e.check === "fee_approval");
});

test("recta_approve_fee: only with execution on, at most the operator's cap, then reports the funds", async () => {
  const { f } = collectingRecta();
  const off = wallet({ balanceUsdcAtomic: 0n, permit2AllowanceUsdcAtomic: 0n });
  await assert.rejects(server(off, f, false).call("recta_approve_fee", {}), (e) => e.check === "execution_disabled");
  assert.equal(off.sent.length, 0);

  const w = wallet({ balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: usdc(1) });
  const s = server(w, f);
  await assert.rejects(s.call("recta_approve_fee", { amount_usdc: "1.5" }), (e) => e.check === "fee_approval");
  await assert.rejects(s.call("recta_approve_fee", { amount_usdc: "lots" }), (e) => e.check === "input");
  assert.equal(w.sent.length, 0);
  const out = await s.call("recta_approve_fee", { amount_usdc: "0.75" });
  assert.equal(out.approved_usdc_atomic, "750000");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].chainId, 8453);
  assert.equal(w.sent[0].value, 0n);
  assert.equal(out.fee_funds.ready, true);
});

test("tools/list: recta_fee_funds always; recta_approve_fee only with execution on", async () => {
  const names = async (allow) => (await server(wallet({}), collectingRecta().f, allow).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
  assert.ok((await names(false)).includes("recta_fee_funds"));
  assert.ok(!(await names(false)).includes("recta_approve_fee"));
  assert.ok((await names(true)).includes("recta_approve_fee"));
});

// Fable B-1 / M-1 / M-2 / L-1 on recta #12.
const baseUsdc = { ...args, amount: "100" };

test("B-1: a route from Base USDC must leave the fee in the balance after the transfer, or nothing is signed", async () => {
  const { f, posted } = collectingRecta();
  const w = wallet({ balanceUsdcAtomic: usdc(100), permit2AllowanceUsdcAtomic: usdc(1) });
  const s = server(w, f);
  await s.call("recta_evaluate", baseUsdc);
  await assert.rejects(s.call("recta_execute", { result_id: "r_test" }), (e) => e.check === "fee_balance" && /the transfer itself/.test(e.message));
  assert.equal(w.signed.length, 0);
  assert.equal(w.sent.length, 0);
  assert.equal(posted.length, 0);
  const p = await server(w, f, false);
  await p.call("recta_evaluate", baseUsdc);
  const preview = await p.call("recta_preview", { result_id: "r_test" });
  assert.equal(preview.fee_funds.reservedForRouteUsdcAtomic, "100000000");
  assert.deepEqual(preview.fee_funds.missing, ["balance"]);
});

test("B-1: with the transfer plus the fee in the balance, it signs", async () => {
  const { f, posted } = collectingRecta();
  const w = wallet({ balanceUsdcAtomic: usdc(100.5), permit2AllowanceUsdcAtomic: usdc(0.5) });
  const client = createRectaClient({ signer: w.signer, chain: w.chain, limits, fetch: f, now: () => NOW });
  const out = await client.authorizeFee("r_test", { request: { ...baseUsdc, sender: account.address, recipient: account.address } });
  assert.equal(out.fee.kind, "AUTHORIZED");
  assert.equal(posted.length, 1);
});

test("M-1: a permit stored earlier (ALREADY_AUTHORIZED) is checked again before any transaction is sent", async () => {
  const stored = { status: "AUTHORIZED", max_fee_authorization_usdc_atomic: "500000", carried_usdc_atomic: "0" };
  const f = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    if (path.endsWith("/execution-artifact")) return new Response(JSON.stringify({ fee_authorization: stored, artifact: { any: "artifact" } }), { status: 200 });
    return new Response(JSON.stringify({ result_id: "r_test", decision: { state: "VERIFIED_POSITIVE" } }), { status: 200 });
  };
  const w = wallet({ balanceUsdcAtomic: 0n, permit2AllowanceUsdcAtomic: 0n });
  let reads = 0;
  const inner = w.chain.readFeeFunds;
  w.chain.readFeeFunds = async (o) => { reads += 1; return inner(o); };
  const client = createRectaClient({ signer: w.signer, chain: w.chain, limits, fetch: f, now: () => NOW });
  const { fee } = await client.authorizeFee("r_test");
  assert.equal(fee.kind, "ALREADY_AUTHORIZED");
  await assert.rejects(client.execute("r_test", { any: "artifact" }, { ...args, sender: account.address, recipient: account.address }), (e) => e.check === "fee_allowance");
  assert.equal(reads, 1);
  assert.equal(w.sent.length, 0);
  // A stored authorization without a readable amount is refused, never assumed.
  const bad = async (url) => new URL(String(url)).pathname.endsWith("/execution-artifact") ? new Response(JSON.stringify({ fee_authorization: { status: "AUTHORIZED" }, artifact: {} }), { status: 200 }) : f(url);
  await assert.rejects(createRectaClient({ signer: w.signer, chain: w.chain, limits, fetch: bad, now: () => NOW }).authorizeFee("r_test"), (e) => e.check === "fee_amount");
});

test("M-2: a reader error never carries the RPC URL (an API key may be in it)", async () => {
  const { safeErrorText } = await import("@recta/client");
  const e = Object.assign(new Error("HTTP request failed.\n\nURL: https://base.example/v2/SECRET-API-KEY-123\nVersion: viem"), { shortMessage: "HTTP request failed." });
  assert.equal(safeErrorText(e), "HTTP request failed.");
  assert.equal(safeErrorText(new Error("fetch failed for https://x.example/?apikey=SECRET-1 now")), "fetch failed for <url> now");
  const { f } = collectingRecta();
  const w = wallet(undefined);
  w.chain.readFeeFunds = async () => { throw new Error("boom at https://rpc.example/key/SECRET-2"); };
  const s = server(w, f, false);
  await s.call("recta_evaluate", args);
  const p = await s.call("recta_preview", { result_id: "r_test" });
  assert.ok(!JSON.stringify(p).includes("SECRET-2"));
  const reply = await s.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "recta_fee_funds", arguments: {} } });
  assert.ok(!JSON.stringify(reply).includes("SECRET-2"));
});

test("L-1: a chain reader without readFeeFunds is refused when the client is created", () => {
  const w = wallet({});
  assert.throws(() => createRectaClient({ signer: w.signer, chain: { waitForSuccess: async () => true }, limits, fetch: async () => new Response("{}") }), (e) => e.check === "chain_reader");
});

test("L-2: recta_fee_funds checks against the amount asked for", async () => {
  const w = wallet({ balanceUsdcAtomic: usdc(50), permit2AllowanceUsdcAtomic: usdc(0.5) });
  const s = server(w, collectingRecta().f, false);
  assert.equal((await s.call("recta_fee_funds", {})).ready, false);
  assert.equal((await s.call("recta_fee_funds", { amount_usdc: "0.5" })).ready, true);
  await assert.rejects(s.call("recta_fee_funds", { amount_usdc: "x" }), (e) => e.check === "input");
});
