# @recta/plugin-recta

An [elizaOS](https://elizaos.ai) plugin for [Recta Preflight](https://api.recta.build/preflight). Before your agent moves
USDC or USDT from one chain to another, `RECTA_PREFLIGHT` returns, in one free call:

- what the route will cost in all (USDC) and when it arrives;
- whether Recta proves a cheaper route for that exact transfer, and the saving.

Example measured on 2026-11-19: Base → Arbitrum, 1,000 USDC: a route 2.39 USDC cheaper than LI.FI. Savings move with the
market; the action tells you today's figure.

No API key, no wallet. The plugin never signs and never sends a transaction, and it does not replace your bridge
action: call it first, then bridge as usual (or take Recta's route; Recta charges exactly 5 % of a verified saving and
nothing otherwise).

## Install

```
npm install @recta/plugin-recta
```

```ts
import rectaPlugin from "@recta/plugin-recta";

export const character = {
  name: "treasury-agent",
  plugins: [rectaPlugin],
  settings: { RECTA_ADDRESS: "0x…" /* optional: the public address transfers leave from */ },
};
```

## Actions (elizaOS 2.x)

| Action | What it does |
| --- | --- |
| `RECTA_PREFLIGHT` | Before bridging: total cost, arrival time and any proven cheaper route. Needs `source_network`, `source_asset`, `destination_network` and `amount` (whole tokens); `baseline_provider` defaults to LI.FI. |
| `RECTA_FIT` | Is a corridor covered by Recta? |
| `RECTA_TRIAL_EVALUATION` | The older unsigned saving check. |

3 free checks a day per IP address. elizaOS 1.x actions take no `parameters`, so there the actions answer
`MISSING_PARAMETERS` and never call Recta.

This package is the elizaOS registry entry for `@recta/mcp/elizaos`, which holds the implementation; to sign and
execute Recta's route, see [`@recta/mcp`](https://www.npmjs.com/package/@recta/mcp) and
[`@recta/client`](https://www.npmjs.com/package/@recta/client).

## License

MIT
