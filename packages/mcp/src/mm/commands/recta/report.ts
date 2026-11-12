// `mm recta report`: see ../../specs.ts. `mm` resolves @metamask/agent-wallet/plugin to its own running copy.
import * as sdk from "@metamask/agent-wallet/plugin";
import { rectaCommand } from "../../specs.js";

export default rectaCommand(sdk, "recta:report");
