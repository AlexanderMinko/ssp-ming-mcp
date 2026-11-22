import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/mongo/server.js";

/** Handshake over an in-memory transport: proves the nine tools register with valid schemas. No Mongo needed. */
describe("exchange-mongo server", () => {
  it("lists the nine tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        "delete_bidder",
        "delete_creative",
        "delete_supply_partner",
        "list_bidders",
        "list_creatives",
        "list_supply_partners",
        "upsert_bidder",
        "upsert_creative",
        "upsert_supply_partner",
      ],
    );
    const upsert = tools.find((tool) => tool.name === "upsert_supply_partner");
    assert.ok(upsert);
    assert.deepEqual(upsert.inputSchema.required, ["entityType", "name"]);

    await client.close();
    await server.close();
  });
});
