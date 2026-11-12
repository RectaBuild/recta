# @recta/mcp

A local [MCP](https://modelcontextprotocol.io) server for [Recta](https://api.recta.build/llms.txt). It lets an MCP
agent (Claude, Cursor, or any other client) do this before it moves stablecoins between blockchains, with no code
written: ask Recta for a cheaper route than the one it would use anyway, check that route, and send it from its own
wallet. Recta charges exactly 5 % of the saving it verifies on chain after execution. No saving, no charge.

The key stays on your machine. The server is a thin layer over [`@recta/client`](../client): every local check of the
client runs before anything is signed or sent, and those checks cannot be turned off.

## Run

```
npx -y @recta/mcp
```

Example for an MCP client configuration file (Claude Desktop, Cursor and others use this shape):

```json
{
  "mcpServers": {
    "recta": {
      "command": "npx",
      "args": ["-y", "@recta/mcp"],
      "env": {
        "RECTA_PRIVATE_KEY": "0x…",
        "RECTA_RPC_8453": "https://…",
        "RECTA_RPC_42161": "https://…"
      }
    }
  }
}
```

**Try it first without a key.** Leave `RECTA_PRIVATE_KEY` out and the server offers only the two tools that sign
nothing: `recta_fit` (is the corridor covered?) and `recta_trial_evaluation` (is there a provable saving for this
transfer, and how much?). Give the trial a `sender`, or set `RECTA_ADDRESS` to the public address the transfer would
leave from. The server says so on stderr when it starts without a key; an empty `RECTA_PRIVATE_KEY` counts as no key.
Add the key when you want the route itself.

Use a **dedicated wallet** that holds only what the agent may move, never your main one. The key sits in plain text in
that configuration file (and in the environment of the server process), so anyone who can read the file can move the
wallet's funds.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECTA_PRIVATE_KEY` | none: free tools only | The agent wallet's private key (EOA), or the owner key of its smart account (see `RECTA_SMART_ACCOUNT`). It is only used locally, to sign. Without it only `recta_fit` and `recta_trial_evaluation` are offered. |
| `RECTA_ADDRESS` | none | A public address the keyless trial uses as `sender` (never a key). With a key it is not used (the key's address is the sender), but a malformed value still stops the server. |
| `RECTA_RPC_<chainId>` | the chain's public RPC | An `https` RPC URL for that chain, e.g. `RECTA_RPC_8453` for Base. `http` is accepted only for `localhost`; any other value stops the server. |
| `RECTA_ALLOW_EXECUTE` | off | Set to `yes` to let the agent sign fee permits and send transactions. Anything else keeps the server read and preview only. |
| `RECTA_MAX_FEE_USDC` | `1` | The most one fee permit may authorize, in USDC. A larger permit is refused. |
| `RECTA_MAX_NATIVE_WEI` | `0` | The most native value one route transaction may carry (messaging fees). `0` refuses routes that need one. |
| `RECTA_MAX_FEE_GWEI` | `50` | The highest source-chain `maxFeePerGas` an evaluation may commit to, whatever the RPC estimates. |
| `RECTA_MAX_PRIORITY_FEE_GWEI` | `2` | The highest priority fee an evaluation may commit to. |
| `RECTA_MIN_OUTPUT_BPS` | `9900` | The route must guarantee the recipient at least this share of the amount sent, in basis points (1–10000). |
| `RECTA_SMART_ACCOUNT` | none: an EOA | Set to `coinbase` when the agent's wallet is a Coinbase Smart Wallet on Base owned by `RECTA_PRIVATE_KEY`. See "Smart accounts". Any other value stops the server. |
| `RECTA_BUNDLER_URL` | none | With `RECTA_SMART_ACCOUNT`, required: an `https` ERC-4337 bundler URL on Base. Route transactions are sent through it as user operations. |
| `RECTA_PAYMASTER_URL` | none | With `RECTA_SMART_ACCOUNT`, optional: an `https` paymaster URL on Base that sponsors the gas. Without it the account pays its gas in ETH on Base. |
| `RECTA_SMART_ACCOUNT_ADDRESS` | the key's own account | With `RECTA_SMART_ACCOUNT`, an existing account the key is an owner of (for example one created by an app or by CDP). Without it, the account the key alone owns (Coinbase Smart Wallet v1.1, nonce 0). |
| `RECTA_SMART_ACCOUNT_OWNER_INDEX` | `0` | With `RECTA_SMART_ACCOUNT`, the key's position among the account's owners. Any value other than `0` needs `RECTA_SMART_ACCOUNT_ADDRESS`. |
| `RECTA_MAX_USEROP_OVERHEAD_GAS` | `1500000` | With `RECTA_SMART_ACCOUNT`, the most gas one user operation may spend besides its call (verification, pre-verification and any paymaster gas). An operation the bundler estimates above it is not signed. |
| `RECTA_REFERRER` | none | The EVM address of whoever set this agent up (a template or framework author). See "Referral for integrators". A malformed address stops the server. |

## Amount

`amount` is how much of `source_asset` to send, in whole tokens (not cents, not wei): `"100"` with USDC means 100 USDC.
The minimum is 3.5 for stablecoins (about 3.5 USD). There is no maximum.

## Tools

| Tool | Signs or sends | What it does |
| --- | --- | --- |
| `recta_fit` | nothing | Does Recta cover this corridor, and which contracts would a route touch? |
| `recta_evaluate` | a request signature | Asks Recta whether a cheaper route than `baseline_provider` can be proven. Free. |
| `recta_trial_evaluation` | nothing | The same question unsigned: only whether a saving exists, its amount and Recta's 5 %. No route, nothing stored, 3 a day per IP address. Without a key, pass `sender` (or set `RECTA_ADDRESS`). |
| `recta_preview` | a request signature | Shows the fee ceiling Recta asks you to authorize, after the local permit check, and whether the wallet can pay it. With collection on, the transactions appear only after the permit is signed. |
| `recta_fee_funds` | nothing | The wallet's USDC balance on Base and its USDC allowance to Permit2, against `amount_usdc` (default `RECTA_MAX_FEE_USDC`). |
| `recta_approve_fee` | one approval | Sends `USDC.approve(Permit2, amount)` on Base, at most `RECTA_MAX_FEE_USDC`, never unlimited. Only with `RECTA_ALLOW_EXECUTE=yes`. |
| `recta_execute` | fee permit, transactions | Signs the checked permit, sends the checked transactions, reports them. Only with `RECTA_ALLOW_EXECUTE=yes`. |
| `recta_report` | a request signature | Reports an executed route again (after `PENDING`). |
| `recta_pay_debt` | a debt permit | Pays an earlier fee Recta could not collect. Only with `RECTA_ALLOW_EXECUTE=yes`. |
| `recta_ledger` | a request signature | The wallet's Recta fees and whether each was collected. |

`recta_execute`, `recta_pay_debt` and `recta_approve_fee` are not even listed to the agent unless execution is enabled.

Recta's fee is paid in USDC on Base through Permit2, so the wallet needs USDC on Base and a USDC allowance to Permit2.
`recta_execute` and `recta_pay_debt` read both first (through `RECTA_RPC_8453`, or Base's public RPC) and refuse before
signing anything when either is below the permit: a route never executes with a fee Recta cannot collect. A new wallet
sets the allowance with `recta_approve_fee`; each collected fee lowers it, so approve again when
`recta_fee_funds` reports it short. A route that starts from USDC on Base needs the transfer plus the fee in the
balance: the transfer leaves first, and `recta_execute` checks again right before sending.

The saving is measured against `baseline_provider`: the route your agent would use without Recta. Declare the one it
really uses. If your agent bridges through LI.FI (its public API or an aggregator built on it), declare `lifi`
wherever the fit check (`GET /v1/golden-corridor/fit`) lists it in `declarable_baselines`; it is refused with
`latency_class` SECONDS or MINUTES. Recta reads LI.FI's own transaction, its fee included. If that route is already the cheapest, Recta answers with no saving and charges nothing; keep your route.

## Coinbase AgentKit

The evaluation tools as AgentKit actions (`recta_fit`, `recta_trial_evaluation`, `recta_evaluate`, `recta_preview`,
`recta_report`, `recta_ledger`, `recta_fee_funds`), signed by the agent's own AgentKit EVM wallet provider:

```ts
import { AgentKit } from "@coinbase/agentkit";
import { rectaActionProvider } from "@recta/mcp/agentkit";

const agentkit = await AgentKit.from({
  walletProvider, // e.g. a ViemWalletProvider or CdpEvmWalletProvider on Base
  actionProviders: [rectaActionProvider({ limits: { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 }, referrer: "0x…" /* optional: your address as the integrator */ })],
});
```

The provider never sends a transaction: AgentKit's wallet providers replace a transaction's gas limit and fee caps
with their own, and Recta's route is committed to exact ones. Preview the route there and send it with
`@recta/client` or this server. An AgentKit wallet provider lives on one chain, so an evaluation for a route that
starts on another chain is refused. `recta_fee_funds` reads the fee funds only when the wallet provider is on Base. It
needs `zod`, which AgentKit already installs.

## GOAT

The evaluation tools as a GOAT plugin, signed with the agent's GOAT EVM wallet:

```ts
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai"; // or any GOAT adapter
import { recta } from "@recta/mcp/goat";

const tools = await getOnChainTools({
  wallet: viem(walletClient),
  plugins: [recta({ limits: { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 }, referrer: "0x…" /* optional */, estimateFeesPerGas: () => publicClient.estimateFeesPerGas(), readFeeFunds: viemChainReader(() => basePublicClient).readFeeFunds /* optional: shows the fee funds */ })],
});
```

The plugin never sends a transaction: a GOAT `sendTransaction` takes no gas limit or fee caps, and Recta's route is
committed to exact ones. Preview the route there and send it with `@recta/client` or this server.

## elizaOS

The two free tools as elizaOS 2.x actions, `RECTA_FIT` and `RECTA_TRIAL_EVALUATION`. No key: the plugin signs nothing
and sends nothing. It asks Recta, unsigned, whether a cheaper provable route exists for a cross-chain stablecoin
transfer the agent would make anyway, for example with LI.FI (`baseline_provider: "lifi"`) or Stargate
(`"stargate_v2"`), and what Recta's 5 % of that saving would be. 3 trials a day per IP address.

```ts
import { rectaPlugin } from "@recta/mcp/elizaos";

export const character = {
  name: "treasury-agent",
  plugins: [rectaPlugin],
  settings: { RECTA_ADDRESS: "0x…" /* public address the transfers leave from; a call may also pass sender */ },
};
```

`rectaElizaPlugin({ address, estimateFeesPerGas, maxFeePerGasWei, maxPriorityFeePerGasWei })` builds it with your own
options. The source chain's fee estimate comes from its public RPC unless you set `RECTA_RPC_URL_<chainId>` or pass
`estimateFeesPerGas`. elizaOS 1.x actions take no `parameters`, so there the actions answer `MISSING_PARAMETERS` and
never call Recta. To get and execute the route itself, use `npx @recta/mcp` with a key or `@recta/client`.

## Referral for integrators

If you ship Recta inside a plugin, framework or agent template, set your own EVM address once as the `referrer` (`RECTA_REFERRER` for this server, the `referrer` option of the AgentKit provider and the GOAT plugin) and
every agent that runs your integration carries it. Recta fixes it at the agent's first signed evaluation and never
changes it afterwards. You earn 20 % of the fees Recta actually collects from those agents (confirmed on chain) for
12 months, up to 200 USDC per agent, whether or not you pay fees yourself. One level only. The agent still pays exactly
5 % of its verified saving: your share comes out of Recta's 5 %, never on top of it.

The referrer travels in the query of the agent's own signed requests, so nobody relaying them can add, drop or change
it. It is ignored when it is the agent's own address. Terms and your balance: `GET /v1/referrals/balance`, signed by
your address, once Recta's referral program is on (it starts together with fee collection).

## ElizaOS and other MCP hosts

ElizaOS agents load MCP servers through its MCP plugin: point it at `npx -y @recta/mcp` with the environment above,
or at the hosted endpoint `https://api.recta.build/mcp` for the unsigned tools.

## Smart accounts

If the agent's wallet is a Coinbase Smart Wallet on Base, set `RECTA_SMART_ACCOUNT=coinbase`, the owner's key in
`RECTA_PRIVATE_KEY` and a Base bundler in `RECTA_BUNDLER_URL` (and `RECTA_PAYMASTER_URL` if one sponsors your gas).
The server then speaks for the account, not for the key: the account is the `sender`, it holds the USDC, and it pays
the fee. On start the server prints the account's address on stderr.

- Recta accepts a smart account on Base only, so its transfers must start from Base (`source_network: base`). Any
  other source is refused before anything is sent to Recta.
- Requests are signed by the account: Recta asks the account itself on Base whether the signature holds (ERC-1271,
  or ERC-6492 while it is not deployed yet).
- A fee permit needs the account deployed on Base (Permit2 cannot deploy it). An account that is not deployed yet is
  deployed by its first user operation, for example `recta_approve_fee`; until then the server refuses to sign a
  permit (`account_not_deployed`).
- Each checked route transaction is sent as one user operation with the committed call, its call gas limited to the
  committed gas limit and its fees capped by the committed fee caps. The bundler and the paymaster prepare it, and the
  server checks it again before the account signs: if either changed the call, the sender, the call gas, the fee caps
  or the account's init code, or asks for more than `RECTA_MAX_USEROP_OVERHEAD_GAS`, nothing is signed. A failed
  operation is reported as a failure even though the bundle that carried it succeeded. If its receipt does not arrive
  in time, the server says so and names the operation: look it up before trying again.
- Recta recognizes the operation in a bundle sent straight to the ERC-4337 EntryPoint (v0.6, v0.7 or v0.8), which is
  what common bundlers do. A bundler that relays through another contract first is not recognized and the report is
  refused.
- The Permit2 approval sent by the account is not reported to Recta (it is not the committed transaction field by
  field); Recta counts its cost at the committed upper bound, which can only understate your saving.

## What each request identifies

Every request this package sends carries the User-Agent `recta-mcp/<version>`, so Recta can count real use of the package apart from other clients. It names the package and its version only: never an address, a key or a request body.

## Limits of this version

- The server sends only source-chain transactions, so it asks Recta only for routes that need no destination
  transaction from you (`destination_execution: NONE`). This setting leaves out only routes that need you to
  complete a mint on the destination chain (CCTP with your own receive); the other limits are below.
- The same limits as `@recta/client`: EVM sources and recipients only, and only the corridors and contracts pinned in
  the release (a safety measure: it refuses to sign against a contract it does not know).
- Smart accounts: Coinbase Smart Wallet on Base only, with transfers that start from Base, sent through an ERC-4337
  bundler you configure. Other smart accounts (Safe, Kernel and others) can use Recta's API directly or through
  `@recta/client`'s `smartAccountSigner` with any viem smart account.
- The source chain's max fee per gas is twice its current estimate when the agent evaluates, never above
  `RECTA_MAX_FEE_GWEI`; the priority fee is the current estimate, never above `RECTA_MAX_PRIORITY_FEE_GWEI`.

## License

MIT
