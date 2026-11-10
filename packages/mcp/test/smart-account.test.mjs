// A smart account on Base (Recta BIT-ARCH-120): requests signed in the v2 text with the signer-chain header and checked by
// the account (ERC-1271, ERC-6492 before deployment); fee permits only once the account is deployed; route transactions
// sent as user operations bounded by the committed gas and fees; the approval never reported.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, decodeAbiParameters, hashMessage, keccak256, recoverTypedDataAddress } from "viem";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createRectaClient, pins, smartAccountSigner, smartAccountSignedRequestMessage } from "@recta/client";
import { configFromEnv } from "../dist/index.js";
import { createLocalServer } from "../dist/server.js";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const owner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ACCOUNT = "0x00000000000000000000000000000000000c0ffe";
const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const NOW = 1_800_000_000_000;
const expiry = String(NOW / 1000 + 3600);
const request = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "100", baseline_provider: "stargate_v2", sender: ACCOUNT, recipient: ACCOUNT };
const funds = { balanceUsdcAtomic: 200_000_000n, permit2AllowanceUsdcAtomic: 1_000_000n };
const ERC6492_MAGIC = "6492649264926492649264926492649264926492649264926492649264926492";

/** A Coinbase Smart Wallet on a fake Base node: deployed or not. */
async function coinbaseAccount(deployed) {
  const client = createPublicClient({
    chain: base,
    transport: custom({
      async request({ method }) {
        if (method === "eth_chainId") return "0x2105";
        if (method === "eth_getCode") return deployed ? "0x6080" : "0x";
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  return toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1", address: ACCOUNT });
}

function fakeBundler({ success = true } = {}) {
  const ops = [];
  return {
    ops,
    bundlerClient: {
      sendUserOperation: async (op) => { ops.push(op); return `0x${"aa".repeat(32)}`; },
      waitForUserOperationReceipt: async () => ({ success, reason: success ? undefined : "AA23 reverted", receipt: { transactionHash: `0x${"bb".repeat(32)}` } }),
    },
  };
}

const offer = () => ({
  max_fee_authorization_usdc_atomic: "500000",
  carried_usdc_atomic: "0",
  commercial_expiry_unix: expiry,
  typed_data: {
    domain: { name: "Permit2", chainId: 8453, verifyingContract: pins.PERMIT2 },
    types: pins.FEE_PERMIT_TYPES,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: pins.USDC_BASE, amount: "500000" },
      spender: pins.UPTO_PROXY,
      nonce: "7",
      deadline: String(Number(expiry) + 86_400),
      witness: { to: pins.FEE_RECEIVER, facilitator: pins.FEE_FACILITATOR, validAfter: "0" },
    },
  },
});

/** Recta with collection on; records every request it receives. */
function recta() {
  const seen = [];
  const f = async (url, init) => {
    const u = new URL(String(url));
    const body = init?.body === undefined ? new Uint8Array() : init.body;
    seen.push({ method: init?.method ?? "GET", path: `${u.pathname}${u.search}`, headers: init?.headers ?? {}, body });
    if (u.pathname.endsWith("/wallet-policy")) return new Response(policy, { status: 200 });
    if (u.pathname.endsWith("/fee-authorization")) return new Response(JSON.stringify({ artifact: {} }), { status: 200 });
    if (u.pathname.endsWith("/execution-artifact")) return new Response(JSON.stringify({ status: "SIGNATURE_REQUIRED", commercial_expiry_unix: expiry, fee_authorization: offer() }), { status: 402 });
    if (u.pathname.endsWith("/execution")) return new Response(JSON.stringify({ status: "ACCRUED" }), { status: 200 });
    return new Response(JSON.stringify({ result_id: "r_test", decision: { state: "VERIFIED_POSITIVE" } }), { status: 200 });
  };
  return { f, seen };
}

const chain = { waitForSuccess: async () => true, readFeeFunds: async () => funds };

/** The owner's signature inside a Coinbase Smart Wallet signature, recovered over the account's replay-safe hash. */
async function ownerOf(signature, hash) {
  const [wrapper] = decodeAbiParameters([{ type: "tuple", components: [{ name: "ownerIndex", type: "uint8" }, { name: "signatureData", type: "bytes" }] }], signature);
  return recoverTypedDataAddress({
    domain: { chainId: 8453, name: "Coinbase Smart Wallet", verifyingContract: ACCOUNT, version: "1" },
    types: { CoinbaseSmartWalletMessage: [{ name: "hash", type: "bytes32" }] },
    primaryType: "CoinbaseSmartWalletMessage",
    message: { hash },
    signature: wrapper.signatureData,
  });
}

test("a smart account signs Recta's v2 text, names Base in x-recta-signer-chain, and its owner's signature holds for the account", async () => {
  const { f, seen } = recta();
  const signer = smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler() });
  assert.equal(signer.smartAccountChainId, 8453);
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  await client.evaluate(request, { idempotencyKey: "k1" });
  const post = seen.find((r) => r.method === "POST");
  assert.equal(post.headers["x-recta-signer-chain"], "8453");
  assert.equal(post.headers["x-recta-signer"].toLowerCase(), ACCOUNT);
  const text = smartAccountSignedRequestMessage({ method: "POST", path: post.path, idempotencyKey: "k1", bodyKeccak256: keccak256(post.body), issuedAt: Number(post.headers["x-recta-issued-at"]), signer: ACCOUNT, chainId: 8453 });
  assert.match(text, /^Recta signed request v2\nsigner: 0x0+c0ffe\nchain-id: 8453\nmethod: POST\n/);
  assert.equal(await ownerOf(post.headers["x-recta-signature"], hashMessage(text)), owner.address);
});

test("an undeployed account signs requests in ERC-6492, but never a fee permit (Permit2 cannot deploy it)", async () => {
  const { f, seen } = recta();
  const signer = smartAccountSigner({ account: await coinbaseAccount(false), ...fakeBundler() });
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  await client.evaluate(request);
  assert.ok(seen.find((r) => r.method === "POST").headers["x-recta-signature"].endsWith(ERC6492_MAGIC));
  await assert.rejects(client.authorizeFee("r_test", { request }), (e) => e.check === "account_not_deployed");
  assert.equal(seen.filter((r) => r.path.includes("/fee-authorization")).length, 0);
});

test("a deployed account signs the fee permit (ERC-1271, no ERC-6492 wrapper) and it is stored", async () => {
  const { f, seen } = recta();
  const signer = smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler() });
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  const out = await client.authorizeFee("r_test", { request });
  assert.equal(out.fee.kind, "AUTHORIZED");
  assert.ok(!out.fee.signature.endsWith(ERC6492_MAGIC));
  assert.equal(seen.filter((r) => r.path.includes("/fee-authorization")).length, 1);
});

