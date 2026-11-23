import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerQueryTools } from "./tools/queries.js";
import { describeTarget } from "../common/target.js";
import { vmagentUrl, vmUrl } from "./victoriametrics.js";

/** Builds the server without connecting a transport, so tests can attach an in-memory one. */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "victoriametrics", version: "0.2.0" });
  registerQueryTools(server);
  registerDiscoveryTools(server);
  return server;
}

async function main(): Promise<void> {
  const server = buildServer();
  // stdout is the MCP wire. Anything human-readable goes to stderr.
  await server.connect(new StdioServerTransport());
  try {
    console.error(`victoriametrics MCP ready (${describeTarget()}; vmsingle ${vmUrl()}, vmagent ${vmagentUrl()})`);
  } catch (error: unknown) {
    // A bad target file must not kill the server: every tool call reports the same message instead.
    console.error(`victoriametrics MCP ready, but the target is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error("victoriametrics MCP failed to start", error);
    process.exit(1);
  });
}
