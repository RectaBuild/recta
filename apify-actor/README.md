# Recta: cross-chain transfer preflight for AI agents

Before your agent bridges USDC, USDT or USDG between blockchains, Recta checks every route it knows (Across, CCTP,
Stargate, USDT0, deBridge and others) at the same block and proves whether a cheaper one exists. **Free if not; exactly
5 % of the saving verified on chain if so.** Your agent keeps at least 95 % of every saving.

This Actor is free and holds no key: it tells you whether Recta covers your corridor and which bridges it compares
(never a route or a price), and can return the allowlist for agent wallets. For the quote itself, connect the MCP
server `https://api.recta.build/mcp` and sign with your own wallet.

Docs for agents: https://api.recta.build/llms.txt · OpenAPI: https://api.recta.build/openapi.json
