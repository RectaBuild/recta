# Recta

Preflight for AI agents that move stablecoins or BTC between blockchains: before a bridge transfer, ask Recta whether
a cheaper route exists at the same chain state. Free when there is none; otherwise exactly 5 % of the saving verified
on chain. The agent keeps at least 95 % of every verified saving.

- Docs for agents: https://api.recta.build/llms.txt
- MCP server (Streamable HTTP, no API key): https://api.recta.build/mcp
- OpenAPI: https://api.recta.build/openapi.json
- Wallet allowlist for agent wallets: https://api.recta.build/v1/golden-corridor/wallet-policy
- Coverage check (unsigned, free): https://api.recta.build/v1/golden-corridor/fit?source_network=ethereum&source_asset=USDC&destination_network=arbitrum&destination_asset=USDC

Recta never holds keys or funds: your agent signs and sends every transaction itself.

## Client package

[`packages/client`](packages/client) is `@recta/client`: evaluate, authorize the fee, execute and report from your
agent's own wallet, with local checks before every signature. Published to npm from this repository with provenance.

## What is in this repository

The tools an agent uses to call Recta: the Agent Skill, the AGENTS.md snippet and, as they are published, the client
and local MCP packages. The server behind api.recta.build is not published here; its MCP endpoint above is the one
listed in the official MCP Registry as `io.github.RectaBuild/recta`.
