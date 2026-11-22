/**
 * Manual smoke test against a real SigNoz (SIGNOZ_URL, default http://localhost:3301; needs SIGNOZ_API_KEY).
 * Spawns the server over stdio exactly as Claude Code does, calls the main tools once, and exits.
 * Run: SIGNOZ_API_KEY=... npm run smoke:signoz   (or export SSP_MING_SIGNOZ_API_KEY and map it, as .mcp.json does)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = { ...process.env } as Record<string, string>;
if (env.SIGNOZ_API_KEY === undefined && env.SSP_MING_SIGNOZ_API_KEY !== undefined) {
  env.SIGNOZ_API_KEY = env.SSP_MING_SIGNOZ_API_KEY;
}
if (env.SIGNOZ_URL === undefined && env.SSP_MING_SIGNOZ_URL !== undefined) {
  env.SIGNOZ_URL = env.SSP_MING_SIGNOZ_URL;
}
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/signoz/server.ts"],
  env,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const calls: Array<[string, Record<string, unknown>]> = [
  ["check_connection", {}],
  ["list_services", { start: "now-6h" }],
  ["search_logs", { start: "now-6h", limit: 3 }],
  ["search_traces", { start: "now-6h", limit: 3 }],
  ["aggregate", { signal: "logs", groupBy: ["service.name"], start: "now-6h" }],
  ["list_fields", { signal: "logs", limit: 10 }],
  ["field_values", { signal: "logs", name: "service.name" }],
];
let firstTraceId: string | undefined;
for (const [toolName, toolArguments] of calls) {
  const result = await client.callTool({ name: toolName, arguments: toolArguments });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  console.log(`== ${toolName}${result.isError ? " (error)" : ""}`);
  console.log(text.slice(0, 700));
  if (toolName === "search_traces" && !result.isError) {
    firstTraceId = (JSON.parse(text) as { spans: Array<{ traceId?: string }> }).spans[0]?.traceId;
  }
}
if (firstTraceId !== undefined) {
  const trace = await client.callTool({ name: "get_trace", arguments: { traceId: firstTraceId } });
  console.log(`== get_trace${trace.isError ? " (error)" : ""}`);
  console.log(((trace.content as Array<{ text?: string }>)[0]?.text ?? "").slice(0, 700));
}
await client.close();
