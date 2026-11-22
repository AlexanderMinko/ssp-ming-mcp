/**
 * Writes .mcp.json into the workspace root and every sibling repo, from this repo's .mcp.json (the master).
 *
 * Claude Code reads only the .mcp.json in the folder a session starts in, and resolves relative paths in it
 * against that folder. The master uses paths relative to this repo (src/..., node_modules/...); each copy gets
 * the prefix that leads from its folder back here:
 *   workspace root (AWS_EKS/)        ssp-ming-mcp/src/...
 *   a sibling repo (AWS_EKS/<repo>/) ../ssp-ming-mcp/src/...
 *
 * Every path is relative, so all copies work in any clone that keeps the repos side by side.
 * Run from this repo: npm run sync-config
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ServerEntry {
  args?: string[];
  [key: string]: unknown;
}

interface McpConfig {
  mcpServers: Record<string, ServerEntry>;
}

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoName = basename(repoDir);
const workspaceDir = dirname(repoDir);
const master = JSON.parse(readFileSync(join(repoDir, ".mcp.json"), "utf8")) as McpConfig;

/** Prefixes every argument that is a path inside this repo. Flags and absolute paths stay as they are. */
function withPrefix(config: McpConfig, prefix: string): McpConfig {
  const servers: Record<string, ServerEntry> = {};
  for (const [name, entry] of Object.entries(config.mcpServers)) {
    const args = (entry.args ?? []).map((arg) => (arg.startsWith("src/") || arg.startsWith("node_modules/") ? `${prefix}${arg}` : arg));
    servers[name] = { ...entry, args };
  }
  return { mcpServers: servers };
}

/** Sibling folders that take part: a git repo, a folder with Claude Code settings, or one that already has a .mcp.json. */
function siblingRepos(): string[] {
  return readdirSync(workspaceDir)
    .filter((name) => name !== repoName && !name.startsWith("."))
    .map((name) => join(workspaceDir, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => [".git", ".claude", ".mcp.json"].some((marker) => existsSync(join(path, marker))));
}

function write(folder: string, config: McpConfig): void {
  const target = join(folder, ".mcp.json");
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  writeFileSync(target, text);
  console.log(`${previous === text ? "unchanged" : "written  "} ${target}`);
}

write(workspaceDir, withPrefix(master, `${repoName}/`));
for (const sibling of siblingRepos()) {
  write(sibling, withPrefix(master, `../${repoName}/`));
}
