// Recta BIT-OPS-180: a decision's saving holds for 60 s after its anchor block. On Ethereum, waiting for the approval's
// receipt before sending the deposit took the deposit past it (mined 72 s after the anchor: nothing accrued). With a
// signer that can (sendInSequence: viemSigner with a local key), execute() sends the approval and the deposit back to
// back on consecutive nonces and only then waits; any other signer (MetaMask, smart account, CDP) waits as before.
// Run after the build: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeFunctionData, pad, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createRectaClient, pins, RectaCheckError, viemSigner } from "@recta/client";

const policy = readFileSync(new URL("./wallet-policy.fixture.json", import.meta.url), "utf8");
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const limits = { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 };
const SPOKE = "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64"; // Across on Base, pinned for base:USDC>arbitrum:USDC
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const AMOUNT = 10_000_000n;
const request = { source_network: "base", source_asset: "USDC", destination_network: "arbitrum", amount: "10", baseline_provider: "stargate_v2", sender: account.address, recipient: account.address };

function artifact() {
  const common = { chain_id: "8453", from: account.address, value_wei: "0", max_fee_per_gas_wei: "14000000", max_priority_fee_per_gas_wei: "1000000", transaction_type: "EIP1559", access_list: [] };
  return {
    schema: pins.EXECUTION_ARTIFACT_SCHEMA ?? "RECTA_COMMERCIAL_EXECUTION_ARTIFACT_V2",
    result_id: "r_test",
    commercial_expiry_unix: String(Math.floor(Date.now() / 1000) + 3600),
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

const fetchRecta = async (url) => new URL(String(url)).pathname.endsWith("/wallet-policy") ? new Response(policy, { status: 200 }) : new Response("{}", { status: 404 });
const HASH = (i) => `0x${String(i + 1).padStart(2, "0").repeat(32)}`;

/** A reader that logs every wait; `outcome(i)` is the i-th transaction's success, `waitThrows(i)` makes its wait throw. */
function rig({ outcome = () => true, waitThrows = () => false, sendFails = () => undefined, inSequence = true } = {}) {
  const log = [];
  let n = 0;
  const one = async (tx) => {
    const i = n++;
    const err = sendFails(i);
    if (err !== undefined) throw err;
    log.push(`send ${i} ${tx.to.toLowerCase()}`);
    return HASH(i);
  };
  const signer = {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td),
    sendTransaction: one,
    ...(inSequence ? { sendInSequence: async (txs, onSent) => { for (const [i, tx] of txs.entries()) onSent(i, await one(tx)); } } : {}),
  };
  const chain = {
    waitForSuccess: async (_chainId, hash) => {
      const i = Number.parseInt(hash.slice(2, 4), 10) - 1;
      log.push(`wait ${i}`);
      if (waitThrows(i)) throw new Error("timed out https://rpc.example/KEY");
      return outcome(i);
    },
    readFeeFunds: async () => ({ balanceUsdcAtomic: 0n, permit2AllowanceUsdcAtomic: 0n }),
  };
  return { log, client: createRectaClient({ signer, chain, limits, fetch: fetchRecta }) };
}
const APPROVE_TO = pins.USDC_BASE.toLowerCase();

test("in sequence: the approval and the deposit both leave before any receipt is awaited", async () => {
  const { log, client } = rig();
  const out = await client.execute("r_test", artifact(), request);
  assert.deepEqual(log, [`send 0 ${APPROVE_TO}`, `send 1 ${SPOKE}`, "wait 0", "wait 1"]);
  assert.deepEqual(out, { approvalTxHash: HASH(0), originTxHash: HASH(1) });
});

test("in sequence: a reverted approval with a deposit that succeeded (allowance already there) is reported, without the approval", async () => {
  const { client } = rig({ outcome: (i) => i === 1 });
  assert.deepEqual(await client.execute("r_test", artifact(), request), { originTxHash: HASH(1) });
});

test("in sequence: a reverted deposit is transaction_failed and says it moved nothing", async () => {
  for (const outcome of [() => false, (i) => i === 0]) {
    const { client } = rig({ outcome });
    await assert.rejects(client.execute("r_test", artifact(), request), (e) => e.check === "transaction_failed" && e.message.includes(`EXECUTION transaction ${HASH(1)} reverted: nothing was moved`));
  }
});

test("in sequence: the deposit's send fails after the approval left: UNKNOWN, naming the approval and the result_id", async () => {
  const { log, client } = rig({ sendFails: (i) => (i === 1 ? new Error("socket hang up") : undefined) });
  await assert.rejects(client.execute("r_test", artifact(), request), (e) => e.check === "transaction_unknown" && e.message.includes(`APPROVAL ${HASH(0)} sent for r_test`) && /before sending anything again/.test(e.message));
  assert.deepEqual(log, [`send 0 ${APPROVE_TO}`]);
});

test("in sequence: a wait that throws is UNKNOWN with every hash sent, and the RPC URL is not repeated", async () => {
  for (const at of [0, 1]) {
    const { client } = rig({ waitThrows: (i) => i === at });
    await assert.rejects(client.execute("r_test", artifact(), request), (e) => e.check === "transaction_unknown" && e.message.includes(`APPROVAL ${HASH(0)}, EXECUTION ${HASH(1)}`) && !e.message.includes("KEY"));
  }
});

test("a signer without sendInSequence (MetaMask, smart account, CDP) waits for each as before: a reverted approval stops the deposit", async () => {
  const ok = rig({ inSequence: false });
  await ok.client.execute("r_test", artifact(), request);
  assert.deepEqual(ok.log, [`send 0 ${APPROVE_TO}`, "wait 0", `send 1 ${SPOKE}`, "wait 1"]);
  const reverted = rig({ inSequence: false, outcome: () => false });
  await assert.rejects(reverted.client.execute("r_test", artifact(), request), (e) => e.check === "transaction_failed" && e.message.includes(`APPROVAL transaction ${HASH(0)} reverted`));
  assert.deepEqual(reverted.log, [`send 0 ${APPROVE_TO}`, "wait 0"]);
});

test("a deposit alone goes through sendTransaction, as before", async () => {
  const one = artifact();
  one.transactions = one.transactions.slice(1);
  const { log, client } = rig();
  assert.deepEqual(await client.execute("r_test", one, request), { originTxHash: HASH(0) });
  assert.deepEqual(log, [`send 0 ${SPOKE}`, "wait 0"]);
});

test("viemSigner (local key): sendInSequence reads the nonce once and uses consecutive ones; nothing is remembered between calls", async () => {
  let reads = 0;
  const sent = [];
  const wallet = {
    chain: undefined,
    getChainId: async () => 8453,
    request: async ({ method, params }) => {
      assert.equal(method, "eth_getTransactionCount");
      assert.deepEqual(params, [account.address, "pending"]);
      reads += 1;
      return "0x5";
    },
    sendTransaction: async (tx) => { sent.push(tx.nonce); return HASH(sent.length - 1); },
  };
  const signer = viemSigner({ account, walletClientFor: () => wallet });
  const tx = { chainId: 8453, to: SPOKE, data: "0x", value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  const seen = [];
  await signer.sendInSequence([tx, tx], (i, h) => seen.push([i, h]));
  await signer.sendInSequence([tx, tx], () => {});
  assert.deepEqual(sent, [5, 6, 5, 6]);
  assert.equal(reads, 2);
  assert.deepEqual(seen, [[0, HASH(0)], [1, HASH(1)]]);
  // sendTransaction alone leaves the nonce to viem, as before.
  await signer.sendTransaction(tx);
  assert.equal(sent.at(-1), undefined);
  await assert.rejects(signer.sendInSequence([tx, { ...tx, chainId: 1 }], () => {}), /one chain/);
});
