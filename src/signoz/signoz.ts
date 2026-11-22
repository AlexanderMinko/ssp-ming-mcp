/**
 * Thin client over the self-hosted SigNoz HTTP API (logs and traces).
 *
 * SIGNOZ_URL      the SigNoz UI/API (local Compose: http://localhost:3301, EKS: a port-forward).
 * SIGNOZ_API_KEY  a service-account key (Settings → Service Accounts → Keys). Comes from the shell, never a file.
 *
 * The .mcp.json entry maps SSP_MING_SIGNOZ_URL / SSP_MING_SIGNOZ_API_KEY from the shell onto these names, so a key
 * exported for another SigNoz (for example the work one) is never sent here by accident.
 */

const DEFAULT_URL = "http://localhost:3301";
const REQUEST_TIMEOUT_MS = 30_000;

export function signozUrl(): string {
  return (process.env.SIGNOZ_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

function apiKey(): string {
  const key = process.env.SIGNOZ_API_KEY;
  if (key === undefined || key.trim() === "") {
    throw new Error(
      "SIGNOZ_API_KEY is not set. Create a service-account key in SigNoz (Settings → Service Accounts → Keys), " +
        "export SSP_MING_SIGNOZ_API_KEY in the shell, and restart Claude Code.",
    );
  }
  return key.trim();
}

interface ErrorEnvelope {
  status?: string;
  error?: string | { code?: string; message?: string; suggestions?: string[] };
  errorType?: string;
}

/** Turns SigNoz's two error shapes (current object form, legacy string form) into one message. */
function errorText(envelope: ErrorEnvelope): string | undefined {
  if (envelope.status !== "error") {
    return undefined;
  }
  if (typeof envelope.error === "string") {
    return `${envelope.errorType ?? "error"}: ${envelope.error}`;
  }
  const suggestions = envelope.error?.suggestions?.length ? ` Suggestions: ${envelope.error.suggestions.join("; ")}` : "";
  return `${envelope.error?.code ?? "error"}: ${envelope.error?.message ?? "unknown error"}${suggestions}`;
}

export interface RequestOptions {
  method: "GET" | "POST";
  params?: URLSearchParams;
  body?: unknown;
  authenticated?: boolean;
}

/**
 * Calls one SigNoz API path and returns the parsed JSON. Redirects are refused, so the key never leaves SIGNOZ_URL.
 * An HTML answer means SigNoz served its web UI, which it does for routes that do not exist.
 */
export async function signozRequest<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.authenticated !== false) {
    headers["SIGNOZ-API-KEY"] = apiKey();
  }
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const query = options.params?.toString();
  const url = `${signozUrl()}${path}${query ? `?${query}` : ""}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`SigNoz unreachable at ${signozUrl()} (${reason}). Is it running, or is the port-forward up?`);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`SigNoz rejected the API key (HTTP ${response.status}). Check SSP_MING_SIGNOZ_API_KEY and the service account's role.`);
  }
  if (text.trimStart().startsWith("<")) {
    throw new Error(`SigNoz answered ${path} with an HTML page, so this SigNoz version has no such API route.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`SigNoz answered HTTP ${response.status} with non-JSON: ${text.slice(0, 200)}`);
  }
  const failure = errorText(parsed as ErrorEnvelope);
  if (failure !== undefined) {
    throw new Error(`SigNoz ${failure}`);
  }
  if (!response.ok) {
    throw new Error(`SigNoz HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return parsed as T;
}

/** Quotes a value for a SigNoz filter expression: single quotes, with backslash and quote escaped. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Joins the non-empty conditions with AND, wrapping each in parentheses so a user's OR stays grouped. */
export function andFilter(conditions: Array<string | undefined>): string {
  return conditions
    .filter((condition): condition is string => condition !== undefined && condition.trim() !== "")
    .map((condition) => `(${condition.trim()})`)
    .join(" AND ");
}

export type Signal = "logs" | "traces";

export interface BuilderQuery {
  signal: Signal;
  filter: string;
  limit: number;
  offset?: number;
  orderBy?: string;
  aggregations?: Array<{ expression: string; alias: string }>;
  groupBy?: string[];
}

/** Builds a POST /api/v5/query_range body. start and end are unix milliseconds. */
export function queryRangeBody(
  requestType: "raw" | "scalar",
  startMs: number,
  endMs: number,
  query: BuilderQuery,
): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    name: "A",
    signal: query.signal,
    disabled: false,
    filter: { expression: query.filter },
    having: { expression: "" },
    limit: query.limit,
    offset: query.offset ?? 0,
  };
  if (query.aggregations !== undefined) {
    spec.aggregations = query.aggregations;
    spec.groupBy = (query.groupBy ?? []).map((name) => ({ name }));
    spec.order = [{ key: { name: query.aggregations[0]?.alias ?? "value" }, direction: "desc" }];
  } else {
    spec.order = [{ key: { name: query.orderBy ?? "timestamp" }, direction: "desc" }];
  }
  return {
    schemaVersion: "v1",
    start: Math.floor(startMs),
    end: Math.floor(endMs),
    requestType,
    variables: {},
    compositeQuery: { queries: [{ type: "builder_query", spec }] },
    formatOptions: { formatTableResultForUI: false, fillGaps: false },
  };
}

