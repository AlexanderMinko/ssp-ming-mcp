import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guarded } from "../../common/result.js";
import { andFilter, queryRaw, quoteLiteral, serviceCondition, shapeLog } from "../signoz.js";
import { READ_ONLY, filterField, timeFields, windowMillis } from "./shared.js";

export function registerLogTools(server: McpServer): void {
  server.registerTool(
    "search_logs",
    {
      title: "Search logs",
      description:
        "Return log lines from SigNoz, newest first. Narrow by service, severity, text or trace id; " +
        "add any SigNoz filter expression. Use to read what a service logged around an error or for one request.",
      inputSchema: {
        service: z.string().optional().describe("Service, for example exchange or bidders. Matches service.name or k8s.deployment.name"),
        severity: z.string().optional().describe("severity_text, for example ERROR or WARN"),
        text: z.string().optional().describe("Substring the log body must contain"),
        traceId: z.string().optional().describe("Only lines logged inside this trace"),
        filter: filterField,
        ...timeFields,
        limit: z.number().int().positive().max(500).default(50).describe("Return at most this many lines"),
        offset: z.number().int().min(0).default(0).describe("Skip this many lines, for paging"),
        bodyChars: z.number().int().positive().max(20_000).default(2000).describe("Cut each body to this many characters"),
        includeAttributes: z.boolean().default(false).describe("Also return each line's attributes (MDC, logger, thread, ...)"),
        raw: z.boolean().default(false).describe("Return SigNoz's unshaped rows, for debugging the shaping"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { startMs, endMs } = windowMillis(args.start, args.end);
        const filter = andFilter([
          args.service === undefined ? undefined : serviceCondition(args.service),
          args.severity === undefined ? undefined : `severity_text = ${quoteLiteral(args.severity.toUpperCase())}`,
          args.text === undefined ? undefined : `body CONTAINS ${quoteLiteral(args.text)}`,
          args.traceId === undefined ? undefined : `trace_id = ${quoteLiteral(args.traceId)}`,
          args.filter,
        ]);
        const rows = await queryRaw(startMs, endMs, { signal: "logs", filter, limit: args.limit, offset: args.offset });
        if (args.raw) {
          return { filter, count: rows.length, rows };
        }
        return {
          filter,
          count: rows.length,
          mayHaveMore: rows.length === args.limit,
          lines: rows.map((row) => shapeLog(row, args.bodyChars, args.includeAttributes)),
        };
      }),
  );
}
