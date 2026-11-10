# @recta/client

A client for [Recta](https://api.recta.build/llms.txt): before your agent moves stablecoins between blockchains, Recta
finds a cheaper route it can prove against the route you would use anyway, and charges exactly 5 % of the saving it
verifies on chain after you execute. No saving, no charge.

This package runs Recta's four steps with the wallet your agent already has:

```
evaluate → authorizeFee → execute → report
```

It never receives a key. Before it signs or sends anything it checks it locally, and those checks cannot be turned off.

## Install

```
npm install @recta/client viem
```

`viem` (>= 2.38.3, < 3) is the only dependency, and you choose its version.

## Use

```ts
import { createRectaClient, viemSigner, viemChainReader } from "@recta/client";

const recta = createRectaClient({
  signer: viemSigner({ account, walletClientFor: (chainId) => walletClients[chainId] }),
  chain: viemChainReader((chainId) => publicClients[chainId]),
  limits: {
    maxPermitUsdcAtomic: 5_000_000n, // never authorize more than 5 USDC in one fee permit
    maxNativeValueWei: 10n ** 15n,   // never attach more than 0.001 native to one route transaction
    minOutputBps: 9900,              // required, 1–10000: the route must guarantee the recipient at least 99 % of the amount sent
  },
  referrer: "0x…",                   // optional: the integrator that ships this agent (see "Referral for integrators")
});

// Dry run: evaluates and checks, signs no permit, sends no transaction. With Recta's collection on it stops at the
// fee permit, before the transactions exist (Recta hands them out only after the permit is signed): `preview.fee`
// carries the permit it would sign and `funds`, whether this wallet can pay it (see "Paying the fee").
const preview = await recta.run(request, { dryRun: true });

// The whole flow.
const result = await recta.run(request);
```

`request` is Recta's evaluation request (schema in the
[service descriptor](https://api.recta.build/v1/golden-corridor/commercial-evaluations/schema)); its `sender` must be
your signer's address. Each step is also available alone: `evaluate`, `authorizeFee`, `check`, `execute`, `report`,
`ledger`, `payDebt`, `feeFunds`, `feeApproval`.

An EOA signs its requests as EIP-191 signatures recovered to the sender's address. A smart account on Base signs
through `smartAccountSigner` (see "Smart accounts").

## Referral for integrators

If you ship Recta inside a plugin, framework or agent template, set your own EVM address once as the `referrer` and
every agent that runs your integration carries it. Recta fixes it at the agent's first signed evaluation and never
changes it afterwards. You earn 20 % of the fees Recta actually collects from those agents (confirmed on chain) for
12 months, up to 200 USDC per agent, whether or not you pay fees yourself. One level only. The agent still pays exactly
5 % of its verified saving: your share comes out of Recta's 5 %, never on top of it.

The referrer travels in the query of the agent's own signed requests, so nobody relaying them can add, drop or change
it. It is ignored when it is the agent's own address. Terms and your balance: `GET /v1/referrals/balance`, signed by
your address, once Recta's referral program is on (it starts together with fee collection).

### Smart accounts

A smart account on Base works through `smartAccountSigner`: any viem smart account (for example
`toCoinbaseSmartAccount` from `viem/account-abstraction`) and an ERC-4337 bundler client on Base, with a paymaster if
one sponsors your gas:

```ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createBundlerClient, toCoinbaseSmartAccount } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import { createRectaClient, smartAccountSigner, viemChainReader } from "@recta/client";

const client = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const account = await toCoinbaseSmartAccount({ client, owners: [privateKeyToAccount(OWNER_KEY)], version: "1.1" });
const bundlerClient = createBundlerClient({ account, client, transport: http(BUNDLER_URL) });

const recta = createRectaClient({
  signer: smartAccountSigner({ account, bundlerClient }),
  chain: viemChainReader((chainId) => publicClients[chainId]),
  limits: { maxPermitUsdcAtomic: 5_000_000n, maxNativeValueWei: 10n ** 15n, minOutputBps: 9900 },
});
```

- The account is the `sender`, holds the USDC and pays the fee. Recta accepts a smart account on Base only, so its
  transfers must start from Base; any other source is refused before any request.
- Requests carry `x-recta-signer-chain: 8453` and are signed in Recta's v2 text, which also names the account and the
  chain. Recta asks the account on Base whether the signature holds (ERC-1271, or ERC-6492 while it is not deployed).
- A fee or debt permit is signed only once the account is deployed on Base (Permit2 cannot deploy it): otherwise
  `RectaCheckError` `account_not_deployed`. Its first user operation deploys it, for example the bounded approval from
  `feeApproval()`.
- Each checked route transaction is one user operation: the committed call, call gas limited to the committed gas
  limit, fees capped by the committed fee caps. A failed operation throws even when its bundle transaction succeeded.
- `report` never sends a smart account's `approval_tx_hash`: the approval is the account's operation, not the
  committed transaction field by field, so Recta counts it at its committed upper bound.

### Coinbase CDP accounts

A [Coinbase CDP](https://docs.cdp.coinbase.com) EVM server account (an EOA whose key stays in CDP) works through
`cdpSigner`. This package does not depend on the CDP SDK:

```ts
import { CdpClient } from "@coinbase/cdp-sdk";
import { createRectaClient, cdpSigner, viemChainReader } from "@recta/client";

const cdp = new CdpClient();
const account = await cdp.evm.getOrCreateAccount({ name: "my-agent" });

const recta = createRectaClient({
  signer: cdpSigner({ account }),
  chain: viemChainReader((chainId) => publicClients[chainId]),
  limits: { maxPermitUsdcAtomic: 5_000_000n, maxNativeValueWei: 10n ** 15n, minOutputBps: 9900 },
});
```

CDP signs Recta's requests and the fee permit. On Ethereum, Base, Arbitrum, Optimism, Polygon and Avalanche, CDP also
sends each route transaction once this package has checked it. On any other chain, pass `walletClientFor` as well:
CDP then signs the transaction and your RPC sends it.

To limit the account to Recta's contracts at CDP's side too, apply the
[CDP Policy Engine policy Recta serves](https://api.recta.build/v1/golden-corridor/wallet-policy/cdp). CDP refuses
anything that policy does not allow, and it allows sending only on those six chains: with the policy applied, a route
on any other chain is refused by CDP unless you add your own rule for it.

The saving is measured against `baseline_provider`: the route your agent would use without Recta. Declare the one it
really uses. If your agent bridges through LI.FI (its public API or an aggregator built on it), declare `lifi`
wherever the fit check (`GET /v1/golden-corridor/fit`) lists it in `declarable_baselines`; it is refused with
`latency_class` SECONDS or MINUTES. Recta reads LI.FI's own transaction, its fee included. If that route is already the cheapest, Recta answers with no saving and charges nothing.

## Paying the fee: USDC and the Permit2 allowance on Base

Recta's fee is collected in USDC on Base through Permit2. Signing the permit is not enough: when Recta settles it,
Permit2 pulls the fee with USDC's own `transferFrom`, so the wallet also needs, on Base, (1) at least the permit's amount
in USDC and (2) an ERC-20 allowance from USDC to Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) of at least that
amount. A new wallet has neither.

Before it signs a fee or debt permit, the client reads both through `chain.readFeeFunds` (on Base: `viemChainReader`
uses `publicClients[8453]`) and refuses, with `RectaCheckError` `fee_balance` or `fee_allowance`, when either is short.
Nothing is signed and no route transaction is sent, so a route never executes with a fee Recta cannot collect.

```ts
const funds = await recta.feeFunds();      // { ready, balanceUsdcAtomic, permit2AllowanceUsdcAtomic, missing }
if (funds.missing.includes("allowance")) {
  const approval = recta.feeApproval();    // USDC.approve(Permit2, maxPermitUsdcAtomic) on Base, for you to send
  // send `approval` (chainId, to, data, value) with your own wallet
}
```

The approval is bounded: `feeApproval` defaults to, and may not exceed, `maxPermitUsdcAtomic`, and
`permit2ApprovalTransaction` refuses 0 and any "unlimited" amount. The client never approves by itself. Each collected
fee lowers the allowance; approve again when `feeFunds` reports it short. The check is a snapshot at signing: a wallet
that later spends its USDC or revokes the allowance leaves the fee unpaid, which Recta records as a debt to settle
before the next evaluation (`payDebt`).

When the route itself starts from USDC on Base, the transfer spends the same balance before the fee is pulled, so the
balance must cover the transfer plus the fee: `run` passes the request to `authorizeFee` for that (pass it yourself as
`authorizeFee(id, { request })` when calling the steps alone), and `execute` checks the funds again, for every fee
this client authorized or found authorized, right before the first transaction. A reader error never carries the RPC
URL (it may hold an API key).

Since 0.1.4 `RectaChainReader` requires `readFeeFunds`; `createRectaClient` refuses a reader without it.

A custom `RectaChainReader` must implement `readFeeFunds(owner)`; when it cannot read Base it must throw, and the permit
is then not signed (a dry run reports `funds: null` and the reason).

## What is checked before signing

**Pins.** The package carries Recta's fee addresses in its own code: Permit2, x402's `upto` proxy, USDC on Base,
Recta's fee recipient and Recta's facilitator. Recta's wallet policy is read live and must agree with them; if it does
not, nothing is signed.

**The fee permit** (Permit2 `PermitWitnessTransferFrom` on Base) is signed only if the domain is Permit2 on Base, the
types are exactly Recta's, the spender is the `upto` proxy, the token is USDC, `witness.to` is Recta's recipient,
`witness.facilitator` is Recta's sender, the amount is the decision's cap plus what it carries from earlier unpaid fees
and is within `maxPermitUsdcAtomic`, and the deadline is in the future and no later than the commercial expiry plus 37
days. The typed data signed is rebuilt from those checked fields, not taken as the server sent it. Recta settles exactly
5 % of the verified saving, never more than the permit.

**The fee permit is signed before the route can be reviewed.** Recta hands out a decision's transactions only once its
fee authorization is stored, so the permit comes first. Its ceiling (`max_fee_authorization` plus earlier unpaid fees,
never more than `maxPermitUsdcAtomic`) is the most you can owe for a decision; Recta still settles only 5 % of a saving
it verifies on chain, so a route you refuse below and never execute owes nothing.

**Every route transaction** is checked against a route table pinned in this package, generated from Recta's own server
configuration: for each EVM corridor, the source and destination tokens and the only contracts a route may approve
and call, with the destination each call must name. The wallet policy Recta serves never adds to it. A transaction is
sent only if: it is EIP-1559 with an empty access list, on the source chain, from your signer, within your request's
gas price ceilings; an approval is `approve` of the pinned source token, for exactly the transfer amount, to the pinned
contract the execution then calls; the execution decodes as that contract's own call (Across `deposit`, CCTP V2
`depositForBurn` or LayerZero OFT/Stargate `send`) naming your sender, your recipient, the source token and the exact
amount, the pinned destination (Across chain id and output token, with no message; CCTP domain, completable by
anyone; LayerZero endpoint id, with no executor options, compose message or OFT command), and a guaranteed output of at least `minOutputBps` of the
amount (Across `outputAmount`, CCTP amount minus `maxFee`, LayerZero `minAmountLD`); native value is allowed only as
the declared messaging fee, within `maxNativeValueWei`.

`report` returns `stage`: `ACCRUED` (Recta verified and recorded the saving), `PENDING` (report again later) or
`REFUSED` (Recta will not accrue this execution; see `body.reason_code`).

**Debts.** If Recta refuses a new evaluation because an earlier fee could not be collected, `evaluate` throws
`RectaDebtError` with the offer. The package never signs a debt by itself: call `payDebt(offer)` if you agree (same
checks, exact amount).

## What each request identifies

Every request this package sends carries the User-Agent `recta-client/<version>`, so Recta can count real use of the package apart from other clients. It names the package and its version only: never an address, a key or a request body.

## Limits of this version

- EVM sources and EVM recipients only. Solana, Tron and Bitcoin routes, Relay and deBridge are refused.
- Smart accounts on Base only, with transfers that start from Base (Recta's own rule: an address proves one account
  on one chain). The route is sent through an ERC-4337 bundler; an account that is only driven by its owner's direct
  calls (no bundler) is not supported by `smartAccountSigner`.
- Only the corridors and contracts pinned in the release, as a safety measure: the package refuses to sign against a
  contract it does not know. A corridor or contract Recta adds later is served by the API at once, but refused by
  this package until a new release pins it.

## Provenance

Every release is published from [RectaBuild/recta](https://github.com/RectaBuild/recta) by GitHub Actions with npm
provenance and no long-lived token. Check it before you trust a version:

```
npm audit signatures
```

## License

MIT
