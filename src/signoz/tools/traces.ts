import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guarded } from "../../common/result.js";
import {
  andFilter,
  nanosToMillis,
  orderTrace,
  queryRaw,
  quoteLiteral,
  shapeSpan,
  signozRequest,
} from "../signoz.js";
import { READ_ONLY, filterField, timeFields, windowMillis } from "./shared.js";

/** Earliest 13-digit millisecond value. For a trace_id filter SigNoz narrows the scan to the trace's own time range. */
const ALL_TIME_START_MS = 1_000_000_000_000;
const TRACE_SPAN_LIMIT = 1000;

type ServiceRow = Record<string, unknown>;

/** The services endpoints answer either { data: [...] } or a bare array. */
function listOf(response: unknown): ServiceRow[] {
  if (Array.isArray(response)) {
    return response as ServiceRow[];
  }
  const data = (response as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as ServiceRow[]) : [];
}

/** Rewrites the nanosecond latency fields of a services row as milliseconds. */
function latenciesInMillis(row: ServiceRow, nanoFields: string[]): ServiceRow {
  const shaped: ServiceRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (nanoFields.includes(key)) {
      shaped[`${key}Ms`] = nanosToMillis(value);
    } else {
      shaped[key] = value;
    }
  }
  return shaped;
}

const nanosAsString = (millis: number): string => String(Math.floor(millis) * 1_000_000);

export function registerTraceTools(server: McpServer): void {
  server.registerTool(
    "search_traces",
    {
      title: "Search spans",
      description:
        "Return spans from SigNoz, newest first. Narrow by service, span name, errors or a minimum duration; " +
        "add any SigNoz filter expression. Use to find slow or failed requests, then open one with get_trace.",
      inputSchema: {
        service: z.string().optional().describe("service.name, for example exchange or bidders"),
        name: z.string().optional().describe("Span name, for example 'POST /openrtb2/auction'"),
        errorsOnly: z.boolean().default(false).describe("Only spans with has_error = true"),
        minDurationMs: z.number().positive().optional().describe("Only spans at least this long, in milliseconds"),
        filter: filterField,
        ...timeFields,
        limit: z.number().int().positive().max(500).default(50).describe("Return at most this many spans"),
        orderBy: z.enum(["timestamp", "duration_nano"]).default("timestamp").describe("Newest first, or slowest first"),
        raw: z.boolean().default(false).describe("Return SigNoz's unshaped rows, for debugging the shaping"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { startMs, endMs } = windowMillis(args.start, args.end);
        const filter = andFilter([
          args.service === undefined ? undefined : `service.name = ${quoteLiteral(args.service)}`,
          args.name === undefined ? undefined : `name = ${quoteLiteral(args.name)}`,
          args.errorsOnly ? "has_error = true" : undefined,
          args.minDurationMs === undefined ? undefined : `duration_nano >= ${Math.round(args.minDurationMs * 1_000_000)}`,
          args.filter,
        ]);
        const rows = await queryRaw(startMs, endMs, {
          signal: "traces",
          filter,
          limit: args.limit,
          orderBy: args.orderBy,
        });
        if (args.raw) {
          return { filter, count: rows.length, rows };
        }
        return { filter, count: rows.length, mayHaveMore: rows.length === args.limit, spans: rows.map(shapeSpan) };
      }),
  );

  server.registerTool(
    "get_trace",
    {
      title: "Get one trace",
      description:
        "Return every span of one trace as a waterfall: parent first, children indented by depth, with the start " +
        "offset and duration in milliseconds. Use after search_traces or a traceId found in a log line.",
      inputSchema: {
        traceId: z.string().min(1).describe("The trace id, 32 hex characters"),
        raw: z.boolean().default(false).describe("Return SigNoz's unshaped rows, for debugging the shaping"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const rows = await queryRaw(ALL_TIME_START_MS, Date.now(), {
          signal: "traces",
          filter: `trace_id = ${quoteLiteral(args.traceId)}`,
          limit: TRACE_SPAN_LIMIT,
        });
        if (args.raw) {
          return { count: rows.length, rows };
        }
        if (rows.length === 0) {
          throw new Error(`No spans found for trace ${args.traceId}`);
        }
        const spans = orderTrace(rows.map(shapeSpan));
        const services = [...new Set(spans.map((span) => span.service).filter((service) => service !== undefined))];
        return {
          traceId: args.traceId,
          spanCount: spans.length,
          truncated: rows.length === TRACE_SPAN_LIMIT,
          services,
          errorSpans: spans.filter((span) => span.hasError === true).length,
          spans,
        };
      }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List the services that sent traces in the window, with request rate, error rate and p99 / average latency.",
      inputSchema: { ...timeFields },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { startMs, endMs } = windowMillis(args.start, args.end);
        const response = await signozRequest<unknown>("/api/v2/services", {
          method: "POST",
          body: { start: nanosAsString(startMs), end: nanosAsString(endMs) },
        });
        const services = listOf(response).map((row) => latenciesInMillis(row, ["p99", "avgDuration"]));
        return { count: services.length, services };
      }),
  );

  server.registerTool(
    "top_operations",
    {
      title: "Top operations of a service",
      description:
        "List one service's operations (span names) with call count, error count and p50 / p95 / p99 latency.",
      inputSchema: {
        service: z.string().min(1).describe("service.name, for example exchange"),
        ...timeFields,
        limit: z.number().int().positive().max(500).default(50).describe("Return at most this many operations"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { startMs, endMs } = windowMillis(args.start, args.end);
        const response = await signozRequest<unknown>("/api/v2/service/top_operations", {
          method: "POST",
          body: {
            start: nanosAsString(startMs),
            end: nanosAsString(endMs),
            service: args.service,
            tags: [],
            limit: args.limit,
          },
        });
        const operations = listOf(response).map((row) => latenciesInMillis(row, ["p50", "p95", "p99"]));
        return { service: args.service, count: operations.length, operations };
      }),
  );
}
