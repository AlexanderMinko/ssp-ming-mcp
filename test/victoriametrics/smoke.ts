/**
 * Manual smoke test against a real VictoriaMetrics (VM_URL, default the local VictoriaMetrics from ports.json; targets from VMAGENT_URL,
 * default VM_URL). Spawns the server over stdio exactly as Claude Code does, calls each tool once, and exits.
 * Run: npm run smoke:victoriametrics
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/victoriametrics/server.ts"],
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const calls: Array<[string, Record<string, unknown>]> = [
  ["list_targets", {}],
  ["query", { query: "up" }],
  ["query_range", { query: "up", start: "now-10m", step: "1m" }],
  ["list_metrics", { filter: "http_server", limit: 10 }],
  ["label_values", { label: "job" }],
  ["tsdb_status", { topN: 5 }],
];
for (const [toolName, toolArguments] of calls) {
  const result = await client.callTool({ name: toolName, arguments: toolArguments });
  console.log(`== ${toolName}${result.isError ? " (error)" : ""}`);
  const first = (result.content as Array<{ text?: string }>)[0];
  console.log(first?.text?.slice(0, 600));
}
await client.close();
