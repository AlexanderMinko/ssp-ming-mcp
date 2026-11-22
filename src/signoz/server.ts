import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { signozUrl } from "./signoz.js";
import { registerExploreTools } from "./tools/explore.js";
import { registerLogTools } from "./tools/logs.js";
import { registerTraceTools } from "./tools/traces.js";

/** Builds the server without connecting a transport, so tests can attach an in-memory one. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "ssp-signoz", version: "0.1.0" });
  registerLogTools(server);
  registerTraceTools(server);
  registerExploreTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  // stdout is the MCP wire. Anything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  const keyState = process.env.SIGNOZ_API_KEY?.trim() ? "API key set" : "NO API key";
  console.error(`ssp-signoz MCP ready (${signozUrl()}, ${keyState})`);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error("ssp-signoz MCP failed to start", error);
    process.exit(1);
  });
}
