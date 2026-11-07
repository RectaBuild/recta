import type { Hex } from "viem";
import { RectaCheckError, type RectaChainReader, type RectaSigner } from "@recta/client";
import { networkChainIds } from "./index.js";
import { rectaTools, type RectaTool, type RectaToolkitOptions } from "./tools.js";

/**
 * Recta as a Coinbase AgentKit action provider: the local MCP server's tools (`recta_fit`, `recta_trial_evaluation`,
 * `recta_evaluate`, `recta_preview`, `recta_report`, `recta_ledger`, and with `allowExecute` `recta_execute` and
 * `recta_pay_debt`), run with the agent's own AgentKit EVM wallet provider.
 *
 * Typed by shape only (like `cdpSigner`), so this module does not depend on @coinbase/agentkit: AgentKit calls only
 * `supportsNetwork` and `getActions` on a provider. It needs `zod`, which AgentKit already installs.
 */

/** What this module uses of an AgentKit `EvmWalletProvider` (ViemWalletProvider, CdpEvmWalletProvider, …). */
export interface AgentKitEvmWalletLike {
  getAddress(): string;
  getNetwork(): { readonly protocolFamily: string; readonly chainId?: string | undefined };
  signMessage(message: string): Promise<Hex>;
  signTypedData(typedData: unknown): Promise<Hex>;
  sendTransaction(transaction: { to: Hex; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: "eip1559" }): Promise<Hex>;
  waitForTransactionReceipt(hash: Hex): Promise<unknown>;
  getPublicClient(): {
    estimateFeesPerGas(): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
    getCode(args: { address: Hex }): Promise<Hex | undefined>;
  };
}

/** EIP-7702: an EOA that delegates its code still signs and sends as the EOA. */
const DELEGATION_PREFIX = "0xef0100";

/** A RectaSigner from an AgentKit EVM wallet provider: it sends only on the wallet's own chain and only from an EOA. */
export function agentKitSigner(wallet: AgentKitEvmWalletLike): RectaSigner {
  const address = wallet.getAddress() as Hex;
  const walletChainId = Number(wallet.getNetwork().chainId);
  return {
    address,
    signMessage: (message) => wallet.signMessage(message),
    signTypedData: (typedData) => wallet.signTypedData(typedData),
    sendTransaction: async (tx) => {
      if (tx.chainId !== walletChainId) throw new RectaCheckError("source_network", `the AgentKit wallet is on chain ${walletChainId}, the route starts on chain ${tx.chainId}`);
      // A smart-account provider sends user operations: its hash is not the route transaction Recta verifies.
      const code = (await wallet.getPublicClient().getCode({ address })) ?? "0x";
      if (code !== "0x" && !code.toLowerCase().startsWith(DELEGATION_PREFIX)) throw new RectaCheckError("smart_account", "Recta's route is sent from an EOA wallet provider only");
      const { to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = tx;
      return wallet.sendTransaction({ to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas, type: "eip1559" });
    },
  };
}

export function rectaActionProvider(options: RectaToolkitOptions) {
  const ids = networkChainIds();
  const chainIds = new Set(ids.values());
  return {
    name: "recta",
    actionProviders: [] as never[],
    /** EVM wallets on a chain a Recta route can start from. */
    supportsNetwork(network: { readonly protocolFamily: string; readonly chainId?: string | undefined }): boolean {
      return network.protocolFamily === "evm" && network.chainId !== undefined && chainIds.has(Number(network.chainId));
    },
    getActions(wallet: AgentKitEvmWalletLike): RectaTool[] {
      const walletChainId = Number(wallet.getNetwork().chainId);
      const onWalletChain = (chainId: number): void => {
        // An AgentKit wallet provider is bound to one chain: a route that starts elsewhere is refused, never re-routed.
        if (chainId !== walletChainId) throw new RectaCheckError("source_network", `the AgentKit wallet is on chain ${walletChainId}, the route starts on chain ${chainId}`);
      };
      const signer = agentKitSigner(wallet);
      const chain: RectaChainReader = {
        waitForSuccess: async (chainId, hash) => {
          onWalletChain(chainId);
          const receipt = (await wallet.waitForTransactionReceipt(hash)) as { readonly status?: unknown } | undefined;
          return receipt?.status === "success";
        },
      };
      return rectaTools(
        {
          signer,
          chain,
          feeEstimate: async (network) => {
            const id = ids.get(network);
            if (id === undefined) throw new RectaCheckError("source_network", `${network} is not an EVM source Recta can execute`);
            onWalletChain(id);
            return wallet.getPublicClient().estimateFeesPerGas();
          },
        },
        options,
      );
    },
  };
}
