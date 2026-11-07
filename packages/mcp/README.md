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

Use a **dedicated wallet** that holds only what the agent may move, never your main one. The key sits in plain text in
that configuration file (and in the environment of the server process), so anyone who can read the file can move the
wallet's funds.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECTA_PRIVATE_KEY` | required | The agent wallet's private key (EOA). It is only used locally, to sign. |
| `RECTA_RPC_<chainId>` | the chain's public RPC | An `https` RPC URL for that chain, e.g. `RECTA_RPC_8453` for Base. `http` is accepted only for `localhost`; any other value stops the server. |
| `RECTA_ALLOW_EXECUTE` | off | Set to `yes` to let the agent sign fee permits and send transactions. Anything else keeps the server read and preview only. |
| `RECTA_MAX_FEE_USDC` | `1` | The most one fee permit may authorize, in USDC. A larger permit is refused. |
| `RECTA_MAX_NATIVE_WEI` | `0` | The most native value one route transaction may carry (messaging fees). `0` refuses routes that need one. |
| `RECTA_MAX_FEE_GWEI` | `50` | The highest source-chain `maxFeePerGas` an evaluation may commit to, whatever the RPC estimates. |
| `RECTA_MAX_PRIORITY_FEE_GWEI` | `2` | The highest priority fee an evaluation may commit to. |
| `RECTA_MIN_OUTPUT_BPS` | `9900` | The route must guarantee the recipient at least this share of the amount sent, in basis points (1–10000). |

## Tools

| Tool | Signs or sends | What it does |
| --- | --- | --- |
| `recta_fit` | nothing | Does Recta cover this corridor, and which contracts would a route touch? |
| `recta_evaluate` | a request signature | Asks Recta whether a cheaper route than `baseline_provider` can be proven. Free. |
| `recta_trial_evaluation` | nothing | The same question unsigned: only whether a saving exists, its amount and Recta's 5 %. No route, nothing stored, 3 a day per address. |
| `recta_preview` | a request signature | Shows the fee ceiling Recta asks you to authorize, after the local permit check. |
| `recta_execute` | fee permit, transactions | Signs the checked permit, sends the checked transactions, reports them. Only with `RECTA_ALLOW_EXECUTE=yes`. |
| `recta_report` | a request signature | Reports an executed route again (after `PENDING`). |
| `recta_pay_debt` | a debt permit | Pays an earlier fee Recta could not collect. Only with `RECTA_ALLOW_EXECUTE=yes`. |
| `recta_ledger` | a request signature | The wallet's Recta fees and whether each was collected. |

`recta_execute` and `recta_pay_debt` are not even listed to the agent unless execution is enabled.

The saving is measured against `baseline_provider`: the route your agent would use without Recta. Declare the one it
really uses. If your agent bridges through LI.FI (its public API or an aggregator built on it), declare `lifi`
wherever the fit check (`GET /v1/golden-corridor/fit`) lists it in `declarable_baselines`; it is refused with
`latency_class` SECONDS or MINUTES. Recta reads LI.FI's own transaction, its fee included. If that route is already the cheapest, Recta answers with no saving and charges nothing; keep your route.

## Coinbase AgentKit

The evaluation tools as AgentKit actions (`recta_fit`, `recta_trial_evaluation`, `recta_evaluate`, `recta_preview`,
`recta_report`, `recta_ledger`), signed by the agent's own AgentKit EVM wallet provider:

```ts
import { AgentKit } from "@coinbase/agentkit";
import { rectaActionProvider } from "@recta/mcp/agentkit";

const agentkit = await AgentKit.from({
  walletProvider, // e.g. a ViemWalletProvider or CdpEvmWalletProvider on Base
  actionProviders: [rectaActionProvider({ limits: { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 } })],
});
```

The provider never sends a transaction: AgentKit's wallet providers replace a transaction's gas limit and fee caps
with their own, and Recta's route is committed to exact ones. Preview the route there and send it with
`@recta/client` or this server. An AgentKit wallet provider lives on one chain, so an evaluation for a route that
starts on another chain is refused. It needs `zod`, which AgentKit already installs.

## GOAT

The evaluation tools as a GOAT plugin, signed with the agent's GOAT EVM wallet:

```ts
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai"; // or any GOAT adapter
import { recta } from "@recta/mcp/goat";

const tools = await getOnChainTools({
  wallet: viem(walletClient),
  plugins: [recta({ limits: { maxPermitUsdcAtomic: 1_000_000n, maxNativeValueWei: 0n, minOutputBps: 9900 }, estimateFeesPerGas: () => publicClient.estimateFeesPerGas() })],
});
```

The plugin never sends a transaction: a GOAT `sendTransaction` takes no gas limit or fee caps, and Recta's route is
committed to exact ones. Preview the route there and send it with `@recta/client` or this server.

## ElizaOS and other MCP hosts

ElizaOS agents load MCP servers through its MCP plugin: point it at `npx -y @recta/mcp` with the environment above,
or at the hosted endpoint `https://api.recta.build/mcp` for the unsigned tools.

## Limits of this version

- The server sends only source-chain transactions, so it always asks Recta for routes that need no destination
  transaction from you (`destination_execution: NONE`). Routes that need you to complete a mint on the destination
  chain are not offered.
- The same limits as `@recta/client`: EVM sources and recipients only, EOA wallets only (no smart accounts), and only
  the corridors and contracts pinned in the release.
- Gas price ceilings are set to twice the source chain's current estimate when the agent evaluates, never above
  `RECTA_MAX_FEE_GWEI` and `RECTA_MAX_PRIORITY_FEE_GWEI`.

## License

MIT
