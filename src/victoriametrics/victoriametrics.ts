/**
 * Thin client over the VictoriaMetrics HTTP API, which is Prometheus-compatible
 * (https://docs.victoriametrics.com/victoriametrics/url-examples/).
 *
 * Two roles, two URLs:
 *   VM_URL       the TSDB that answers queries: vmsingle (EKS: svc/vmsingle-vm :8428, local Compose: :8428).
 *   VMAGENT_URL  the scraper that owns the target list: vmagent (EKS: svc/vmagent-vm :8429).
 *                Unset = VM_URL, because the local VictoriaMetrics single both scrapes and stores.
 */

const DEFAULT_VM_URL = "http://localhost:8428"; // local Compose VictoriaMetrics single
const REQUEST_TIMEOUT_MS = 15_000;

export function vmUrl(): string {
  return (process.env.VM_URL ?? DEFAULT_VM_URL).replace(/\/+$/, "");
}

export function vmagentUrl(): string {
  const configured = process.env.VMAGENT_URL;
  if (configured === undefined || configured.trim() === "") {
    return vmUrl();
  }
  return configured.replace(/\/+$/, "");
}

interface ApiEnvelope<T> {
  status: "success" | "error";
  data?: T;
  errorType?: string;
  error?: string;
  warnings?: string[];
}

export interface ApiResult<T> {
  data: T;
  warnings: string[];
}

/**
 * GETs one API path from vmsingle (default) or vmagent. Throws with VictoriaMetrics's own error text,
 * which names the MetricsQL problem.
 */
export async function apiGet<T>(
  path: string,
  params: URLSearchParams = new URLSearchParams(),
  target: "vmsingle" | "vmagent" = "vmsingle",
): Promise<ApiResult<T>> {
  const base = target === "vmagent" ? vmagentUrl() : vmUrl();
  const query = params.toString();
  const url = `${base}${path}${query ? `?${query}` : ""}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${target} unreachable at ${base} (${reason}). Is it running, or is the port-forward up?`);
  }
  const text = await response.text();
  let envelope: ApiEnvelope<T>;
  try {
    envelope = JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    throw new Error(`${target} answered HTTP ${response.status} with non-JSON: ${text.slice(0, 200)}`);
  }
  if (envelope.status !== "success" || envelope.data === undefined) {
    throw new Error(`${target} ${envelope.errorType ?? `HTTP ${response.status}`}: ${envelope.error ?? "unknown error"}`);
  }
  return { data: envelope.data, warnings: envelope.warnings ?? [] };
}

/** The API sends sample values as strings. Numbers read better; NaN and Inf stay strings because JSON has no form for them. */
export function sampleValue(raw: string): number | string {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}
