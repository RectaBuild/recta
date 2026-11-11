import { recoverMessageAddress, recoverTypedDataAddress, type Hex, type PublicClient } from "viem";
import { pins, RectaCheckError, safeErrorText, viemChainReader, type RectaChainReader, type RectaSigner, type RectaTransaction, type RectaTypedData } from "@recta/client";
import { cappedGas, keylessSigner, networkChainIds } from "./index.js";
import { createLocalServer, type LocalServerOptions } from "./server.js";

/**
 * Recta inside the MetaMask Agent Wallet CLI (`mm`, @metamask/agent-wallet 7.x): the agent's MetaMask wallet signs
 * Recta's requests and permits and sends Recta's committed transactions through MetaMask's own executor, so every
 * signature still passes MetaMask's policy and, when the user set it up, its two-factor approval.
 *
 * Typed by shape only (like `agentKitSigner`), so this module does not depend on MetaMask's packages: it was written
 * against the declarations of @metamask/agent-wallet 7.3.0 (`PluginCommandContext.walletExecutor` and
 * `publicClient`) and @metamask/agent-sdk 7.3.0 (`EvmWalletRequest`, `EvmWalletResult`).
 */

/** What this module sends to MetaMask's `EvmWalletExecutor` (agent-sdk's `EVM_WALLET_REQUEST_KIND`). */
export type MetaMaskWalletRequest =
  | {
      readonly kind: "transaction";
      readonly chainId: number;
      // MetaMask's EVMTransaction keeps an explicit gas limit and EIP-1559 caps (fox-sdk EVMTransactionFees).
      readonly transaction: { readonly to: Hex; readonly data: Hex; readonly value: bigint; readonly gas: bigint; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint };
    }
  | { readonly kind: "message"; readonly chainId: number; readonly message: string }
  | { readonly kind: "typed-data"; readonly chainId: number; readonly typedData: RectaTypedData };

/** MetaMask's `EvmWalletResult` (agent-sdk's `EVM_WALLET_RESULT_KIND`), as far as this module reads it. */
export type MetaMaskWalletResult =
  | { readonly kind: "transaction"; readonly hash?: string; readonly status?: string; readonly failureCode?: string; readonly failureDescription?: string }
  | { readonly kind: "signature"; readonly signature?: string; readonly status?: string; readonly failureCode?: string; readonly failureDescription?: string };

export type MetaMaskWalletExecutor = (request: MetaMaskWalletRequest, opts?: { readonly waitForReceipt?: boolean }) => Promise<MetaMaskWalletResult>;

/** The read access this module needs: `PluginCommandContext.publicClient(chainId)`, a viem public client per chain. */
export type MetaMaskPublicClientFor = (chainId: number) => PublicClient;

