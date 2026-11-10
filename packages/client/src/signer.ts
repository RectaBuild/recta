import type { Account, Chain, Hex, PublicClient, Transport, TransactionSerializable, WalletClient } from "viem";
import type { BundlerClient, SmartAccount } from "viem/account-abstraction";
import { toAccount } from "viem/accounts";
import { FEE_CHAIN_ID, PERMIT2, USDC_BASE } from "./constants.js";
import { ERC20_READ_ABI, safeErrorText, type FeeFunds } from "./funds.js";

/** One EIP-1559 transaction of an execution artifact, as this package asks a signer to send it. */
export interface RectaTransaction {
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/** EIP-712 typed data of a Recta fee permit, as this package rebuilds it after its checks. */
export interface RectaTypedData {
  readonly domain: { readonly name: "Permit2"; readonly chainId: number; readonly verifyingContract: Hex };
  readonly types: Record<string, readonly { readonly name: string; readonly type: string }[]>;
  readonly primaryType: "PermitWitnessTransferFrom";
  readonly message: Record<string, unknown>;
}

/**
 * What this package needs from a wallet, and nothing more. It never receives or stores a key. An EOA signs Recta's v1
 * request text (EIP-191, recovered to the sender's address). A smart account (`smartAccountSigner`) signs the v2 text,
 * which also names the account and Base, and Recta asks the account itself on Base whether the signature holds
 * (ERC-1271, or ERC-6492 before it is deployed).
 */
export interface RectaSigner {
  readonly address: Hex;
  /**
   * Present only for a smart account: the chain on which Recta checks its signatures. Recta accepts a smart account on
   * Base only (8453), where its fee is collected, so its transfers must start from Base.
   */
  readonly smartAccountChainId?: typeof FEE_CHAIN_ID;
  /** Smart account only: whether its code is on Base. A fee or debt permit is signed only once it is (Permit2 cannot
   *  deploy an account, so Recta refuses an ERC-6492 permit). */
  isDeployed?(): Promise<boolean>;
  signMessage(message: string): Promise<Hex>;
  signTypedData(typedData: RectaTypedData): Promise<Hex>;
  /** Sends one transaction on `tx.chainId` and returns its hash. */
  sendTransaction(tx: RectaTransaction): Promise<Hex>;
}

/** Read access to the chains (the agent's own RPC): receipts, and the payer's USDC on Base before a fee is signed. */
export interface RectaChainReader {
  /** Waits until the transaction is mined and returns whether it succeeded. */
  waitForSuccess(chainId: number, hash: Hex): Promise<boolean>;
  /**
   * The payer's USDC balance on Base and its ERC-20 allowance to Permit2 (ASTRA T2): read before every fee or debt
   * permit is signed, which is refused when either is below the permit's amount. A reader that cannot answer (no Base
   * RPC) must throw: the permit is then not signed.
   */
  readFeeFunds(owner: Hex): Promise<FeeFunds>;
}

/** A RectaSigner from a viem account and one wallet client per chain. */
export function viemSigner(args: {
  readonly account: Account;
  readonly walletClientFor: (chainId: number) => WalletClient<Transport, Chain | undefined, Account | undefined>;
}): RectaSigner {
  const { account } = args;
  if (account.signMessage === undefined || account.signTypedData === undefined) {
    // A JSON-RPC account signs through the wallet client of the fee chain.
    const client = args.walletClientFor(8453);
    return {
      address: account.address,
      signMessage: (message) => client.signMessage({ account, message }),
      signTypedData: (td) => client.signTypedData({ account, ...(td as object) } as never),
      sendTransaction: (tx) => sendWith(args.walletClientFor(tx.chainId), account, tx),
    };
  }
  return {
    address: account.address,
    signMessage: (message) => account.signMessage!({ message }),
    signTypedData: (td) => account.signTypedData!(td as never),
    sendTransaction: (tx) => sendWith(args.walletClientFor(tx.chainId), account, tx),
  };
}

async function sendWith(client: WalletClient<Transport, Chain | undefined, Account | undefined>, account: Account, tx: RectaTransaction): Promise<Hex> {
  const chainId = await client.getChainId();
  if (chainId !== tx.chainId) throw new Error(`walletClientFor(${tx.chainId}) returned a client on chain ${chainId}`);
  return client.sendTransaction({
    account,
    chain: client.chain ?? null,
    to: tx.to,
    data: tx.data,
    value: tx.value,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    type: "eip1559",
  } as never);
}

/**
 * What this package uses of a Coinbase CDP EVM server account (`await cdp.evm.getOrCreateAccount({ name })` in
 * `@coinbase/cdp-sdk`): an EOA whose key stays in CDP and whose operations CDP's Policy Engine can restrict. Typed by
 * shape only, so this package does not depend on the CDP SDK.
 */
export interface CdpEvmAccountLike {
  readonly address: Hex;
  signMessage(args: { message: string }): Promise<Hex>;
  signTypedData(args: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
  signTransaction(transaction: TransactionSerializable): Promise<Hex>;
  sendTransaction(args: { network: CdpSendNetwork; transaction: { to: Hex; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: "eip1559" } }): Promise<{ transactionHash: Hex }>;
}

/**
 * EVM chains on which CDP itself sends a transaction (`sendEvmTransaction`, @coinbase/cdp-sdk 1.61.0), by chain id:
 * exactly the networks of the CDP policy Recta serves (Fable #262 B-2), so every transaction CDP sends is one that
 * policy can allow.
 */
export const CDP_SEND_NETWORKS = Object.freeze({ 1: "ethereum", 10: "optimism", 137: "polygon", 8453: "base", 42161: "arbitrum", 43114: "avalanche" } as const);
export type CdpSendNetwork = (typeof CDP_SEND_NETWORKS)[keyof typeof CDP_SEND_NETWORKS];

/** Integers as decimal strings: CDP's API carries typed data as JSON, which has no bigint. The EIP-712 hash is the same. */
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]));
  return value;
}