export interface RawRow {
  timestamp?: string;
  data?: Record<string, unknown>;
}

interface QueryRangeResponse {
  data?: { data?: { results?: Array<{ rows?: RawRow[] | null } & Record<string, unknown>> } };
}

export async function queryRaw(startMs: number, endMs: number, query: BuilderQuery): Promise<RawRow[]> {
  const response = await signozRequest<QueryRangeResponse>("/api/v5/query_range", {
    method: "POST",
    body: queryRangeBody("raw", startMs, endMs, query),
  });
  return (response.data?.data?.results ?? []).flatMap((result) => result.rows ?? []);
}

export async function queryScalar(startMs: number, endMs: number, query: BuilderQuery): Promise<unknown> {
  const response = await signozRequest<QueryRangeResponse>("/api/v5/query_range", {
    method: "POST",
    body: queryRangeBody("scalar", startMs, endMs, query),
  });
  return response.data?.data?.results ?? [];
}

// ---- Row shaping. Key names differ between SigNoz versions, so every getter tries the known spellings.

const RESOURCE_MAPS = ["resources_string", "resource_string", "resource", "resources"];
const ATTRIBUTE_MAPS = ["attributes_string", "attribute_string", "attributes", "tagMap"];

function mapEntry(data: Record<string, unknown>, mapNames: string[], key: string): unknown {
  for (const mapName of mapNames) {
    const map = data[mapName];
    if (map !== null && typeof map === "object" && key in (map as Record<string, unknown>)) {
      return (map as Record<string, unknown>)[key];
    }
  }
  return undefined;
}

