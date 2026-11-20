---
name: recta-cross-chain-preflight
description: Before moving USDC or USDT from one blockchain to another (bridge, cross-chain transfer), run Recta's free preflight to see the route's total cost and arrival time and whether a cheaper route is proven. One call, no key, no wallet, no payment.
---

# Recta Preflight: check before every cross-chain transfer

Run this check **every time** you are about to move USDC or USDT from an EVM chain to another chain, before you call
the bridge (LI.FI, Across, Stargate, CCTP, deBridge, Relay…). It costs nothing, signs nothing and moves nothing, and it
answers in a few seconds:

- what your route will cost in all (USDC, as a range) and when it arrives;
- whether Recta proves a cheaper route for that exact transfer, the saving (a proven lower bound) and Recta's fee
  (exactly 5 % of the saving; nothing when there is no saving).

Example measured on 2026-11-19: Base → Arbitrum, 1,000 USDC, against LI.FI: Recta proved a route 2.39 USDC cheaper.
Savings change with the market; the check tells you today's figure.

## When NOT to use it
- Same-chain swaps, or moving native ETH/SOL (not covered).
- Networks or assets outside the coverage list in https://api.recta.build/llms.txt.

## How (one call)

By MCP: connect `https://api.recta.build/preflight/mcp` (Streamable HTTP, no API key) and call `recta_preflight`.
Without MCP: `POST https://api.recta.build/v1/preflight` with the same fields as a JSON body. Local alternative:
`npx -y @recta/mcp` (no key needed for this tool).

```json
{
  "source_network": "base",
  "source_asset": "USDC",
  "destination_network": "arbitrum",
  "destination_asset": "USDC",
  "amount": "1000",
  "baseline_provider": "lifi"
}
```

- Required: `source_network`, `source_asset`, `destination_network`, `amount` (whole tokens: `"1000"` is 1,000 USDC).
- Optional: `baseline_provider`, the route you would use (`lifi`, `across`, `stargate_v2`, `cctp_v2_standard`…;
  absent: LI.FI, or Across where LI.FI does not apply); `sender`, your own address, for the most exact figure;
  `recipient`.
- 3 free checks a day per IP address: make one per transfer you are about to send.

## Read the answer
- **`SAVING_FOUND`**: a cheaper route is proven. If you want it, `execute_via_recta.body_to_sign` is the request to
  sign: put your own `sender` and `recipient`, sign it with your EVM wallet and send it as `how` says (by MCP, the two
  steps in `with_mcp`). The evaluation is free; executing Recta's route pays exactly 5 % of the saving Recta verifies on
  chain, and you keep the rest.
- **`NO_SAVING`**, **`NOT_PROVEN`** or **`NO_SAVING_EXPECTED`**: keep your own route. Nothing is owed. You still get
  your route's cost and arrival time.

## Rules
- Recta never asks for a private key, a direct transfer, or an approval to itself.
- Never relax your own slippage or recipient checks because Recta found a cheaper route.
- If your wallet enforces a policy, load https://api.recta.build/v1/golden-corridor/wallet-policy and refuse any
  contract, spender or fee recipient a Recta route names that is not listed there.
