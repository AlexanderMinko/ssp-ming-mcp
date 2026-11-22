/**
 * Manual smoke test against a real Mongo (MONGO_URI and BIDDERS_MONGO_URI, default localhost). Spawns the server over stdio
 * exactly as Claude Code does, lists supply partners and bidders, and exits. Run: npm run smoke:mongo
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mongo/server.ts"],
  env: { ...process.env } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

for (const toolName of ["list_supply_partners", "list_bidders", "list_creatives"]) {
  const result = await client.callTool({ name: toolName, arguments: {} });
  console.log(`== ${toolName}`);
  console.log(result.content);
}
await client.close();
