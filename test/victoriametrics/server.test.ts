import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localUrl } from "../../src/common/ports.js";
import { buildServer } from "../../src/victoriametrics/server.js";
import { vmagentUrl, vmUrl } from "../../src/victoriametrics/victoriametrics.js";

/** Runs body with the given environment variables set, then restores the previous values. */
async function withEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Handshake over an in-memory transport: proves the six tools register with valid schemas. No VictoriaMetrics needed. */
describe("victoriametrics server", () => {
  it("lists the six read-only tools", async () => {
    const { client, close } = await connectedClient();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["label_values", "list_metrics", "list_targets", "query", "query_range", "tsdb_status"],
    );
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
    }
    const queryTool = tools.find((tool) => tool.name === "query");
    assert.ok(queryTool);
    assert.deepEqual(queryTool.inputSchema.required, ["query"]);
    await close();
  });

  it("returns an error result, not a crash, when VictoriaMetrics is unreachable", async () => {
    await withEnv({ VM_URL: "http://127.0.0.1:1", VMAGENT_URL: undefined }, async () => {
      const { client, close } = await connectedClient();
      const result = await client.callTool({ name: "query", arguments: { query: "up" } });
      assert.equal(result.isError, true);
      await close();
    });
  });
});

describe("URLs", () => {
  it("defaults to the local VictoriaMetrics single for both roles", async () => {
    await withEnv({ VM_URL: undefined, VMAGENT_URL: undefined }, async () => {
      assert.equal(vmUrl(), localUrl("victoriametrics"));
      assert.equal(vmagentUrl(), localUrl("victoriametrics"));
    });
  });

  it("uses VMAGENT_URL for targets when set, and drops trailing slashes", async () => {
    await withEnv({ VM_URL: "http://localhost:18428/", VMAGENT_URL: "http://localhost:18429/" }, async () => {
      assert.equal(vmUrl(), "http://localhost:18428");
      assert.equal(vmagentUrl(), "http://localhost:18429");
    });
  });

  it("falls back to VM_URL when VMAGENT_URL is empty, as an unset ${VMAGENT_URL:-} expands", async () => {
    await withEnv({ VM_URL: "http://localhost:18428", VMAGENT_URL: "" }, async () => {
      assert.equal(vmagentUrl(), "http://localhost:18428");
    });
  });
});