/** Terminal job states in which MetaMask did not sign or did not broadcast (fox-sdk TX_JOB_STATUS / SIGN_JOB_STATUS). */
const FAILED_STATES: ReadonlySet<string> = new Set(["DENIED", "EXPIRED", "FAILED", "BROADCAST_FAILED", "BROADCAST_TRACKING_EXPIRED", "CONFIRMATION_TRACKING_EXPIRED"]);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
/** ERC-20 approve(address,uint256). */
const APPROVE_SELECTOR = "0x095ea7b3";
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The only answers that prove MetaMask never signed, so nothing can have been broadcast (Fable U-1 on #19): the request
 * was denied, or expired before it was approved. Any other answer without a hash (FAILED, BROADCAST_FAILED, a tracking
 * timeout, a throw) is UNKNOWN.
 */
const NOT_SIGNED_STATES: ReadonlySet<string> = new Set(["DENIED", "EXPIRED"]);

function refused(result: MetaMaskWalletResult, what: string): never {
  const state = result.failureCode ?? result.status ?? "no result";
  const detail = result.failureDescription === undefined ? "" : `: ${result.failureDescription.slice(0, 200)}`;
  throw new RectaCheckError("wallet_refused", `MetaMask did not ${what} (${state}${detail})`);
}

/**
 * A RectaSigner from MetaMask's wallet executor. Every signature must recover to `address` (MetaMask's agent wallets
 * are EOAs): a wallet that signs some other way is refused before Recta sees the signature. Every transaction is sent
 * with the gas limit and fee caps Recta committed to, and is read back once mined: if MetaMask changed any committed
 * field, the next step (the transfer after an approval, or the report) is refused.
 */
export interface MetaMaskSentTransaction {
  /** One per transaction this signer tried to send: later reports for the same attempt replace earlier ones. */
  readonly attempt: number;
  /**
   * UNKNOWN: reported BEFORE MetaMask is asked to send, and kept while nothing proves the outcome (the call threw, or
   * MetaMask answered without a hash, or stopped tracking it): it must be found on chain before anything is sent.
   * SENT: MetaMask returned its hash. NOT_SENT: MetaMask answered DENIED or EXPIRED, so it never signed.
   */
  readonly state: "UNKNOWN" | "SENT" | "NOT_SENT";
  readonly hash?: Hex;
  /** SENT only: what the chain says once the receipt was read (PENDING while it was not). */
  readonly chainStatus?: "PENDING" | "CONFIRMED" | "REVERTED";
  readonly chainId: number;
  readonly from: Hex;
  readonly to: Hex;
  readonly data: Hex;
  readonly value: bigint;
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** The wallet's pending nonce, read just before the send: the transaction, if it exists, uses it. */
  readonly nonce: number;
  /** An ERC-20 `approve` (Recta's approval transaction, or the fee approval), not the transfer itself. */
  readonly approval: boolean;
}

export function metaMaskSigner(args: {
  readonly address: Hex;
  readonly execute: MetaMaskWalletExecutor;
  readonly publicClientFor: MetaMaskPublicClientFor;
  /**
   * Called before every send (UNKNOWN), then with its outcome (SENT with the hash, NOT_SENT, or UNKNOWN again with a
   * hash). The first call must persist the attempt: if it throws, nothing is sent.
   */
  readonly onSent?: (sent: MetaMaskSentTransaction) => void;
}): RectaSigner {
  const { address, execute, publicClientFor } = args;
  let attempts = 0;
  if (!ADDRESS.test(address)) throw new RectaCheckError("input", "the MetaMask wallet address must be 0x + 40 hex characters");
  const same = (a: string) => a.toLowerCase() === address.toLowerCase();
  const signatureOf = (result: MetaMaskWalletResult, what: string): Hex => {
    if (result.kind !== "signature" || result.failureCode !== undefined || (result.status !== undefined && FAILED_STATES.has(result.status))) refused(result, what);
    if (typeof result.signature !== "string" || !SIGNATURE.test(result.signature)) throw new RectaCheckError("wallet_signature", `MetaMask returned no 65-byte signature when asked to ${what}`);
    return result.signature as Hex;
  };
  return {
    address,
    signMessage: async (message) => {
      const signature = signatureOf(await execute({ kind: "message", chainId: pins.FEE_CHAIN_ID, message }), "sign Recta's request");
      if (!same(await recoverMessageAddress({ message, signature }))) throw new RectaCheckError("wallet_signature", `the MetaMask signature does not recover to ${address}: is this the selected wallet?`);
      return signature;
    },
    signTypedData: async (typedData) => {
      const signature = signatureOf(await execute({ kind: "typed-data", chainId: typedData.domain.chainId, typedData }), "sign Recta's permit");
      if (!same(await recoverTypedDataAddress({ ...(typedData as never as Parameters<typeof recoverTypedDataAddress>[0]), signature }))) throw new RectaCheckError("wallet_signature", `the MetaMask permit signature does not recover to ${address}`);
      return signature;
    },
    sendTransaction: async (tx: RectaTransaction) => {
      const { chainId, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } = tx;
      const approval = data.slice(0, 10).toLowerCase() === APPROVE_SELECTOR;
      // Fable U-1 on #19: the nonce identifies the transaction even if no hash ever comes back.
      const client = publicClientFor(chainId);
      let nonce: number;
      try {
        nonce = await client.getTransactionCount({ address, blockTag: "pending" });
      } catch (e) {
        throw new RectaCheckError("wallet_nonce", `could not read the nonce of ${address} on chain ${chainId} before sending (${safeErrorText(e).slice(0, 200)}): nothing was sent`);
      }
      const attempt = { attempt: ++attempts, chainId, from: address, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, approval };
      // Owner 2026-11-11 21:16/21:22: recorded (on disk, by the caller) before MetaMask is asked; from here on a send
      // may have happened, so it is UNKNOWN until evidence says otherwise.
      args.onSent?.({ ...attempt, state: "UNKNOWN" });
      let result: MetaMaskWalletResult;
      try {
        result = await execute({ kind: "transaction", chainId, transaction: { to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas } }, { waitForReceipt: true });
      } catch (e) {
        throw new RectaCheckError("wallet_send_unknown", `MetaMask's send failed without an answer (${safeErrorText(e).slice(0, 200)}): it may have been broadcast, now or later`);
      }
      const failed = result.kind !== "transaction" || result.failureCode !== undefined || (result.status !== undefined && FAILED_STATES.has(result.status));
      const withHash = result.kind === "transaction" && typeof result.hash === "string" && HEX32.test(result.hash);
      if (!withHash) {
        if (result.kind === "transaction" && result.status !== undefined && NOT_SIGNED_STATES.has(result.status)) {
          args.onSent?.({ ...attempt, state: "NOT_SENT" });
          refused(result, "send Recta's transaction");
        }
        throw new RectaCheckError("wallet_send_unknown", `MetaMask answered ${result.failureCode ?? result.status ?? "without a status"} and no transaction hash: it may have been broadcast, now or later`);
      }
      const hash = (result as { hash: string }).hash as Hex;
      // Fable R-1 on #19: a failure that carries a hash (MetaMask stopped tracking it, or reports a failure after
      // broadcasting) may still be mined. Never say it was not sent.
      if (failed) {
        args.onSent?.({ ...attempt, state: "UNKNOWN", hash });
        const state = result.failureCode ?? result.status ?? "unknown";
        throw new RectaCheckError("wallet_unconfirmed", `MetaMask reports ${state} for ${hash}: it may have been sent, so look it up on chain before sending anything`);
      }
      // Read back what was mined: Recta verifies the committed transaction field by field, so a changed one is worth
      // nothing and must stop the route here.
      args.onSent?.({ ...attempt, state: "SENT", hash, chainStatus: "PENDING" });
      let sent: Awaited<ReturnType<PublicClient["getTransaction"]>>;
      try {
        const receipt = await client.waitForTransactionReceipt({ hash });
        sent = await client.getTransaction({ hash });
        // Fable P-3: a hash whose mined sender is not this wallet is not this wallet's transaction (a smart account's
        // bundle, or something else): its outcome is UNKNOWN.
        if (sent.from.toLowerCase() !== address.toLowerCase()) {
          args.onSent?.({ ...attempt, state: "UNKNOWN", hash });
          throw new RectaCheckError("wallet_foreign_sender", `MetaMask's hash ${hash} was mined from ${sent.from}, not from ${address}: whether this wallet's transaction was sent is not known`);
        }
        args.onSent?.({ ...attempt, state: "SENT", hash, chainStatus: receipt.status === "success" ? "CONFIRMED" : "REVERTED" });
      } catch (e) {
        if (e instanceof RectaCheckError) throw e;
        throw new RectaCheckError("wallet_readback", `MetaMask sent ${hash}, but reading it back failed (${safeErrorText(e).slice(0, 200)}): it may still be mined, so do not send it again`);
      }
      const changed = [
        sent.from.toLowerCase() !== address.toLowerCase() && "from",
        (sent.to ?? "").toLowerCase() !== to.toLowerCase() && "to",
        sent.input.toLowerCase() !== data.toLowerCase() && "data",
        sent.value !== value && "value",
        sent.gas !== gas && "gas",
        sent.maxFeePerGas !== maxFeePerGas && "maxFeePerGas",
        sent.maxPriorityFeePerGas !== maxPriorityFeePerGas && "maxPriorityFeePerGas",
        sent.chainId !== undefined && sent.chainId !== chainId && "chainId",
      ].filter((x): x is string => x !== false);
      if (changed.length > 0) throw new RectaCheckError("wallet_changed_transaction", `MetaMask sent ${hash} with a different ${changed.join(", ")} than Recta committed: it was mined as sent, so do not send it again; nothing more is sent from here`);
      return hash;
    },
  };
}

/** A RectaChainReader on MetaMask's own per-chain public clients (receipts, and the fee funds on Base). */
export function metaMaskChainReader(publicClientFor: MetaMaskPublicClientFor): RectaChainReader {
  return viemChainReader(publicClientFor);
}

/** The `mm` wallet-state fields this module reads (agent-sdk `WalletStateSnapshot`). */
export interface MetaMaskWalletStateLike {
  readonly byokWallets?: readonly { readonly id?: string; readonly name?: string | null; readonly address?: string; readonly namespace?: string }[];
  readonly remoteWallets?: readonly { readonly name?: string | null; readonly address?: string; readonly namespace?: string }[];
  readonly selectedWallet?: { readonly mode?: string; readonly namespace?: string; readonly ref?: { readonly id?: string; readonly address?: string; readonly name?: string } };
  /** MetaMask's own record of its wallet requests (what `mm wallet requests list` shows). */
  readonly pendingJobs?: readonly { readonly pollingId?: string; readonly kind?: string; readonly status?: string; readonly txHash?: string; readonly chainId?: number; readonly submittedAt?: string }[];
}

/** The EVM address of the wallet selected in `mm` (`mm wallet use`), or a clear error naming `--address`. */
export function selectedMetaMaskAddress(state: MetaMaskWalletStateLike): Hex {
  const ref = state.selectedWallet?.ref;
  const namespace = state.selectedWallet?.namespace;
  const mode = state.selectedWallet?.mode;
  const pool = mode === "byok" ? (state.byokWallets ?? []) : mode === "server" ? (state.remoteWallets ?? []) : [...(state.byokWallets ?? []), ...(state.remoteWallets ?? [])];
  const wallets = pool.filter((w) => typeof w.address === "string" && ADDRESS.test(w.address));
  const evm = wallets.filter((w) => namespace === undefined || w.namespace === undefined || w.namespace === namespace);
  let found: typeof evm = [];
  if (ref?.address !== undefined) found = evm.filter((w) => w.address!.toLowerCase() === ref.address!.toLowerCase());
  else if (ref?.id !== undefined) found = evm.filter((w) => "id" in w && w.id === ref.id);
  else if (ref?.name !== undefined) found = evm.filter((w) => w.name === ref.name);
  else if (evm.length === 1) found = evm;
  const addresses = new Set(found.map((w) => w.address!.toLowerCase()));
  if (addresses.size !== 1) throw new RectaCheckError("wallet_address", "could not tell which MetaMask wallet is selected: pass --address with the EVM address of the wallet mm signs with");
  return found[0]!.address as Hex;
}

/** Marks the server's `recta-mcp/<version>` User-Agent as coming from `mm`, so Recta's panel can tell them apart. */
function withMmUserAgent(f: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const ua = headers.get("user-agent");
    if (ua !== null && !ua.endsWith(" (mm)")) headers.set("user-agent", `${ua} (mm)`);
    const plain: Record<string, string> = {};
    headers.forEach((value, key) => { plain[key] = value; });
    return f(input, { ...init, headers: plain });
  };
}

