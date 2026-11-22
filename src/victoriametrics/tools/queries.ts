import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, sampleValue } from "../victoriametrics.js";
import { autoStepSeconds, isoTime, parseDurationSeconds, parseTime } from "../../common/time.js";
import { guarded } from "../../common/result.js";

type Labels = Record<string, string>;
type Sample = [number, string];

interface QueryData {
  resultType: "vector" | "matrix" | "scalar" | "string";
  result: unknown;
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const maxSeriesField = z
  .number()
  .int()
  .positive()
  .max(500)
  .default(50)
  .describe("Return at most this many series; the answer reports how many were cut");

/** Shapes a query answer into compact JSON: labels plus numeric values, timestamps as ISO 8601 UTC. */
function shapeResult(data: QueryData, maxSeries: number): unknown {
  if (data.resultType === "scalar" || data.resultType === "string") {
    const [timestamp, value] = data.result as Sample;
    return { resultType: data.resultType, time: isoTime(timestamp), value: sampleValue(value) };
  }
  if (data.resultType === "vector") {
    const series = data.result as Array<{ metric: Labels; value: Sample }>;
    return {
      resultType: "vector",
      seriesCount: series.length,
      truncated: Math.max(0, series.length - maxSeries),
      series: series.slice(0, maxSeries).map((entry) => ({
        labels: entry.metric,
        time: isoTime(entry.value[0]),
        value: sampleValue(entry.value[1]),
      })),
    };
  }
  const series = data.result as Array<{ metric: Labels; values: Sample[] }>;
  return {
    resultType: "matrix",
    seriesCount: series.length,
    truncated: Math.max(0, series.length - maxSeries),
    series: series.slice(0, maxSeries).map((entry) => ({
      labels: entry.metric,
      points: entry.values.map(([timestamp, value]) => [isoTime(timestamp), sampleValue(value)]),
    })),
  };
}

export function registerQueryTools(server: McpServer): void {
  server.registerTool(
    "query",
    {
      title: "MetricsQL instant query",
      description:
        "Evaluate a MetricsQL expression at one point in time (default now). MetricsQL extends PromQL, " +
        "so PromQL queries work almost unchanged. Use for current values: " +
        "up, rate(http_server_requests_seconds_count[5m]), histogram_quantile(...).",
      inputSchema: {
        query: z.string().min(1).describe("MetricsQL or PromQL expression"),
        time: z.string().optional().describe("Evaluation time: now, now-15m, unix seconds or RFC 3339. Default now"),
        maxSeries: maxSeriesField,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const params = new URLSearchParams({ query: args.query });
        if (args.time !== undefined) {
          params.set("time", String(parseTime(args.time)));
        }
        const { data, warnings } = await apiGet<QueryData>("/api/v1/query", params);
        return { ...(shapeResult(data, args.maxSeries) as object), warnings };
      }),
  );

  server.registerTool(
    "query_range",
    {
      title: "MetricsQL range query",
      description:
        "Evaluate a MetricsQL (PromQL-compatible) expression over a time window, for trends and before/after comparisons. " +
        "Without a step the server picks one that gives about 120 points per series.",
      inputSchema: {
        query: z.string().min(1).describe("MetricsQL or PromQL expression"),
        start: z.string().default("now-1h").describe("Window start: now-1h, unix seconds or RFC 3339"),
        end: z.string().default("now").describe("Window end: now, unix seconds or RFC 3339"),
        step: z.string().optional().describe("Resolution as a duration such as 15s, 1m, 5m"),
        maxSeries: maxSeriesField,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const nowSeconds = Date.now() / 1000;
        const startSeconds = parseTime(args.start, nowSeconds);
        const endSeconds = parseTime(args.end, nowSeconds);
        if (endSeconds <= startSeconds) {
          throw new Error(`end (${isoTime(endSeconds)}) must be after start (${isoTime(startSeconds)})`);
        }
        const stepSeconds =
          args.step !== undefined ? parseDurationSeconds(args.step) : autoStepSeconds(startSeconds, endSeconds);
        const params = new URLSearchParams({
          query: args.query,
          start: String(startSeconds),
          end: String(endSeconds),
          step: String(stepSeconds),
        });
        const { data, warnings } = await apiGet<QueryData>("/api/v1/query_range", params);
        return {
          start: isoTime(startSeconds),
          end: isoTime(endSeconds),
          stepSeconds,
          ...(shapeResult(data, args.maxSeries) as object),
          warnings,
        };
      }),
  );
}
