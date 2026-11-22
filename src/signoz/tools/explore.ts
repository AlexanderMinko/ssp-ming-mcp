import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guarded } from "../../common/result.js";
import { andFilter, queryScalar, signozRequest, signozUrl } from "../signoz.js";
import { READ_ONLY, filterField, timeFields, windowMillis } from "./shared.js";

interface ServiceAccount {
  name?: string;
  status?: string;
  serviceAccountRoles?: Array<Record<string, unknown>>;
}

/** Keeps the account's name, status and role names. The full answer lists every permission of every role. */
function summarizeAccount(account: ServiceAccount): Record<string, unknown> {
  const roles = (account.serviceAccountRoles ?? []).map((entry) => {
    const role = entry.role as { name?: unknown } | undefined;
    return String(role?.name ?? entry.name ?? entry.roleName ?? "unknown");
  });
  return { name: account.name, status: account.status, roles };
}

const signalField = z.enum(["logs", "traces"]).describe("Which data: logs or traces");

export function registerExploreTools(server: McpServer): void {
  server.registerTool(
    "aggregate",
    {
      title: "Aggregate logs or spans",
      description:
        "Compute one number per group over the window, for example error log count per service " +
        "(signal logs, expression count(), groupBy service.name, filter severity_text = 'ERROR') or p99 span duration " +
        "per operation (signal traces, expression p99(duration_nano), groupBy name).",
      inputSchema: {
        signal: signalField,
        expression: z
          .string()
          .default("count()")
          .describe("Aggregation: count(), count_distinct(trace_id), avg(duration_nano), p95(duration_nano), ..."),
        groupBy: z.array(z.string()).default([]).describe("Fields to group by, for example ['service.name']"),
        filter: filterField,
        ...timeFields,
        limit: z.number().int().positive().max(500).default(50).describe("Return at most this many groups"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { startMs, endMs } = windowMillis(args.start, args.end);
        const filter = andFilter([args.filter]);
        const results = await queryScalar(startMs, endMs, {
          signal: args.signal,
          filter,
          limit: args.limit,
          aggregations: [{ expression: args.expression, alias: "value" }],
          groupBy: args.groupBy,
        });
        return { signal: args.signal, expression: args.expression, groupBy: args.groupBy, filter, results };
      }),
  );

  server.registerTool(
    "list_fields",
    {
      title: "List filterable fields",
      description:
        "List the field names that logs or spans carry (resource, attribute, log or span fields). " +
        "Use before writing a filter to find the exact name, for example searchText 'route' or 'status'.",
      inputSchema: {
        signal: signalField,
        searchText: z.string().optional().describe("Substring the field name must contain"),
        fieldContext: z
          .enum(["resource", "attribute", "scope", "span", "log", "body"])
          .optional()
          .describe("Only fields of this kind"),
        limit: z.number().int().positive().max(1000).default(100).describe("Return at most this many fields"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const params = new URLSearchParams({ signal: args.signal, limit: String(args.limit) });
        if (args.searchText !== undefined) {
          params.set("searchText", args.searchText);
        }
        if (args.fieldContext !== undefined) {
          params.set("fieldContext", args.fieldContext);
        }
        const response = await signozRequest<{ data?: unknown }>("/api/v1/fields/keys", { method: "GET", params });
        return response.data ?? response;
      }),
  );

  server.registerTool(
    "field_values",
    {
      title: "List values of a field",
      description:
        "List values one field takes in logs or spans, for example service.name, severity_text or http.route.",
      inputSchema: {
        signal: signalField,
        name: z.string().min(1).describe("Field name, for example service.name"),
        searchText: z.string().optional().describe("Substring the value must contain"),
        limit: z.number().int().positive().max(1000).default(50).describe("Return at most this many values"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const params = new URLSearchParams({ signal: args.signal, name: args.name, limit: String(args.limit) });
        if (args.searchText !== undefined) {
          params.set("searchText", args.searchText);
        }
        const response = await signozRequest<{ data?: unknown }>("/api/v1/fields/values", { method: "GET", params });
        return response.data ?? response;
      }),
  );

  server.registerTool(
    "check_connection",
    {
      title: "Check SigNoz connection",
      description:
        "Check that SigNoz is reachable and the API key works. Use first when another tool fails.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () =>
      guarded(async () => {
        const version = await signozRequest<unknown>("/api/v1/version", { method: "GET", authenticated: false });
        let identity: Record<string, unknown>;
        try {
          const me = await signozRequest<{ data?: ServiceAccount }>("/api/v1/service_accounts/me", { method: "GET" });
          identity = { keyValid: true, account: summarizeAccount(me.data ?? {}) };
        } catch (error: unknown) {
          identity = { keyValid: false, problem: error instanceof Error ? error.message : String(error) };
        }
        return { url: signozUrl(), version, ...identity };
      }),
  );
}
