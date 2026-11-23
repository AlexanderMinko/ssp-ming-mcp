import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeMongo, describeSources } from "./mongo.js";
import { registerBidderTools } from "./tools/bidders.js";
import { registerCreativeTools } from "./tools/creatives.js";
import { registerSupplyPartnerTools } from "./tools/supplyPartners.js";

/** Builds the server without connecting a transport, so tests can attach an in-memory one. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "exchange-mongo", version: "0.1.0" });
  registerSupplyPartnerTools(server);
  registerBidderTools(server);
  registerCreativeTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  // stdout is the MCP wire. Anything human-readable goes to stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  try {
    console.error(`exchange-mongo MCP ready (${describeSources()})`);
  } catch (error: unknown) {
    console.error(`exchange-mongo MCP ready, but the target is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const shutdown = async (): Promise<void> => {
    await closeMongo();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error("exchange-mongo MCP failed to start", error);
    process.exit(1);
  });
}
