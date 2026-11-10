// A smart account on Base (Recta BIT-ARCH-120): requests signed in the v2 text with the signer-chain header and checked by
// the account (ERC-1271, ERC-6492 before deployment); fee permits only once the account is deployed; route transactions
// sent as user operations bounded by the committed gas and fees; the approval never reported.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, custom, decodeAbiParameters, hashMessage, keccak256, recoverAddress, recoverTypedDataAddress } from "viem";
import { createBundlerClient, createPaymasterClient, getUserOperationHash, toCoinbaseSmartAccount } from "viem/account-abstraction";
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
        if (method === "eth_call") return `0x${"0".repeat(64)}`; // EntryPoint.getNonce → 0
        throw new Error(`unexpected ${method}`);
      },
    }),
  });
  return toCoinbaseSmartAccount({ client, owners: [owner], version: "1.1", address: ACCOUNT });
}

const TX_HASH = `0x${"bb".repeat(32)}`;
const OP_HASH = `0x${"aa".repeat(32)}`;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/**
 * viem's real bundler client (and, with `paymaster`, its real paymaster client) over fake transports, so the operation
 * goes through viem's own prepareUserOperation exactly as in production (Fable A-1/M-1 on recta #15).
 */
async function smartSigner({ deployed = true, success = true, gas = {}, paymaster, maxOverheadGas } = {}) {
  const account = await coinbaseAccount(deployed);
  const sent = [];
  const bundlerClient = createBundlerClient({
    account,
    client: account.client,
    chain: base,
    transport: custom({
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x2105";
        if (method === "eth_estimateUserOperationGas") return { callGasLimit: "0x1", preVerificationGas: hex(gas.pre ?? 60_000), verificationGasLimit: hex(gas.verification ?? 120_000) };
        if (method === "eth_sendUserOperation") { sent.push(params[0]); return OP_HASH; }
        if (method === "eth_getUserOperationReceipt") {
          return {
            userOpHash: OP_HASH, entryPoint: account.entryPoint.address, sender: ACCOUNT, nonce: "0x0", paymaster: ACCOUNT, actualGasCost: "0x1", actualGasUsed: "0x1",
            success, reason: success ? undefined : "AA23 reverted", logs: [],
            receipt: { transactionHash: TX_HASH, blockHash: TX_HASH, blockNumber: "0x1", transactionIndex: "0x0", status: "0x1", gasUsed: "0x1", cumulativeGasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"0".repeat(512)}`, from: ACCOUNT, to: account.entryPoint.address, contractAddress: null, type: "0x2" },
          };
        }
        throw new Error(`unexpected bundler ${method}`);
      },
    }),
    ...(paymaster === undefined ? {} : { paymaster: createPaymasterClient({ transport: custom({ async request({ method }) { if (method === "pm_getPaymasterStubData" || method === "pm_getPaymasterData") return paymaster; throw new Error(`unexpected paymaster ${method}`); } }) }) }),
  });
  return { signer: smartAccountSigner({ account, bundlerClient, ...(maxOverheadGas === undefined ? {} : { maxOverheadGas }) }), sent, account };
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
  const { signer } = await smartSigner();
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
  const { signer } = await smartSigner({ deployed: false });
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  await client.evaluate(request);
  assert.ok(seen.find((r) => r.method === "POST").headers["x-recta-signature"].endsWith(ERC6492_MAGIC));
  await assert.rejects(client.authorizeFee("r_test", { request }), (e) => e.check === "account_not_deployed");
  assert.equal(seen.filter((r) => r.path.includes("/fee-authorization")).length, 0);
});

test("a deployed account signs the fee permit (ERC-1271, no ERC-6492 wrapper) and it is stored", async () => {
  const { f, seen } = recta();
  const { signer } = await smartSigner();
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  const out = await client.authorizeFee("r_test", { request });
  assert.equal(out.fee.kind, "AUTHORIZED");
  assert.ok(!out.fee.signature.endsWith(ERC6492_MAGIC));
  assert.equal(seen.filter((r) => r.path.includes("/fee-authorization")).length, 1);
});

test("a smart account's transfer must start from Base: anything else is refused before any request", async () => {
  const { f, seen } = recta();
  const client = createRectaClient({ signer: (await smartSigner()).signer, chain, limits, fetch: f, now: () => NOW });
  await assert.rejects(client.evaluate({ ...request, source_network: "arbitrum" }), (e) => e.check === "source_network");
  assert.equal(seen.length, 0);
});

const routeTx = { chainId: 8453, to: pins.USDC_BASE, data: "0x095ea7b3", value: 0n, gas: 80_000n, maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n };

test("each route transaction is one user operation: the committed call, call gas = committed gas, committed fee caps, signed by the owner", async () => {
  const { signer, sent, account } = await smartSigner();
  assert.equal(await signer.sendTransaction(routeTx), TX_HASH);
  assert.equal(sent.length, 1);
  const op = sent[0];
  assert.equal(op.sender.toLowerCase(), ACCOUNT);
  assert.equal(op.callData, await account.encodeCalls([{ to: routeTx.to, data: routeTx.data, value: 0n }]));
  assert.equal(BigInt(op.callGasLimit), 80_000n);
  assert.equal(BigInt(op.maxFeePerGas), 7_000_000n);
  assert.equal(BigInt(op.maxPriorityFeePerGas), 1_000_000n);
  assert.equal(op.initCode, "0x");
  const hash = getUserOperationHash({ chainId: 8453, entryPointAddress: account.entryPoint.address, entryPointVersion: "0.6", userOperation: { ...op, nonce: BigInt(op.nonce), callGasLimit: BigInt(op.callGasLimit), verificationGasLimit: BigInt(op.verificationGasLimit), preVerificationGas: BigInt(op.preVerificationGas), maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas) } });
  // The account checks its owner's signature over the operation hash itself (CoinbaseSmartWallet._validateSignature).
  const [wrapper] = decodeAbiParameters([{ type: "tuple", components: [{ name: "ownerIndex", type: "uint8" }, { name: "signatureData", type: "bytes" }] }], op.signature);
  assert.equal(await recoverAddress({ hash, signature: wrapper.signatureData }), owner.address);
  await assert.rejects(signer.sendTransaction({ ...routeTx, chainId: 42161 }), /Base \(8453\) only/);
  assert.equal(sent.length, 1);
});

test("A-1: a paymaster that rewrites the call data gets nothing signed or sent", async () => {
  const { signer, sent } = await smartSigner({ paymaster: { paymasterAndData: `0x${"11".repeat(20)}`, callData: "0xb61d27f6000000000000000000000000000000000000000000000000000000000000dead", callGasLimit: "0xffffff" } });
  await assert.rejects(signer.sendTransaction(routeTx), /changed the user operation's call data: nothing was signed/);
  assert.equal(sent.length, 0);
});

for (const [label, pm, message] of [
  ["the call gas", { paymasterAndData: `0x${"11".repeat(20)}`, callGasLimit: "0xffffff" }, /call gas limit/],
  ["the fee caps", { paymasterAndData: `0x${"11".repeat(20)}`, maxFeePerGas: "0xffffffffff" }, /fee caps/],
  ["the sender", { paymasterAndData: `0x${"11".repeat(20)}`, sender: `0x${"de".repeat(20)}` }, /sender/],
  ["the init code of a deployed account", { paymasterAndData: `0x${"11".repeat(20)}`, initCode: `0x${"de".repeat(40)}` }, /init code/],
]) {
  test(`A-1: a paymaster that changes ${label} gets nothing signed or sent`, async () => {
    const { signer, sent } = await smartSigner({ paymaster: pm });
    await assert.rejects(signer.sendTransaction(routeTx), message);
    assert.equal(sent.length, 0);
  });
}

test("an honest paymaster: its data is kept and the operation is sent", async () => {
  const { signer, sent } = await smartSigner({ paymaster: { paymasterAndData: `0x${"11".repeat(20)}` } });
  assert.equal(await signer.sendTransaction(routeTx), TX_HASH);
  assert.equal(sent[0].paymasterAndData, `0x${"11".repeat(20)}`);
});

test("M-1: a bundler estimate whose verification and pre-verification gas exceed the limit is refused", async () => {
  const { signer, sent } = await smartSigner({ gas: { pre: 10n ** 15n } });
  await assert.rejects(signer.sendTransaction(routeTx), /exceeds the limit 1500000: nothing was signed/);
  assert.equal(sent.length, 0);
  const tight = await smartSigner({ maxOverheadGas: 100_000n });
  await assert.rejects(tight.signer.sendTransaction(routeTx), /exceeds the limit 100000/);
});

test("an undeployed account's operation carries its own factory call (and only that)", async () => {
  const { signer, sent, account } = await smartSigner({ deployed: false });
  await signer.sendTransaction(routeTx);
  const { factory, factoryData } = await account.getFactoryArgs();
  assert.equal(sent[0].initCode.toLowerCase(), `${factory}${factoryData.slice(2)}`.toLowerCase());
});

test("a failed user operation throws even though its bundle transaction succeeded", async () => {
  const { signer } = await smartSigner({ success: false });
  await assert.rejects(signer.sendTransaction(routeTx), /failed: AA23 reverted/);
});

test("B-4: a permit signature in ERC-6492 is never sent, whatever the signer", async () => {
  const { f, seen } = recta();
  const signer = { address: ACCOUNT, smartAccountChainId: 8453, isDeployed: async () => true, signMessage: async () => `0x${"11".repeat(65)}`, signTypedData: async () => `0x${"11".repeat(65)}${ERC6492_MAGIC}`, sendTransaction: async () => "0x" };
  const client = createRectaClient({ signer, chain, limits, fetch: f, now: () => NOW });
  await assert.rejects(client.authorizeFee("r_test", { request }), (e) => e.check === "account_not_deployed");
  assert.equal(seen.filter((r) => r.path.includes("/fee-authorization")).length, 0);
});

test("a smart account's approval is never reported (it is not the committed transaction field by field)", async () => {
  const { f, seen } = recta();
  const client = createRectaClient({ signer: (await smartSigner()).signer, chain, limits, fetch: f, now: () => NOW });
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
  const s = createLocalServer({ signer: (await smartSigner()).signer, chain, limits, allowExecute: false, gasCapsFor: async () => [1n, 1n] });
  const r = await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.match(r.result.instructions, /smart account on Base/);
});

const KEY = `0x${"22".repeat(32)}`;
test("configuration: RECTA_SMART_ACCOUNT=coinbase with a bundler, an optional paymaster, address and owner index", () => {
  const c = configFromEnv({ RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://bundler.example/base", RECTA_PAYMASTER_URL: "https://pm.example/base", RECTA_SMART_ACCOUNT_ADDRESS: ACCOUNT, RECTA_SMART_ACCOUNT_OWNER_INDEX: "1" });
  assert.deepEqual(c.smartAccount, { kind: "coinbase", bundlerUrl: "https://bundler.example/base", paymasterUrl: "https://pm.example/base", address: ACCOUNT, ownerIndex: 1, maxOverheadGas: 1_500_000n });
  assert.equal(configFromEnv({ RECTA_PRIVATE_KEY: KEY }).smartAccount, undefined);
});

for (const [label, env, message] of [
  ["no bundler", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase" }, /RECTA_BUNDLER_URL/],
  ["a plain-http bundler", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "http://bundler.example" }, /RECTA_BUNDLER_URL/],
  ["no owner key", { RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example" }, /RECTA_PRIVATE_KEY/],
  ["an unknown kind", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "safe", RECTA_BUNDLER_URL: "https://b.example" }, /must be coinbase/],
  ["a setting without RECTA_SMART_ACCOUNT", { RECTA_PRIVATE_KEY: KEY, RECTA_BUNDLER_URL: "https://b.example" }, /need RECTA_SMART_ACCOUNT/],
  ["an owner index other than 0 without the account's address", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example", RECTA_SMART_ACCOUNT_OWNER_INDEX: "1" }, /needs RECTA_SMART_ACCOUNT_ADDRESS/],
  ["a malformed overhead limit", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example", RECTA_MAX_USEROP_OVERHEAD_GAS: "0" }, /RECTA_MAX_USEROP_OVERHEAD_GAS/],
  ["a malformed address", { RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://b.example", RECTA_SMART_ACCOUNT_ADDRESS: "0x12" }, /RECTA_SMART_ACCOUNT_ADDRESS/],
]) {
  test(`configuration refused: ${label}`, () => {
    assert.throws(() => configFromEnv(env), message);
  });
}

test("M-2: a startup read that fails never prints the RPC URL (an API key may be in it)", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname], {
    input: "",
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: process.env.PATH, RECTA_PRIVATE_KEY: KEY, RECTA_SMART_ACCOUNT: "coinbase", RECTA_BUNDLER_URL: "https://127.0.0.1:1/BUNDLERKEY", RECTA_RPC_8453: "https://127.0.0.1:1/SECRETKEY" },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^recta-mcp: /);
  assert.doesNotMatch(r.stderr, /SECRETKEY|BUNDLERKEY/);
});
