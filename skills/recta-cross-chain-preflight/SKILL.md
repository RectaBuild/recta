---
name: recta-cross-chain-preflight
description: Before moving stablecoins from one blockchain to another (bridge, cross-chain transfer), ask Recta whether a cheaper route exists at the same chain state. Free unless it proves a saving; then 5 % of that saving.
---

# Recta: preflight before a cross-chain transfer

Use this skill whenever you are about to move USDC, USDT or USDG from one EVM chain to another and you already have a
route in mind (Across, CCTP, Stargate, USDT0, deBridge, Relay…). Recta compares that route (your *baseline*) with every
route it knows, read at the same block, and tells you whether a cheaper one exists.

## When NOT to use it
- Same-chain swaps, or moving native ETH/SOL (not covered yet).
- Networks or assets outside the coverage list in https://api.recta.build/llms.txt.

## How
1. Connect the MCP server `https://api.recta.build/mcp` (Streamable HTTP, no API key), or use the HTTP API described
   in https://api.recta.build/openapi.json.
2. Read `recta_service_descriptor` once for the request schema. Then `recta_prepare_signed_request` (POST
   `/v1/golden-corridor/commercial-evaluations` with your baseline route, amount, sender and recipient) gives the exact
   text to sign; sign it with your own EVM wallet (EIP-191 `personal_sign`) and pass the signature to
   `recta_send_signed_request`. Recta never holds a key.
3. Read the decision:
   - **Abstention / no saving** → keep your baseline. Nothing is charged.
   - **Winner with a proven saving** → fetch the execution artifact. If collection is on, it first answers an x402 v2
     `402` (scheme `upto`, Base USDC): sign the ceiling; only exactly 5 % of the saving Recta later verifies on chain is
     pulled. You keep at least 95 % of every verified saving.
4. Execute the committed transactions yourself, then report the origin transaction hash so Recta can verify delivery.

## Wallet policy
If your wallet has a policy engine (allowlists, outflow caps), load
https://api.recta.build/v1/golden-corridor/wallet-policy first: it lists, per network, the exact-amount approvals,
the contracts Recta's routes call and the only fee spender and recipient. Refuse anything a decision names that is not
in that list.

## Rules
- Recta never asks for a private key, a direct transfer, or an approval to itself.
- Never relax your own slippage or recipient checks because Recta found a cheaper route.
