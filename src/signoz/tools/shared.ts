import { z } from "zod";
import { parseTime } from "../../common/time.js";

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const timeFields = {
  start: z.string().default("now-1h").describe("Window start: now-15m, now-1h, unix seconds or RFC 3339. Default now-1h"),
  end: z.string().default("now").describe("Window end: now, unix seconds or RFC 3339. Default now"),
};

export const filterField = z
  .string()
  .optional()
  .describe(
    "Extra SigNoz filter expression, ANDed with the other arguments. Examples: http.route = '/openrtb2/auction', " +
      "body CONTAINS 'timeout', severity_text IN ('ERROR', 'WARN')",
  );

/** Converts the start/end arguments to unix milliseconds and checks their order. */
export function windowMillis(start: string, end: string): { startMs: number; endMs: number } {
  const nowSeconds = Date.now() / 1000;
  const startMs = parseTime(start, nowSeconds) * 1000;
  const endMs = parseTime(end, nowSeconds) * 1000;
  if (endMs <= startMs) {
    throw new Error("end must be after start");
  }
  return { startMs, endMs };
}
