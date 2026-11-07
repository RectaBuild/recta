import type { Hex } from "viem";
import { RectaCheckError, type RectaChainReader, type RectaSigner } from "@recta/client";
import { networkChainIds } from "./index.js";
import { rectaTools, type RectaTool, type RectaToolkitOptions } from "./tools.js";

/**
 * Recta as a Coinbase AgentKit action provider: `recta_fit`, `recta_trial_evaluation`, `recta_evaluate`,
 * `recta_preview`, `recta_report` and `recta_ledger`, signed with the agent's own AgentKit EVM wallet provider.
 *
 * It never sends (Fable A-1 on recta #9): AgentKit's wallet providers drop the gas limit and fee caps of a transaction
 * (ViemWalletProvider re-estimates them, CdpEvmWalletProvider forwards only to/value/data), and Recta's route is
 * committed to exact ones. The agent previews the route here and sends it with `@recta/client` or `npx @recta/mcp`.
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
  getPublicClient(): {
    estimateFeesPerGas(): Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
  };
}

const AGENTKIT_TOOLS: ReadonlySet<string> = new Set(["recta_fit", "recta_trial_evaluation", "recta_evaluate", "recta_preview", "recta_report", "recta_ledger"]);

/** A RectaSigner from an AgentKit EVM wallet provider: it signs requests and permits, and never sends. */
export function agentKitSigner(wallet: AgentKitEvmWalletLike): RectaSigner {
  return {
    address: wallet.getAddress() as Hex,
    signMessage: (message) => wallet.signMessage(message),
    signTypedData: (typedData) => wallet.signTypedData(typedData),
    sendTransaction: async () => {
      throw new RectaCheckError("execution_disabled", "AgentKit wallet providers re-estimate gas and fees: send Recta's route with @recta/client or @recta/mcp");
    },
  };
}

export function rectaActionProvider(options: Omit<RectaToolkitOptions, "allowExecute">) {
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
      const chain: RectaChainReader = {
        waitForSuccess: async () => {
          throw new RectaCheckError("execution_disabled", "the AgentKit provider never sends");
        },
      };
      return rectaTools(
        {
          signer: agentKitSigner(wallet),
          chain,
          feeEstimate: async (network) => {
            const id = ids.get(network);
            if (id === undefined) throw new RectaCheckError("source_network", `${network} is not an EVM source Recta can execute`);
            // An AgentKit wallet provider is bound to one chain: a route that starts elsewhere is refused.
            if (id !== walletChainId) throw new RectaCheckError("source_network", `the AgentKit wallet is on chain ${walletChainId}, the route starts on chain ${id}`);
            return wallet.getPublicClient().estimateFeesPerGas();
          },
        },
        { ...options, allowExecute: false },
        AGENTKIT_TOOLS,
      );
    },
  };
}