/**
 * A RectaSigner from a Coinbase CDP EVM server account. CDP signs the requests and the fee permit. A route transaction,
 * after this package's checks like any other, is sent by CDP (`sendEvmTransaction`, which Recta's CDP policy at
 * `/v1/golden-corridor/wallet-policy/cdp` restricts) on the chains CDP sends on; on any other chain it is signed by CDP
 * (`signEvmTransaction`) and sent through `walletClientFor`, and without one it is refused.
 */
export function cdpSigner(args: {
  readonly account: CdpEvmAccountLike;
  readonly walletClientFor?: (chainId: number) => WalletClient<Transport, Chain | undefined, Account | undefined>;
}): RectaSigner {
  const cdp = args.account;
  const account = toAccount({
    address: cdp.address,
    signMessage: async ({ message }) => {
      if (typeof message !== "string") throw new Error("cdpSigner signs text messages only");
      return cdp.signMessage({ message });
    },
    signTypedData: async (typedData) => cdp.signTypedData(jsonSafe(typedData) as never),
    signTransaction: async (transaction) => cdp.signTransaction(transaction),
  });
  return {
    address: cdp.address,
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td as never),
    sendTransaction: async (tx) => {
      const network = (CDP_SEND_NETWORKS as Readonly<Record<number, CdpSendNetwork>>)[tx.chainId];
      if (network !== undefined) {
        const { to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = tx;
        return (await cdp.sendTransaction({ network, transaction: { to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas, type: "eip1559" } })).transactionHash;
      }
      if (args.walletClientFor === undefined) throw new Error(`CDP does not send on chain ${tx.chainId}: give cdpSigner a walletClientFor`);
      return sendWith(args.walletClientFor(tx.chainId), account, tx);
    },
  };
}

/**
 * A RectaSigner from a viem smart account on Base (e.g. `toCoinbaseSmartAccount` from `viem/account-abstraction`) and
 * an ERC-4337 bundler client on Base (give the bundler client a paymaster to sponsor gas, if you have one).
 *
 * Requests and fee permits are signed by the account (viem wraps them in ERC-6492 while it is not deployed; Recta then
 * accepts requests, and this package refuses to sign a fee permit until the account is deployed). Each route
 * transaction, after this package's checks like any other, becomes one user operation: one call with the committed
 * `to`, `data` and `value`, its call gas limited to the committed gas, its fees capped by the committed fee caps. The
 * returned hash is the bundle's transaction once the operation itself succeeded; a failed operation throws.
 */
export function smartAccountSigner(args: {
  readonly account: SmartAccount;
  readonly bundlerClient: Pick<BundlerClient, "sendUserOperation" | "waitForUserOperationReceipt">;
}): RectaSigner {
  const { account, bundlerClient } = args;
  const chainId = account.client.chain?.id;
  if (chainId !== FEE_CHAIN_ID) throw new Error(`the smart account's client is on chain ${String(chainId)}: Recta accepts smart accounts on Base (${FEE_CHAIN_ID}) only`);
  return {
    address: account.address,
    smartAccountChainId: FEE_CHAIN_ID,
    isDeployed: () => account.isDeployed(),
    signMessage: (message) => account.signMessage({ message }),
    signTypedData: (td) => account.signTypedData(td as never),
    sendTransaction: async (tx) => {
      if (tx.chainId !== FEE_CHAIN_ID) throw new Error(`a smart account sends on Base (${FEE_CHAIN_ID}) only, not on chain ${tx.chainId}`);
      const hash = await bundlerClient.sendUserOperation({
        account,
        calls: [{ to: tx.to, data: tx.data, value: tx.value }],
        callGasLimit: tx.gas,
        maxFeePerGas: tx.maxFeePerGas,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      } as never);
      const receipt = await bundlerClient.waitForUserOperationReceipt({ hash });
      if (!receipt.success) throw new Error(`user operation ${hash} failed${receipt.reason === undefined ? "" : `: ${receipt.reason}`}`);
      return receipt.receipt.transactionHash;
    },
  };
}

/** A RectaChainReader from one viem public client per chain (`publicClientFor(8453)` reads the fee funds on Base). */
export function viemChainReader(publicClientFor: (chainId: number) => PublicClient): RectaChainReader {
  return {
    waitForSuccess: async (chainId, hash) => (await publicClientFor(chainId).waitForTransactionReceipt({ hash })).status === "success",
    readFeeFunds: async (owner) => {
      const base = publicClientFor(FEE_CHAIN_ID);
      const chainId = await base.getChainId().catch((e: unknown) => { throw new Error(`reading Base's chain id failed: ${safeErrorText(e)}`); });
      if (chainId !== FEE_CHAIN_ID) throw new Error(`publicClientFor(${FEE_CHAIN_ID}) returned a client on chain ${chainId}`);
      try {
        const [balanceUsdcAtomic, permit2AllowanceUsdcAtomic] = await Promise.all([
          base.readContract({ address: USDC_BASE as Hex, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] }),
          base.readContract({ address: USDC_BASE as Hex, abi: ERC20_READ_ABI, functionName: "allowance", args: [owner, PERMIT2 as Hex] }),
        ]);
        return { balanceUsdcAtomic, permit2AllowanceUsdcAtomic };
      } catch (e) {
        // viem's full message names the RPC URL, which may carry an API key: never pass it on (Fable M-2).
        throw new Error(`reading USDC on Base failed: ${safeErrorText(e)}`);
      }
    },
  };
}
