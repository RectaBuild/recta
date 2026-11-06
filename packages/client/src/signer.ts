import type { Account, Chain, Hex, PublicClient, Transport, WalletClient } from "viem";

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
 * What this package needs from a wallet, and nothing more. It never receives or stores a key. The account must be an
 * EOA: Recta's signed requests are EIP-191 signatures recovered to the sender's address (smart accounts cannot).
 */
export interface RectaSigner {
  readonly address: Hex;
  signMessage(message: string): Promise<Hex>;
  signTypedData(typedData: RectaTypedData): Promise<Hex>;
  /** Sends one transaction on `tx.chainId` and returns its hash. */
  sendTransaction(tx: RectaTransaction): Promise<Hex>;
}

/** Read access to the source chain (the agent's own RPC): receipts. */
export interface RectaChainReader {
  /** Waits until the transaction is mined and returns whether it succeeded. */
  waitForSuccess(chainId: number, hash: Hex): Promise<boolean>;
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

/** A RectaChainReader from one viem public client per chain. */
export function viemChainReader(publicClientFor: (chainId: number) => PublicClient): RectaChainReader {
  return {
    waitForSuccess: async (chainId, hash) => (await publicClientFor(chainId).waitForTransactionReceipt({ hash })).status === "success",
  };
}
