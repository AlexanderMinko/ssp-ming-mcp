import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet } from "../victoriametrics.js";
import { parseTime } from "../../common/time.js";
import { guarded } from "../../common/result.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const limitField = z.number().int().positive().max(5000).default(200).describe("Return at most this many values");

const startField = z
  .string()
  .optional()
  .describe("Look back to this time: now-7d, unix seconds or RFC 3339. VictoriaMetrics searches only about the last day by default");

interface TargetsData {
  activeTargets: Array<{
    labels: Record<string, string>;
    scrapePool: string;
    scrapeUrl: string;
    health: "up" | "down" | "unknown";
    lastError: string;
    lastScrape: string;
    lastScrapeDuration: number;
  }>;
}

interface NameValue {
  name: string;
  value: number;
}

interface TsdbStatusData {
  totalSeries?: number;
  totalLabelValuePairs?: number;
  seriesCountByMetricName?: NameValue[];
  seriesCountByLabelName?: NameValue[];
  seriesCountByFocusLabelValue?: NameValue[];
  seriesCountByLabelValuePair?: NameValue[];
  labelValueCountByLabelName?: NameValue[];
}

/** Adds an optional match[] selector and an optional lookback start to a label request. */
function labelParams(match: string | undefined, start: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (match !== undefined) {
    params.append("match[]", match);
  }
  if (start !== undefined) {
    params.set("start", String(parseTime(start)));
  }
  return params;
}

/** Keeps only name and value, because newer VictoriaMetrics versions add request statistics to each entry. */
function nameValues(entries: NameValue[] | undefined): NameValue[] | undefined {
  return entries?.map((entry) => ({ name: entry.name, value: entry.value }));
}

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "list_metrics",
    {
      title: "List metric names",
      description:
        "List metric names VictoriaMetrics stores. Use before writing a query to find the exact name, " +
        "for example filter 'http_server' or 'jvm_memory'.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring the metric name must contain"),
        match: z.string().optional().describe("Series selector that limits the names, for example {job=\"exchange\"}"),
        start: startField,
        limit: limitField,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { data } = await apiGet<string[]>("/api/v1/label/__name__/values", labelParams(args.match, args.start));
        const needle = args.filter?.toLowerCase();
        const names = needle === undefined ? data : data.filter((name) => name.toLowerCase().includes(needle));
        return { total: names.length, truncated: Math.max(0, names.length - args.limit), names: names.slice(0, args.limit) };
      }),
  );

  server.registerTool(
    "label_values",
    {
      title: "List label values",
      description:
        "List the values of one label, optionally only on series matching a selector. " +
        "Examples: label job; label uri with match http_server_requests_seconds_count{job=\"exchange\"}.",
      inputSchema: {
        label: z.string().min(1).describe("Label name, for example job, instance, namespace, pod, uri, status"),
        match: z.string().optional().describe("Series selector that limits the values"),
        start: startField,
        limit: limitField,
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const path = `/api/v1/label/${encodeURIComponent(args.label)}/values`;
        const { data } = await apiGet<string[]>(path, labelParams(args.match, args.start));
        return { label: args.label, total: data.length, truncated: Math.max(0, data.length - args.limit), values: data.slice(0, args.limit) };
      }),
  );

  server.registerTool(
    "list_targets",
    {
      title: "List scrape targets",
      description:
        "List what vmagent scrapes and whether each target is up, with the last scrape error. " +
        "Use first when a metric is missing. On EKS this needs VMAGENT_URL (svc/vmagent-vm).",
      inputSchema: {
        job: z.string().optional().describe("Only targets of this job, for example exchange or bidders"),
        health: z.enum(["up", "down", "unknown"]).optional().describe("Only targets in this state"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const { data } = await apiGet<TargetsData>("/api/v1/targets", new URLSearchParams({ state: "active" }), "vmagent");
        const targets = data.activeTargets
          .filter((target) => args.job === undefined || target.labels.job === args.job)
          .filter((target) => args.health === undefined || target.health === args.health)
          .map((target) => ({
            job: target.labels.job,
            instance: target.labels.instance,
            health: target.health,
            scrapeUrl: target.scrapeUrl,
            lastScrape: target.lastScrape,
            lastScrapeDurationMs: Math.round(target.lastScrapeDuration * 1000),
            lastError: target.lastError || undefined,
          }));
        return { count: targets.length, targets };
      }),
  );

  server.registerTool(
    "tsdb_status",
    {
      title: "Series cardinality",
      description:
        "Show how many time series exist and which metric names, labels and label values create the most. " +
        "Use to find a cardinality explosion, for example a label that carries a request id.",
      inputSchema: {
        topN: z.number().int().positive().max(100).default(10).describe("Entries per list"),
        date: z.string().optional().describe("Day to inspect as YYYY-MM-DD (UTC). Default today"),
        match: z.string().optional().describe("Only series matching this selector, for example {job=\"exchange\"}"),
        focusLabel: z.string().optional().describe("Also list the values of this label with the most series"),
      },
      annotations: READ_ONLY,
    },
    async (args) =>
      guarded(async () => {
        const params = new URLSearchParams({ topN: String(args.topN) });
        if (args.date !== undefined) {
          params.set("date", args.date);
        }
        if (args.match !== undefined) {
          params.append("match[]", args.match);
        }
        if (args.focusLabel !== undefined) {
          params.set("focusLabel", args.focusLabel);
        }
        const { data } = await apiGet<TsdbStatusData>("/api/v1/status/tsdb", params);
        return {
          totalSeries: data.totalSeries,
          totalLabelValuePairs: data.totalLabelValuePairs,
          seriesCountByMetricName: nameValues(data.seriesCountByMetricName),
          seriesCountByLabelName: nameValues(data.seriesCountByLabelName),
          seriesCountByLabelValuePair: nameValues(data.seriesCountByLabelValuePair),
          labelValueCountByLabelName: nameValues(data.labelValueCountByLabelName),
          seriesCountByFocusLabelValue: nameValues(data.seriesCountByFocusLabelValue),
        };
      }),
  );
}
