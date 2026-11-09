import type { Hex } from "viem";
import { RectaCheckError, type RectaChainReader, type RectaSigner } from "@recta/client";
import { networkChainIds } from "./index.js";
import { rectaTools, type RectaTool, type RectaToolkitOptions } from "./tools.js";

/**
 * Recta as a GOAT SDK plugin (`getOnChainTools({ wallet, plugins: [recta(…)] })`): `recta_fit`,
 * `recta_trial_evaluation`, `recta_evaluate`, `recta_preview`, `recta_report` and `recta_ledger`, signed with the
 * agent's GOAT EVM wallet. Typed by shape only, so this module does not depend on @goat-sdk/core; it needs `zod`.
 *
 * It never sends: a GOAT `sendTransaction` takes no gas limit or fee caps, and Recta's route is committed to exact ones.
 * The agent previews the route here and sends it with `@recta/client` or `npx @recta/mcp`.
 */

/** What this module uses of a GOAT `EVMWalletClient`. */
export interface GoatEvmWalletLike {
  getAddress(): string;
  getChain(): { readonly type: string; readonly id?: number | undefined };
  signMessage(message: string): Promise<{ readonly signature: string }>;
  signTypedData(data: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<{ readonly signature: string }>;
}

export interface RectaGoatOptions extends Omit<RectaToolkitOptions, "allowExecute"> {
  /** The source chain's fee estimate (e.g. a viem public client's `estimateFeesPerGas`). Without it, an evaluation
   *  commits to the ceilings themselves (`maxFeePerGasWei`, `maxPriorityFeePerGasWei`). */
  readonly estimateFeesPerGas?: (chainId: number) => Promise<{ readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }>;
  /** The wallet's USDC balance and allowance to Permit2 on Base (e.g. `viemChainReader(...).readFeeFunds`), shown by
   *  recta_fee_funds and recta_preview. Without it they say the funds were not checked. */
  readonly readFeeFunds?: RectaChainReader["readFeeFunds"];
}

const GOAT_TOOLS: ReadonlySet<string> = new Set(["recta_fit", "recta_trial_evaluation", "recta_evaluate", "recta_preview", "recta_report", "recta_ledger", "recta_fee_funds"]);
const GWEI = 1_000_000_000n;

export function recta(options: RectaGoatOptions) {
  const ids = networkChainIds();
  const chainIds = new Set(ids.values());
  return {
    name: "recta",
    toolProviders: [] as object[],
    supportsChain(chain: { readonly type: string; readonly id?: number | undefined }): boolean {
      return chain.type === "evm" && chain.id !== undefined && chainIds.has(chain.id);
    },
    getTools(wallet: GoatEvmWalletLike): Array<{ readonly name: string; readonly description: string; readonly parameters: RectaTool["schema"]; execute(args: Record<string, unknown>): Promise<string> }> {
      const walletChainId = wallet.getChain().id;
      const signer: RectaSigner = {
        address: wallet.getAddress() as Hex,
        signMessage: async (message) => (await wallet.signMessage(message)).signature as Hex,
        signTypedData: async (td) => (await wallet.signTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message: td.message })).signature as Hex,
        sendTransaction: async () => {
          throw new RectaCheckError("execution_disabled", "the GOAT plugin never sends: send the route with @recta/client or @recta/mcp");
        },
      };
      const chain: RectaChainReader = {
        waitForSuccess: async () => {
          throw new RectaCheckError("execution_disabled", "the GOAT plugin never sends");
        },
        readFeeFunds: async (owner) => {
          if (options.readFeeFunds === undefined) throw new RectaCheckError("fee_funds", "give recta({ readFeeFunds }) a Base reader to check the fee funds");
          return options.readFeeFunds(owner);
        },
      };
      const tools = rectaTools(
        {
          signer,
          chain,
          feeEstimate: async (network) => {
            const id = ids.get(network);
            if (id === undefined) throw new RectaCheckError("source_network", `${network} is not an EVM source Recta can execute`);
            if (id !== walletChainId) throw new RectaCheckError("source_network", `the GOAT wallet is on chain ${String(walletChainId)}, the route starts on chain ${id}`);
            if (options.estimateFeesPerGas !== undefined) return options.estimateFeesPerGas(id);
            const maxFeePerGas = options.maxFeePerGasWei ?? 50n * GWEI;
            return { maxFeePerGas, maxPriorityFeePerGas: options.maxPriorityFeePerGasWei ?? 2n * GWEI };
          },
        },
        { ...options, allowExecute: false },
        GOAT_TOOLS,
      );
      return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.schema, execute: (args: Record<string, unknown>) => t.invoke(args) }));
    },
  };
}