test("a smart account's transfer must start from Base: anything else is refused before any request", async () => {
  const { f, seen } = recta();
  const client = createRectaClient({ signer: smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler() }), chain, limits, fetch: f, now: () => NOW });
  await assert.rejects(client.evaluate({ ...request, source_network: "arbitrum" }), (e) => e.check === "source_network");
  assert.equal(seen.length, 0);
});

test("each route transaction is one user operation: the committed call, call gas = committed gas, committed fee caps", async () => {
  const b = fakeBundler();
  const signer = smartAccountSigner({ account: await coinbaseAccount(true), ...b });
  const tx = { chainId: 8453, to: pins.USDC_BASE, data: "0x095ea7b3", value: 0n, gas: 80_000n, maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n };
  assert.equal(await signer.sendTransaction(tx), `0x${"bb".repeat(32)}`);
  const op = b.ops[0];
  assert.deepEqual(op.calls, [{ to: tx.to, data: tx.data, value: 0n }]);
  assert.equal(op.callGasLimit, 80_000n);
  assert.equal(op.maxFeePerGas, 7_000_000n);
  assert.equal(op.maxPriorityFeePerGas, 1_000_000n);
  await assert.rejects(signer.sendTransaction({ ...tx, chainId: 42161 }), /Base \(8453\) only/);
  assert.equal(b.ops.length, 1);
});

