// Recta BIT-OPS-180: a decision's saving holds for 60 s after its anchor block. On Ethereum, waiting for the approval's
// receipt before sending the deposit took the deposit past it (mined 72 s after the anchor: nothing accrued). execute()
// now sends the approval and the deposit back to back and only then waits; a local-key viemSigner gives them
// consecutive nonces even when the node's pending count lags.
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

/** A signer and reader that log every send and wait in order; `outcome(i)` is the i-th transaction's success. */
function rig({ outcome = () => true, sendFails = () => undefined } = {}) {
  const log = [];
  let n = 0;
  const signer = {
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td),
    sendTransaction: async (tx) => {
      const i = n++;
      const err = sendFails(i);
      if (err !== undefined) throw err;
      log.push(`send ${i} ${tx.to.toLowerCase()}`);
      return HASH(i);
    },
  };
  const chain = {
    waitForSuccess: async (_chainId, hash) => {
      const i = Number.parseInt(hash.slice(2, 4), 10) - 1;
      log.push(`wait ${i}`);
      return outcome(i);
    },
    readFeeFunds: async () => ({ balanceUsdcAtomic: 0n, permit2AllowanceUsdcAtomic: 0n }),
  };
  return { log, client: createRectaClient({ signer, chain, limits, fetch: fetchRecta }) };
}

test("the approval and the deposit both leave before any receipt is awaited", async () => {
  const { log, client } = rig();
  const out = await client.execute("r_test", artifact(), request);
  assert.deepEqual(log, [`send 0 ${pins.USDC_BASE.toLowerCase()}`, `send 1 ${SPOKE}`, "wait 0", "wait 1"]);
  assert.deepEqual(out, { approvalTxHash: HASH(0), originTxHash: HASH(1) });
});

test("a reverted approval names the deposit already sent and what became of it", async () => {
  const both = rig({ outcome: () => false });
  await assert.rejects(both.client.execute("r_test", artifact(), request), (e) => e.check === "transaction_failed" && e.message.includes(HASH(1)) && /reverted too: nothing was moved/.test(e.message));
  const moved = rig({ outcome: (i) => i === 1 });
  await assert.rejects(moved.client.execute("r_test", artifact(), request), (e) => e.check === "transaction_failed" && /SUCCEEDED \(report it/.test(e.message));
});

test("a reverted deposit fails as before", async () => {
  const { client } = rig({ outcome: (i) => i === 0 });
  await assert.rejects(client.execute("r_test", artifact(), request), (e) => e.check === "transaction_failed" && e.message.includes(`EXECUTION transaction ${HASH(1)} reverted`));
});

test("the deposit's send fails after the approval left: the approval's hash is named, nothing is retried", async () => {
  const { log, client } = rig({ sendFails: (i) => (i === 1 ? new Error("socket hang up") : undefined) });
  await assert.rejects(client.execute("r_test", artifact(), request), (e) => e.check === "transaction_unknown" && e.message.includes(`APPROVAL ${HASH(0)}`) && /look the account up on chain/.test(e.message));
  assert.deepEqual(log, [`send 0 ${pins.USDC_BASE.toLowerCase()}`]);
  // A wallet's own refusal keeps its own code (its journal knows what was sent).
  const own = rig({ sendFails: (i) => (i === 1 ? new RectaCheckError("wallet_send_unknown", "x") : undefined) });
  await assert.rejects(own.client.execute("r_test", artifact(), request), (e) => e.message === "wallet_send_unknown: x");
});

test("viemSigner (local key): consecutive nonces when the node's pending count lags, the node's count when it is ahead", async () => {
  let counted = 5;
  const sent = [];
  const wallet = {
    chain: undefined,
    getChainId: async () => 8453,
    request: async ({ method, params }) => {
      assert.equal(method, "eth_getTransactionCount");
      assert.deepEqual(params, [account.address, "pending"]);
      return `0x${counted.toString(16)}`;
    },
    sendTransaction: async (tx) => { sent.push(tx.nonce); return HASH(sent.length - 1); },
  };
  const signer = viemSigner({ account, walletClientFor: () => wallet });
  const tx = { chainId: 8453, to: SPOKE, data: "0x", value: 0n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
  await signer.sendTransaction(tx);
  await signer.sendTransaction(tx); // the node still says 5
  counted = 9; // other transactions since: the node is ahead
  await signer.sendTransaction(tx);
  assert.deepEqual(sent, [5, 6, 9]);
});
