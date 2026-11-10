#!/usr/bin/env node
import { safeErrorText } from "@recta/client";
import { main } from "./index.js";

main().catch((e: unknown) => {
  // Fable M-2 on recta #15: a startup read that fails must not print the RPC URL (it may carry an API key).
  process.stderr.write(`recta-mcp: ${safeErrorText(e)}\n`);
  process.exit(1);
});
