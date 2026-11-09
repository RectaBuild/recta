import type { Hex } from "viem";
import { pins, RectaCheckError, type RectaChainReader, type RectaSigner } from "@recta/client";
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
    /** viem's `readContract`: reads the fee funds (USDC balance and Permit2 allowance) when the wallet is on Base. */
    readContract?(args: { address: Hex; abi: unknown; functionName: string; args: readonly unknown[] }): Promise<unknown>;
  };
}

const FEE_READ_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const AGENTKIT_TOOLS: ReadonlySet<string> = new Set(["recta_fit", "recta_trial_evaluation", "recta_evaluate", "recta_preview", "recta_report", "recta_ledger", "recta_fee_funds"]);

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
        readFeeFunds: async (owner) => {
          const client = wallet.getPublicClient();
          if (walletChainId !== pins.FEE_CHAIN_ID || client.readContract === undefined) throw new RectaCheckError("fee_funds", "Recta's fee is paid in USDC on Base: this AgentKit wallet cannot read it there");
          const read = async (functionName: "balanceOf" | "allowance", args: readonly unknown[]) => {
            const v = await client.readContract!({ address: pins.USDC_BASE as Hex, abi: FEE_READ_ABI, functionName, args });
            if (typeof v !== "bigint") throw new RectaCheckError("fee_funds", `${functionName} did not return an integer`);
            return v;
          };
          return { balanceUsdcAtomic: await read("balanceOf", [owner]), permit2AllowanceUsdcAtomic: await read("allowance", [owner, pins.PERMIT2]) };
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
