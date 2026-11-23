import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../../src/signoz/server.js";

interface SeenRequest {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: Record<string, unknown> | undefined;
}

const seen: SeenRequest[] = [];
let fake: Server;
let fakeUrl = "";

const LOG_RESPONSE = {
  status: "success",
  data: {
    type: "raw",
    data: {
      results: [
        {
          queryName: "A",
          rows: [
            {
              timestamp: "2026-11-21T10:00:00Z",
              data: { body: "bidder timeout", severity_text: "WARN", resources_string: { "service.name": "exchange" } },
            },
          ],
        },
      ],
    },
  },
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A fake SigNoz: 401 for a wrong key, HTML for unknown routes, canned JSON for query_range. */
before(async () => {
  fake = createServer(async (request, response) => {
    const text = await readBody(request);
    const apiKey = request.headers["signoz-api-key"] as string | undefined;
    seen.push({ method: request.method ?? "", url: request.url ?? "", apiKey, body: text ? JSON.parse(text) : undefined });
    if (apiKey !== "good-key") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "error", error: { code: "unauthenticated", message: "unauthenticated" } }));
      return;
    }
    if (request.url === "/api/v5/query_range") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(LOG_RESPONSE));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><html></html>");
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

async function withClient(env: Record<string, string | undefined>, body: (client: Client) => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  try {
    await body(client);
  } finally {
    await client.close();
    await server.close();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function textOf(result: unknown): string {
  return ((result as { content: Array<{ text: string }> }).content[0] as { text: string }).text;
}

describe("ssp-signoz server", () => {
  it("lists the nine read-only tools", async () => {
    await withClient({}, async (client) => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [
        "aggregate",
        "check_connection",
        "field_values",
        "get_trace",
        "list_fields",
        "list_services",
        "search_logs",
        "search_traces",
        "top_operations",
      ]);
      for (const tool of tools) {
        assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} must be read-only`);
      }
    });
  });

  it("explains a missing key without calling SigNoz", async () => {
    await withClient({ SIGNOZ_URL: fakeUrl, SIGNOZ_API_KEY: undefined }, async (client) => {
      const before = seen.length;
      const result = await client.callTool({ name: "search_logs", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /SSP_MING_SIGNOZ_API_KEY/);
      assert.equal(seen.length, before);
    });
  });

  it("reports a rejected key", async () => {
    await withClient({ SIGNOZ_URL: fakeUrl, SIGNOZ_API_KEY: "wrong-key" }, async (client) => {
      const result = await client.callTool({ name: "search_logs", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /rejected the API key \(HTTP 401/);
    });
  });

  it("sends the key and a v5 logs query, and shapes the rows", async () => {
    await withClient({ SIGNOZ_URL: fakeUrl, SIGNOZ_API_KEY: "good-key" }, async (client) => {
      const result = await client.callTool({
        name: "search_logs",
        arguments: { service: "exchange", severity: "warn", limit: 5 },
      });
      assert.equal(result.isError, undefined);
      const request = seen.at(-1);
      assert.ok(request);
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/api/v5/query_range");
      assert.equal(request.apiKey, "good-key");
      const spec = (request.body?.compositeQuery as { queries: Array<{ spec: Record<string, unknown> }> }).queries[0]?.spec;
      assert.deepEqual(spec?.filter, {
        expression: "(service.name = 'exchange' OR k8s.deployment.name = 'exchange') AND (severity_text = 'WARN')",
      });
      assert.equal(spec?.limit, 5);
      const answer = JSON.parse(textOf(result));
      assert.equal(answer.count, 1);
      assert.deepEqual(answer.lines[0], {
        time: "2026-11-21T10:00:00Z",
        severity: "WARN",
        service: "exchange",
        body: "bidder timeout",
      });
    });
  });

  it("turns an HTML answer into a clear error", async () => {
    await withClient({ SIGNOZ_URL: fakeUrl, SIGNOZ_API_KEY: "good-key" }, async (client) => {
      const result = await client.callTool({ name: "list_services", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /HTML page/);
    });
  });
});
