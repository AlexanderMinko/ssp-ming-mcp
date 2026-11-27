/**
 * Which backends the servers talk to. One flag decides both the ADDRESS and WHERE THE CREDENTIALS COME FROM:
 *
 *   local  the Compose stack on the laptop                  no Mongo credentials; SigNoz key from the Keychain
 *   eks    the EKS cluster through port-forwards            Mongo from AWS Secrets Manager; its own SigNoz key
 *   kind   the local kind cluster (ssp-ming-k8s-local)      Mongo from a Secret in the cluster (kubectl); its own SigNoz key
 *          through the SAME forwards as eks
 *
 * eks and kind share the forwards of ports.json `eks`: both clusters use the same namespaces and Service names,
 * so only one of them can be forwarded at a time. See isCluster().
 *
 * Resolution, first match wins:
 *   1. SSP_MING_MCP_TARGET           env, one of the targets
 *   2. ~/.ssp-ming-mcp-target        file holding one of the targets (path override: SSP_MING_MCP_TARGET_FILE)
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

export type Target = "local" | "eks" | "kind";

export interface TargetChoice {
  target: Target;
  /** Where the choice came from, for startup logs and error messages. */
  source: string;
}

const TARGETS: readonly Target[] = ["local", "eks", "kind"];

export function targetFile(): string {
  return process.env.SSP_MING_MCP_TARGET_FILE ?? join(homedir(), ".ssp-ming-mcp-target");
}

function parseTarget(raw: string, source: string): Target {
  const word = raw.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!(TARGETS as readonly string[]).includes(word)) {
    throw new Error(`${source} says "${raw.trim()}", but the target must be one of: ${TARGETS.join(", ")}.`);
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

/** True for the targets reached through port-forwards (ports.json `eks`): eks and kind. */
export function isCluster(target: Target): boolean {
  return target !== "local";
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

/** kubectl context of the kind cluster. Always named explicitly: the current context may be EKS or a work cluster. */
export const KIND_CONTEXT = (): string => explicitSetting("SSP_MING_KIND_CONTEXT") ?? "kind-ssp-local";

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
 * Runs a CLI tool. The desktop app's PATH may lack Homebrew and /usr/local, so the usual install paths are tried
 * after the bare name. `overrideEnv` names the binary explicitly.
 */
async function runTool(label: string, overrideEnv: string, candidates: string[], args: string[]): Promise<string> {
  const binaries = [explicitSetting(overrideEnv), ...candidates].filter((candidate): candidate is string => candidate !== undefined);
  let lastError: unknown;
  for (const binary of binaries) {
    try {
      return await run(binary, args);
    } catch (error: unknown) {
      lastError = error;
      if (!(error instanceof Error) || !error.message.endsWith("not found")) {
        throw error;
      }
    }
  }
  throw new Error(`${label} was not found (tried ${binaries.join(", ")}). Set ${overrideEnv} to its path.`, { cause: lastError });
}

/** Runs the AWS CLI. SSP_MING_AWS names the binary explicitly. */
export function runAws(args: string[]): Promise<string> {
  return runTool("The AWS CLI", "SSP_MING_AWS", ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws"], args);
}

/** Runs kubectl. SSP_MING_KUBECTL names the binary explicitly. The caller passes --context. */
export function runKubectl(args: string[]): Promise<string> {
  return runTool("kubectl", "SSP_MING_KUBECTL", ["kubectl", "/usr/local/bin/kubectl", "/opt/homebrew/bin/kubectl"], args);
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
