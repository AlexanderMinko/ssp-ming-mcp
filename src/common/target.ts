/**
 * Which backends the servers talk to: the local Compose stack or EKS through scripts/eks-port-forward.sh.
 *
 * Resolution, first match wins:
 *   1. SSP_MING_MCP_TARGET           env, "local" or "eks"
 *   2. ~/.ssp-ming-mcp-target        file holding "local" or "eks" (path override: SSP_MING_MCP_TARGET_FILE)
 *   3. "local"
 *
 * A file instead of an env var because the Claude desktop app takes its environment once, at launch, and does not
 * reliably see shell changes. Every server process reads the file when it starts, so a new session picks up a change.
 *
 * Explicit settings still win over the target: a non-empty VM_URL, MONGO_URI, SIGNOZ_URL, ... is used as given.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Target = "local" | "eks";

export interface TargetChoice {
  target: Target;
  /** Where the choice came from, for startup logs and error messages. */
  source: string;
}

const TARGETS: readonly Target[] = ["local", "eks"];

export function targetFile(): string {
  return process.env.SSP_MING_MCP_TARGET_FILE ?? join(homedir(), ".ssp-ming-mcp-target");
}

function parseTarget(raw: string, source: string): Target {
  const word = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!(TARGETS as readonly string[]).includes(word)) {
    throw new Error(`${source} says "${raw.trim()}", but the target must be "local" or "eks".`);
  }
  return word as Target;
}

let cached: TargetChoice | undefined;

/** Resolves the target once per process. Throws on an unknown value, so a typo never silently means "local". */
export function currentTarget(): TargetChoice {
  if (cached !== undefined) {
    return cached;
  }
  const fromEnv = explicitSetting("SSP_MING_MCP_TARGET");
  if (fromEnv !== undefined) {
    cached = { target: parseTarget(fromEnv, "SSP_MING_MCP_TARGET"), source: "env SSP_MING_MCP_TARGET" };
    return cached;
  }
  const file = targetFile();
  if (existsSync(file)) {
    cached = { target: parseTarget(readFileSync(file, "utf8"), file), source: `file ${file}` };
    return cached;
  }
  cached = { target: "local", source: `default (no ${file})` };
  return cached;
}

/** For tests: forget the resolved target so the next call reads env and file again. */
export function resetTargetCache(): void {
  cached = undefined;
}

export function describeTarget(): string {
  const choice = currentTarget();
  return `target ${choice.target} from ${choice.source}`;
}

/** A setting the user gave explicitly: set and not blank. .mcp.json passes unset shell variables as "". */
export function explicitSetting(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

export const EKS_REGION = (): string => explicitSetting("SSP_MING_EKS_REGION") ?? "eu-central-1";

const COMMAND_TIMEOUT_MS = 15_000;

/** Runs a command without a shell and returns its trimmed stdout. Never logs the output: it may be a secret. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const detail = (error as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : stderr.trim() || error.message;
        reject(new Error(`${file}: ${detail}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/**
 * Runs the AWS CLI. The desktop app's PATH may lack Homebrew, so the usual install paths are tried after "aws".
 * SSP_MING_AWS names the binary explicitly.
 */
export async function runAws(args: string[]): Promise<string> {
  const candidates = [explicitSetting("SSP_MING_AWS"), "aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await run(candidate, args);
    } catch (error: unknown) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.endsWith("not found")) {
        throw error;
      }
    }
  }
  throw new Error(`The AWS CLI was not found (tried ${candidates.join(", ")}). Set SSP_MING_AWS to its path.`, {
    cause: lastError,
  });
}

/**
 * Reads a generic password from the macOS Keychain (security find-generic-password -a $USER -s <service> -w).
 * Returns undefined when the item does not exist. SSP_MING_NO_KEYCHAIN=1 turns lookups off (tests).
 */
export async function readKeychain(service: string): Promise<string | undefined> {
  if (explicitSetting("SSP_MING_NO_KEYCHAIN") === "1" || process.platform !== "darwin") {
    return undefined;
  }
  try {
    const value = await run("/usr/bin/security", ["find-generic-password", "-a", process.env.USER ?? "", "-s", service, "-w"]);
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}
