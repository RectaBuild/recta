---
name: recta-metamask-agent-wallet
description: When your agent moves stablecoins between chains with the MetaMask agent wallet CLI (mm), ask Recta first for a cheaper route, signed and sent by your own MetaMask wallet. Free unless Recta proves a saving; then exactly 5 % of that saving.
---

# Recta in the MetaMask agent wallet (`mm`)

Use this skill when you are about to move USDC, USDT or USDG from one EVM chain to another and you already have a
route in mind. Declare it as `--baseline-provider`: one of the corridor's `declarable_baselines` that `mm recta fit`
lists (across, stargate_v2, usdt0, usdg_oft, debridge_dln or lifi). Recta compares that route (your *baseline*) with
every route it knows, read at the same block. If a cheaper one can be proven, your MetaMask wallet signs and sends it;
Recta charges exactly 5 % of the saving it verifies on chain. If not, keep your route: nothing is owed.

## Setup (once)
1. `mm` 7.3 or later, logged in, with a wallet selected.
2. `mm config set experimentalPlugins true` (MetaMask's plugin system is in beta).
3. `mm plugins install @recta/mcp` and accept the permissions it lists for each `recta` command.
4. Recta's fee is paid in USDC on Base: keep a little USDC on Base in the same wallet and run
   `mm recta approve-fee --amount-usdc 1` once (a bounded approval to Permit2, never unlimited).
   `mm recta fee-funds` shows whether the wallet is ready.

## Before each cross-chain transfer
1. Optional, free and unsigned: `mm recta trial --source-network <from> --source-asset USDC --destination-network <to> --amount <whole units> --baseline-provider <your route> --json`.
2. `mm recta move` with the same flags, `--json`. Read the answer:
   - `next` says keep your own route → do your transfer as planned. Nothing is owed.
   - `preview` with a fee ceiling → Recta proved a saving. Run the same command again with `--execute`: Recta
     evaluates again at the current chain state, your wallet signs the fee permit (at most `--max-fee-usdc`), sends
     Recta's checked transactions and reports them. The answer's `execution.report` is `ACCRUED`, `PENDING` or
     `REFUSED`.
3. After `PENDING`: `mm recta report --result-id <id> --origin-tx-hash <hash> --json` later.
   An error with code `RECTA_TRANSFER_SENT` means the transfer already left: never send it again, by Recta or by
   your own route. Its hint carries the exact `mm recta report …` command.
4. An error with code `RECTA_DEBT`: an earlier fee could not be collected. Pay it with
   `mm recta pay-debt --debt-offer '<the debt_offer JSON from the error>'`, then evaluate again.

## Notes
- `--amount` is in whole units of the asset (100 means 100 USDC), from 3.5 with no upper limit.
- MetaMask may pause a signature or a transaction for your approval (`[AWAITING_MFA]`): approve it where MetaMask
  asks, and the command continues.
- Every signature must recover to your wallet's address, and every transaction is read back once mined: if anything
  Recta committed to (gas limit, fee caps, data, destination) was changed, nothing more is sent.
- Coverage, networks and the full API: https://api.recta.build/llms.txt

## Rules
- Recta never asks for a private key, a direct transfer, or an unlimited approval.
- Never relax your own slippage or recipient checks because Recta found a cheaper route.