/** First non-empty value among the given top-level keys, then among the given keys inside the attribute maps. */
export function pick(data: Record<string, unknown>, keys: string[], mapNames: string[] = []): unknown {
  for (const key of keys) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  for (const key of keys) {
    const value = mapEntry(data, mapNames, key);
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function nanosToMillis(value: unknown): number | undefined {
  const nanos = asNumber(value);
  return nanos === undefined ? undefined : Math.round(nanos / 10_000) / 100;
}

/** ISO time of a row: the row-level ISO string, else the record's nanosecond timestamp. */
function rowTime(row: RawRow, data: Record<string, unknown>): string | undefined {
  if (row.timestamp !== undefined) {
    return row.timestamp;
  }
  const nanos = asNumber(data.timestamp);
  return nanos === undefined ? undefined : new Date(nanos / 1_000_000).toISOString();
}

export interface LogLine {
  time?: string;
  severity?: string;
  service?: string;
  body?: string;
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, unknown>;
}

export function shapeLog(row: RawRow, bodyChars: number, includeAttributes: boolean): LogLine {
  const data = row.data ?? {};
  const body = asText(data.body);
  const line: LogLine = {
    time: rowTime(row, data),
    severity: asText(pick(data, ["severity_text", "severityText"])),
    service: asText(pick(data, ["service.name", "serviceName"], RESOURCE_MAPS)),
    body: body !== undefined && body.length > bodyChars ? `${body.slice(0, bodyChars)}… (${body.length} chars)` : body,
    traceId: asText(pick(data, ["trace_id", "traceId", "traceID"])),
    spanId: asText(pick(data, ["span_id", "spanId", "spanID"])),
  };
  if (includeAttributes) {
    const attributes: Record<string, unknown> = {};
    for (const mapName of ATTRIBUTE_MAPS.concat(["attributes_number", "attributes_bool"])) {
      const map = data[mapName];
      if (map !== null && typeof map === "object") {
        Object.assign(attributes, map);
      }
    }
    line.attributes = attributes;
  }
  return line;
}

export interface SpanLine {
  time?: string;
  service?: string;
  name?: string;
  durationMs?: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  hasError?: boolean;
  statusCode?: string;
  kind?: string;
}

export function shapeSpan(row: RawRow): SpanLine {
  const data = row.data ?? {};
  const hasError = pick(data, ["has_error", "hasError"]);
  return {
    time: rowTime(row, data),
    service: asText(pick(data, ["service.name", "serviceName"], RESOURCE_MAPS)),
    name: asText(pick(data, ["name", "span_name"])),
    durationMs: nanosToMillis(pick(data, ["duration_nano", "durationNano"])),
    traceId: asText(pick(data, ["trace_id", "traceId", "traceID"])),
    spanId: asText(pick(data, ["span_id", "spanId", "spanID"])),
    parentSpanId: asText(pick(data, ["parent_span_id", "parentSpanId", "parentSpanID"])),
    hasError: hasError === undefined ? undefined : hasError === true || hasError === "true",
    statusCode: asText(
      pick(data, ["response_status_code", "http.response.status_code", "http.status_code", "status_code"], ATTRIBUTE_MAPS),
    ),
    kind: asText(pick(data, ["kind_string", "spanKind", "kind"])),
  };
}

export interface TraceSpan extends SpanLine {
  depth: number;
  offsetMs: number;
}

/**
 * Orders one trace's spans parent-first, the way a waterfall reads: each span under its parent, siblings by start time.
 * depth is the nesting level; offsetMs is the start relative to the earliest span.
 */
export function orderTrace(spans: SpanLine[]): TraceSpan[] {
  const startOf = (span: SpanLine): number => (span.time === undefined ? 0 : Date.parse(span.time));
  const byStart = [...spans].sort((left, right) => startOf(left) - startOf(right));
  const traceStart = byStart.length === 0 ? 0 : startOf(byStart[0] as SpanLine);
  const known = new Set(byStart.map((span) => span.spanId));
  const children = new Map<string, SpanLine[]>();
  const roots: SpanLine[] = [];
  for (const span of byStart) {
    const parent = span.parentSpanId;
    if (parent === undefined || parent === span.spanId || !known.has(parent)) {
      roots.push(span);
    } else {
      const siblings = children.get(parent) ?? [];
      siblings.push(span);
      children.set(parent, siblings);
    }
  }
  const ordered: TraceSpan[] = [];
  const visit = (span: SpanLine, depth: number): void => {
    ordered.push({ ...span, depth, offsetMs: Math.round(startOf(span) - traceStart) });
    for (const child of children.get(span.spanId ?? "") ?? []) {
      visit(child, depth + 1);
    }
  };
  for (const root of roots) {
    visit(root, 0);
  }
  return ordered;
}