test("a failed user operation throws even though its bundle transaction succeeded", async () => {
  const signer = smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler({ success: false }) });
  await assert.rejects(signer.sendTransaction({ chainId: 8453, to: pins.USDC_BASE, data: "0x", value: 0n, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }), /failed: AA23 reverted/);
});

test("a smart account's approval is never reported (it is not the committed transaction field by field)", async () => {
  const { f, seen } = recta();
  const client = createRectaClient({ signer: smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler() }), chain, limits, fetch: f, now: () => NOW });
  await client.report("r_test", `0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`);
  const body = JSON.parse(new TextDecoder().decode(seen.find((r) => r.path.endsWith("/execution")).body));
  assert.deepEqual(body, { origin_tx_hash: `0x${"01".repeat(32)}` });
});

test("a signer that claims a smart account on another chain, or cannot say whether it is deployed, is refused", () => {
  const base = { address: ACCOUNT, signMessage: async () => "0x", signTypedData: async () => "0x", sendTransaction: async () => "0x" };
  assert.throws(() => createRectaClient({ signer: { ...base, smartAccountChainId: 1, isDeployed: async () => true }, chain, limits }), (e) => e.check === "smart_account");
  assert.throws(() => createRectaClient({ signer: { ...base, smartAccountChainId: 8453 }, chain, limits }), (e) => e.check === "smart_account");
});

test("the MCP server tells the agent its smart account transfers start from Base", async () => {
  const s = createLocalServer({ signer: smartAccountSigner({ account: await coinbaseAccount(true), ...fakeBundler() }), chain, limits, allowExecute: false, gasCapsFor: async () => [1n, 1n] });
  const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.match(r.result.instructions, /smart account on Base/);
});

const KEY = `0x${"22".repeat(32)}`;
test("configuration: RECTA_SMART_ACCOUNT=coinbase with a bundler, an optional paymaster, address and owner index", () => {
  const c = configFromEnv({ RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://bundler.example/base", RECTA_PAYMASTER_URL: "https://pm.example/base", RECTA_SMART_ACCOUNT_ADDRESS: ACCOUNT, RECTA_SMART_ACCOUNT_OWNER_INDEX: "1" });
  assert.deepEqual(c.smartAccount, { kind: "coinbase", bundlerUrl: "https://bundler.example/base", paymasterUrl: "https://pm.example/base", address: ACCOUNT, ownerIndex: 1 });
  assert.equal(configFromEnv({ RECTA_PRIVATE_KEY: KEY }).smartAccount, undefined);
});

for (const [label, env, message] of [
  ["no bundler", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase" }, /RECTA_BUNDLER_URL/],
  ["a plain-http bundler", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "http://bundler.example" }, /RECTA_BUNDLER_URL/],
  ["no owner key", { RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example" }, /RECTA_PRIVATE_KEY/],
  ["an unknown kind", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "safe", RECTA_BUNDLER_URL: "https://b.example" }, /must be coinbase/],
  ["a setting without RECTA_SMART_ACCOUNT", { RECTA_PRIVATE_KEY: KEY, RECTA_BUNDLER_URL: "https://b.example" }, /need RECTA_SMART_ACCOUNT/],
  ["a malformed address", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example", RECTA_SMART_ACCOUNT_ADDRESS: "0x12" }, /RECTA_SMART_ACCOUNT_ADDRESS/],
]) {
  test(`configuration refused: ${label}`, () => {
    assert.throws(() => configFromEnv(env), message);
  });
}
