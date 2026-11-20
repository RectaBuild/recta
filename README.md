# Recta

Preflight for AI agents that move stablecoins between blockchains: before a bridge transfer, ask Recta whether
a cheaper route exists at the same chain state. Free when there is none; otherwise exactly 5 % of the saving verified
on chain. The agent keeps at least 95 % of every verified saving.

Recta never holds keys or funds: your agent signs and sends every transaction itself.

## Start here

- **Docs for agents:** https://api.recta.build/llms.txt
- **Free check, no wallet, no key:** [Recta Preflight](https://api.recta.build/preflight), as an MCP server
  (`https://api.recta.build/preflight/mcp`) or `POST https://api.recta.build/v1/preflight`. It answers your route's
  cost and arrival time and whether a cheaper route is proven for that exact transfer.
- **Full MCP server** (Streamable HTTP, no API key): https://api.recta.build/mcp
- **OpenAPI:** https://api.recta.build/openapi.json
- **Coverage check** (unsigned, free):
  https://api.recta.build/v1/golden-corridor/fit?source_network=ethereum&source_asset=USDC&destination_network=arbitrum&destination_asset=USDC
- **Wallet allowlist for agent wallets:** https://api.recta.build/v1/golden-corridor/wallet-policy

## Packages

- [`@recta/client`](https://www.npmjs.com/package/@recta/client) ([source](packages/client)): evaluate, authorize the
  fee, execute and report from your agent's own wallet, with local checks before every signature. `withPreflight`
  puts the free preflight in front of the bridge your agent already calls (LI.FI SDK, Vercel AI SDK tools).
- [`@recta/mcp`](https://www.npmjs.com/package/@recta/mcp) ([source](packages/mcp)): a local MCP server over the client,
  so Claude, Cursor or any MCP agent runs the same flow with its own key, which stays on the machine. Execution is off
  until the operator turns it on; then each transfer is capped (`RECTA_MAX_AMOUNT`, default 1000 tokens) and goes only
  to the wallet itself or an address the operator lists (`RECTA_ALLOWED_RECIPIENTS`), checked before anything is
  signed. What it can and cannot do with the wallet: [Safety](packages/mcp#safety). The same package is a plugin for
  MetaMask's agent wallet CLI (`mm recta`), a Coinbase AgentKit action provider (`@recta/mcp/agentkit`), a GOAT plugin
  (`@recta/mcp/goat`) and an elizaOS plugin (`@recta/mcp/elizaos`).

Both are published to npm from this repository by GitHub Actions, with provenance (`npm audit signatures`).

## What is in this repository

The tools an agent uses to call Recta: the two npm packages above, the Agent Skills in [`skills`](skills) and the
[AGENTS.md snippet](AGENTS-snippet.md). To make the preflight a standing step of a coding agent (Claude Code, Cursor,
Codex and others that read Agent Skills): `npx skills add RectaBuild/recta`. The server behind api.recta.build is not published here. In the official MCP
Registry, Recta is listed as `io.github.RectaBuild/recta` (the full server and `@recta/mcp`) and
`io.github.RectaBuild/preflight` (the free Preflight server).
