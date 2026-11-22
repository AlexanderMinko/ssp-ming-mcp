/** Time and duration parsing shared by the servers. All times are unix seconds unless a name says otherwise. */

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };

/** Parses a duration such as "90s", "5m", "1h", "7d" into seconds. */
export function parseDurationSeconds(input: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhdw])$/.exec(input.trim());
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Bad duration "${input}". Use a number and a unit s, m, h, d or w, for example 5m.`);
  }
  const unitSeconds = UNIT_SECONDS[match[2]];
  if (unitSeconds === undefined) {
    throw new Error(`Bad duration unit in "${input}"`);
  }
  return Number(match[1]) * unitSeconds;
}

/**
 * Parses "now", "now-1h", unix seconds or an RFC 3339 timestamp into unix seconds.
 * A timestamp without an offset is read as UTC.
 */
export function parseTime(input: string, nowSeconds: number = Date.now() / 1000): number {
  const trimmed = input.trim();
  if (trimmed === "now") {
    return nowSeconds;
  }
  const relative = /^now-(.+)$/.exec(trimmed);
  if (relative && relative[1] !== undefined) {
    return nowSeconds - parseDurationSeconds(relative[1]);
  }
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const millis = Date.parse(hasOffset ? trimmed : `${trimmed}Z`);
  if (Number.isNaN(millis)) {
    throw new Error(`Bad time "${input}". Use now, now-1h, unix seconds or RFC 3339.`);
  }
  return millis / 1000;
}

/** Picks a step that gives about targetPoints samples, rounded to a whole second. */
export function autoStepSeconds(startSeconds: number, endSeconds: number, targetPoints = 120): number {
  return Math.max(1, Math.ceil((endSeconds - startSeconds) / targetPoints));
}

export function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}