/** Limits as the commands take them; every default matches `@recta/mcp`'s. */
export interface MetaMaskRectaLimits {
  readonly maxPermitUsdcAtomic: bigint;
  readonly maxNativeValueWei: bigint;
  readonly minOutputBps: number;
  readonly maxFeePerGasWei: bigint;
  readonly maxPriorityFeePerGasWei: bigint;
}

/**
 * The local MCP server's tool calls on a MetaMask wallet: the same checks, requests and answers as `npx @recta/mcp`.
 * `keyless` answers only `recta_fit` and `recta_trial_evaluation` (the address, if any, is the trial's sender). Without
 * `execute` the wallet signs nothing: a tool that would sign is refused.
 */
export function metaMaskRectaServer(args: {
  readonly keyless: boolean;
  readonly address?: Hex;
  readonly execute?: MetaMaskWalletExecutor;
  readonly publicClientFor: MetaMaskPublicClientFor;
  readonly limits: MetaMaskRectaLimits;
  readonly allowExecute: boolean;
  readonly referrer?: string;
  readonly onSent?: (sent: MetaMaskSentTransaction) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}) {
  const ids = networkChainIds();
  const keyless = args.keyless || args.address === undefined;
  const refuse: MetaMaskWalletExecutor = async () => {
    throw new RectaCheckError("signs_nothing", "this command signs nothing");
  };
  const options: LocalServerOptions = {
    signer: keyless ? keylessSigner(args.address) : metaMaskSigner({ address: args.address!, execute: args.execute ?? refuse, publicClientFor: args.publicClientFor, ...(args.onSent === undefined ? {} : { onSent: args.onSent }) }),
    keyless,
    chain: metaMaskChainReader(args.publicClientFor),
    limits: { maxPermitUsdcAtomic: args.limits.maxPermitUsdcAtomic, maxNativeValueWei: args.limits.maxNativeValueWei, minOutputBps: args.limits.minOutputBps },
    allowExecute: !keyless && args.execute !== undefined && args.allowExecute,
    gasCapsFor: async (network) => {
      const id = ids.get(network);
      if (id === undefined) throw new RectaCheckError("source_network", `${network} is not an EVM source Recta can execute`);
      return cappedGas(await args.publicClientFor(id).estimateFeesPerGas(), args.limits);
    },
    ...(args.referrer === undefined ? {} : { referrer: args.referrer }),
    fetch: withMmUserAgent(args.fetch ?? fetch),
    ...(args.now === undefined ? {} : { now: args.now }),
  };
  const server = createLocalServer(options);
  let next = 0;
  /** One tool call: its JSON answer, or `{ error }` with `isError` exactly as the MCP server would answer it. */
  return async (name: string, input: Record<string, unknown>): Promise<{ readonly isError: boolean; readonly body: Record<string, unknown> }> => {
    const reply = (await server.handle({ jsonrpc: "2.0", id: ++next, method: "tools/call", params: { name, arguments: input } })) as
      | { readonly result?: { readonly content?: readonly { readonly text?: string }[]; readonly isError?: boolean }; readonly error?: { readonly message?: string } }
      | undefined;
    const text = reply?.result?.content?.[0]?.text;
    if (text === undefined) return { isError: true, body: { error: "FAILED", message: reply?.error?.message ?? "no answer" } };
    return { isError: reply?.result?.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  };
}
