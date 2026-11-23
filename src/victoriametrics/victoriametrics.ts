/**
 * Thin client over the VictoriaMetrics HTTP API, which is Prometheus-compatible
 * (https://docs.victoriametrics.com/victoriametrics/url-examples/).
 *
 * Two roles, two URLs:
 *   vmsingle  the TSDB that answers queries
 *   vmagent   the scraper that owns the target list
 *
 * Where the URLs come from (first match wins):
 *   1. VM_URL / VMAGENT_URL, when set and not blank
 *   2. target local: the Compose VictoriaMetrics single (ports.json local), which both scrapes and stores (vmagent = VM_URL)
 *   3. target eks:   the forwards from scripts/eks-port-forward.sh, ports from ports.json eks
 */
import { forwardUrl, localUrl } from "../common/ports.js";
import { currentTarget, describeTarget, explicitSetting } from "../common/target.js";

const REQUEST_TIMEOUT_MS = 15_000;

const TARGET_URLS = {
  local: { vmsingle: localUrl("victoriametrics"), vmagent: localUrl("victoriametrics") },
  eks: { vmsingle: forwardUrl("vmsingle"), vmagent: forwardUrl("vmagent") },
} as const;

const trimSlashes = (url: string): string => url.replace(/\/+$/, "");

export function vmUrl(): string {
  return trimSlashes(explicitSetting("VM_URL") ?? TARGET_URLS[currentTarget().target].vmsingle);
}

export function vmagentUrl(): string {
  const explicit = explicitSetting("VMAGENT_URL");
  if (explicit !== undefined) {
    return trimSlashes(explicit);
  }
  // An explicit VM_URL without a VMAGENT_URL means one process does both jobs, as the local single does.
  if (explicitSetting("VM_URL") !== undefined) {
    return vmUrl();
  }
  return TARGET_URLS[currentTarget().target].vmagent;
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
    throw new Error(`${target} unreachable at ${base} (${reason}; ${describeTarget()}). Is it running, or is the port-forward up?`);
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
