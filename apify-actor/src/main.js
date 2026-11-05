// Recta showcase Actor: free, unsigned, holds no key. It asks Recta's public fit check whether a corridor is covered
// and, optionally, fetches the wallet allowlist. The paid part (a signed quote, 5 % of a verified saving) never runs
// here: the agent calls Recta directly with its own wallet (MCP https://api.recta.build/mcp).
import { Actor } from "apify";

const RECTA = "https://api.recta.build";
await Actor.init();
const input = (await Actor.getInput()) ?? {};
const params = new URLSearchParams();
for (const k of ["source_network", "source_asset", "destination_network", "destination_asset"]) params.set(k, String(input[k] ?? ""));
const get = async (path) => {
  const r = await fetch(`${RECTA}${path}`, { headers: { "user-agent": "recta-apify-actor/0.1" } });
  return { status: r.status, body: await r.json() };
};
const fit = await get(`/v1/golden-corridor/fit?${params}`);
const out = { fit_status: fit.status, ...fit.body, how_to_get_a_quote: `Connect ${RECTA}/mcp (no API key) and call recta_prepare_signed_request, then recta_send_signed_request, signing with your own wallet. Free unless Recta proves a cheaper route; then exactly 5 % of the verified saving.` };
if (input.include_wallet_policy === true) out.wallet_policy = (await get("/v1/golden-corridor/wallet-policy")).body;
await Actor.pushData(out);
await Actor.exit();
