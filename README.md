# ssp-ming-mcp

Local MCP servers for the SSP/Exchange workspace. One Node project holds three servers. Each server
runs as its own process with its own `.mcp.json` entry.

| Server | Entry point | Talks to | Tools |
|---|---|---|---|
| `exchange-mongo` | `src/mongo/server.ts` | Mongo (`MONGO_URI`, `BIDDERS_MONGO_URI`) | CRUD on supply partners, bidders, creatives |
| `victoriametrics` | `src/victoriametrics/server.ts` | VictoriaMetrics HTTP API (`VM_URL`, `VMAGENT_URL`) | Read-only MetricsQL, discovery and cardinality |
| `ssp-signoz` | `src/signoz/server.ts` | SigNoz HTTP API, with a service-account key per SigNoz instance | Read-only logs, traces, services and aggregations |

Claude Code shows the tools as `mcp__<server>__<tool>`.

## Layout

| Path | Holds |
|---|---|
| `package.json` | Dependencies and scripts for all servers |
| `src/common/result.ts` | `jsonResult()` and `guarded()`, shared by all servers |
| `src/common/time.ts` | Time and duration parsing (`now-1h`, RFC 3339, `5m`), shared by all servers |
| `src/mongo/server.ts` | `buildServer()` and the stdio entry point of `exchange-mongo` |
| `src/mongo/mongo.ts` | Lazy MongoClients, one per source (`exchange` from `MONGO_URI`, `bidders` from `BIDDERS_MONGO_URI`) |
| `src/mongo/schemas.ts` | zod schemas, id conventions, Spring `_class` values |
| `src/mongo/tools/*.ts` | One file per collection (`supplyPartners`, `bidders`, `creatives`) |
| `src/victoriametrics/server.ts` | `buildServer()` and the stdio entry point of `victoriametrics` |
| `src/victoriametrics/victoriametrics.ts` | HTTP client for vmsingle and vmagent |
| `src/victoriametrics/tools/*.ts` | `queries` (query, query_range) and `discovery` (metrics, labels, targets, cardinality) |
| `src/signoz/server.ts` | `buildServer()` and the stdio entry point of `ssp-signoz` |
| `src/signoz/signoz.ts` | HTTP client with the API key, the v5 query builder, row shaping and the trace waterfall |
| `src/signoz/tools/*.ts` | `logs` (search_logs), `traces` (search_traces, get_trace, services, operations) and `explore` (aggregate, fields, connection check) |
| `test/<server>/*.test.ts` | node:test suites, no backend needed |
| `test/<server>/smoke.ts` | Manual stdio round-trip against the real backend |

## Tools of `exchange-mongo`

| Tool | Collection | Effect |
|---|---|---|
| `list_supply_partners` | supply_partners | find, optional filter by entityType / sourceId / publisherId |
| `upsert_supply_partner` | supply_partners | insert or update by natural key (SOURCE: sourceId, PUBLISHER: publisherId) |
| `delete_supply_partner` | supply_partners | delete by natural key, returns the deleted document |
| `list_bidders` | bidders | find all |
| `upsert_bidder` | bidders | insert or replace by `_id` (defaults to `bidder-<name>`) |
| `delete_bidder` | bidders | delete by `_id`, returns the deleted document |
| `list_creatives` | creatives (ssp-bidders) | find, optional filter by bidderId / format |
| `upsert_creative` | creatives (ssp-bidders) | insert or replace by `_id` (defaults to `cr-<crid>`); VIDEO needs a video spec |
| `delete_creative` | creatives (ssp-bidders) | delete by `_id`, returns the deleted document |

Write tools return `before` and `after`, so an accidental change is visible and reversible. The exchange
reloads its caches every 30 s. The bidders service reads creatives on every bid.

## Tools of `victoriametrics`

All six tools are read-only. VictoriaMetrics serves a Prometheus-compatible API, and its query
language MetricsQL extends PromQL.

| Tool | API path | Answered by | Use |
|---|---|---|---|
| `query` | `/api/v1/query` | vmsingle (`VM_URL`) | Current value of a MetricsQL expression |
| `query_range` | `/api/v1/query_range` | vmsingle (`VM_URL`) | A trend over a window; the default is the last hour at about 120 points |
| `list_metrics` | `/api/v1/label/__name__/values` | vmsingle (`VM_URL`) | Find a metric name by substring or series selector |
| `label_values` | `/api/v1/label/<name>/values` | vmsingle (`VM_URL`) | Values of one label, for example `job` or `pod` |
| `list_targets` | `/api/v1/targets` | vmagent (`VMAGENT_URL`) | Scrape targets, their health and last error |
| `tsdb_status` | `/api/v1/status/tsdb` | vmsingle (`VM_URL`) | Series count and the metrics and labels that create the most series |

Times accept `now`, `now-1h`, unix seconds or RFC 3339. A timestamp without an offset is read as UTC.
`list_metrics` and `label_values` search only about the last day unless you pass `start`, such as `now-7d`.

### Settings of `victoriametrics`

On EKS, two VictoriaMetrics components split the work. `vmsingle` stores data and answers queries.
`vmagent` scrapes the apps, so only it knows the target list. The server has one setting for each:

| Variable | Used for | Default |
|---|---|---|
| `VM_URL` | `query`, `query_range`, `list_metrics`, `label_values`, `tsdb_status` | `http://localhost:8428`, the local Compose VictoriaMetrics |
| `VMAGENT_URL` | `list_targets` | Empty, which falls back to `VM_URL` |

Locally, one VictoriaMetrics process both scrapes and stores, so you set neither variable.

### Notes on `victoriametrics`

- `tsdb_status` finds a cardinality explosion, such as a label that carries a request id.
- MetricsQL is the VictoriaMetrics query language. It extends PromQL, so PromQL queries work almost unchanged.
- Until 16/11/2026 this server was `prometheus`, configured with `PROMETHEUS_URL`. Its tools were `mcp__prometheus__<tool>` and are now `mcp__victoriametrics__<tool>`.

## Tools of `ssp-signoz`

All nine tools are read-only. They call the API of a self-hosted SigNoz. The server is named `ssp-signoz`,
not `signoz`, because the work SigNoz server is registered as `signoz` for the whole account. A project
server with the same name would replace it in these folders.

| Tool | API | Use |
|---|---|---|
| `search_logs` | `POST /api/v5/query_range` | Log lines, newest first, by service, severity, body text, trace id or filter |
| `search_traces` | `POST /api/v5/query_range` | Spans by service, span name, errors, minimum duration or filter; newest or slowest first |
| `get_trace` | `POST /api/v5/query_range` | Every span of one trace as a waterfall, with depth, start offset and duration |
| `list_services` | `POST /api/v2/services` | Services with request rate, error rate and p99 and average latency |
| `top_operations` | `POST /api/v2/service/top_operations` | One service's operations with calls, errors and p50, p95 and p99 latency |
| `aggregate` | `POST /api/v5/query_range` | One number per group, such as error logs per service or p99 duration per operation |
| `list_fields` | `GET /api/v1/fields/keys` | Field names that logs or spans carry |
| `field_values` | `GET /api/v1/fields/values` | Values of one field, such as `service.name` |
| `check_connection` | `GET /api/v1/version`, `GET /api/v1/service_accounts/me` | SigNoz version and whether the API key works |

The search tools accept a `filter` in SigNoz filter syntax, ANDed with the other arguments, for example
`http.route = '/openrtb2/auction'` or `body CONTAINS 'timeout'`. Latencies are converted to milliseconds.
Each search tool also takes `raw: true`, which returns SigNoz's unshaped rows. Use it if a shaped field comes back empty.

### Settings of `ssp-signoz`

Unlike the other backends, SigNoz requires an API key for every query. Each SigNoz instance has its own service
accounts, so the local key and the EKS key differ. The server picks the URL and key that match the target:

| Target | URL | Key, first match wins |
|---|---|---|
| `local` | `http://localhost:3301` | Shell variable `SSP_MING_SIGNOZ_API_KEY`, else Keychain item `ssp-signoz-api-key` |
| `eks` | `http://localhost:13301` | Shell variable `SSP_MING_SIGNOZ_EKS_API_KEY`, else Keychain item `ssp-signoz-eks-api-key` |

A non-empty `SSP_MING_SIGNOZ_URL` overrides the URL for either target. In `eks` mode the local key is ignored on purpose,
because the EKS SigNoz would reject it.

To create a key, open that SigNoz's UI as an admin and go to Settings → Service Accounts → New Service Account.
Give the account a viewer role, then open its Keys tab and add a key. SigNoz shows the key only once.
Store it in the Keychain. The command prompts for the key, so it never lands in a file or your shell history:

```bash
security add-generic-password -U -a "$USER" -s ssp-signoz-api-key -w
```

Use `ssp-signoz-eks-api-key` for the EKS key. Then ask Claude to run `check_connection`. It reports the target,
where the key came from, and `keyValid: true`.

## Install and verify

Node 22+ must run from `/opt/homebrew/bin/node`. The Intel `node@24` under `/usr/local` is broken on this machine.

`.mcp.json` starts each server with `${SSP_MING_NODE:-node}`. Set `SSP_MING_NODE` when plain `node` may resolve to a
Node built for another CPU than the one `npm install` ran on. On this Mac the desktop app finds the Intel x64 Node first,
which can't load the arm64 esbuild. The servers then exit at once with `Connection closed`. Set this in `~/.zshrc`:

```bash
export SSP_MING_NODE=/opt/homebrew/bin/node
```

```bash
PATH=/opt/homebrew/bin:$PATH npm install
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run typecheck
```

```bash
PATH=/opt/homebrew/bin:$PATH npm test
```

Expected: 45 passing tests, with no backend needed. The SigNoz tests start a small fake SigNoz. The test script pins
the target to `local` and skips the Keychain, so your own target file and keys can't change the results.

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:mongo
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:victoriametrics
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:signoz
```

The SigNoz smoke test needs a key for the current target. Without one, it shows only the version and the missing-key message.

Expected: each server starts over stdio and prints the result of every tool it calls.

## Registration in Claude Code

`.mcp.json` registers the servers at project scope, so nothing is written to `~/.claude.json`.
Claude Code reads only the `.mcp.json` in the folder where a session starts, and resolves relative
paths in it against that folder. Every path in every copy is therefore relative, and every copy is committed.

| Folder | Paths in its `.mcp.json` | Written by |
|---|---|---|
| `ssp-ming-mcp/` | `src/...`, `node_modules/...` | You. This file is the master |
| The workspace root | `ssp-ming-mcp/src/...` | `npm run sync-config` |
| Each sibling repo | `../ssp-ming-mcp/src/...` | `npm run sync-config` |

After you edit the master, run this from `ssp-ming-mcp` to rewrite the root and sibling copies:

```bash
PATH=/opt/homebrew/bin:$PATH npm run sync-config
```

It prints one line per copy, marked `written` or `unchanged`. The script includes every sibling folder
that has a `.git` folder, a `.claude` folder or a `.mcp.json`.

**After a fresh clone.** Clone the repos side by side in one folder, then install the dependencies once.
The servers start from `node_modules`, which is not committed:

```bash
cd ssp-ming-mcp && npm install
```

Each `.claude/settings.json` pre-approves the servers with `enabledMcpjsonServers`. Verify with `/mcp`
inside a session, or run this:

```bash
claude mcp list
```

Claude Code reads `.mcp.json` only at session start. Restart open sessions after you add, rename or
move a server, or their tools keep the old names and paths.

## Pointing at EKS

The servers always run on your laptop. One file decides whether they talk to the local Compose stack or to EKS:

```bash
echo eks > ~/.ssp-ming-mcp-target
```

Write `local` to switch back, or delete the file, which also means `local`. The setting works the same in the terminal
and the desktop app. Each server reads the file when it starts, so the change applies to the next Claude Code session.
The app needs no restart.

| Target | VictoriaMetrics | Mongo | SigNoz |
|---|---|---|---|
| `local` | `:8428`, which also lists the targets | `:27017`, no credentials | `:3301` with the local key |
| `eks` | vmsingle `:18428`, vmagent `:18429` | `:37017`, user and password from Secrets Manager | `:13301` with the EKS key |

The target is resolved in this order, and the first match wins:
1. The variable `SSP_MING_MCP_TARGET`, set to `local` or `eks`.
2. The first word of `~/.ssp-ming-mcp-target`. Set `SSP_MING_MCP_TARGET_FILE` to use another path.
3. `local`.

An unknown value, such as `prod`, is an error in every tool call. It never quietly falls back to `local`.
Explicit settings still win over the target. A non-empty `VM_URL`, `VMAGENT_URL`, `MONGO_URI`, `BIDDERS_MONGO_URI` or
`SSP_MING_SIGNOZ_URL` is used as given.

**Check the target.** Each server logs its target and its addresses when it starts. Every connection error names the
target, and `check_connection` on `ssp-signoz` reports it, together with where the key came from.

**Open the forwards for EKS.** The `eks` target expects the forwards from [`scripts/eks-port-forward.sh`](scripts/README.md).
Run it in its own terminal and leave it running:

```bash
./scripts/eks-port-forward.sh
```

The forwards come from the `eks` section of [`ports.json`](ports.json). That file is the one source of truth for every port, and its `local` section holds the Compose ports.
Their local ports don't clash with the local Compose stack, so both can run at the same time:

| Forward | Local port | Cluster target | Local Compose port |
|---|---|---|---|
| Mongo | 37017 | `production/svc/mongodb:27017` | 27017, and 27018 for the bidders' own Mongo |
| vmsingle | 18428 | `monitoring/svc/vmsingle-vm:8428` | 8428 |
| vmagent | 18429 | `monitoring/svc/vmagent-vm:8429` | none |
| SigNoz | 13301 | `signoz/svc/signoz:8080` | 3301 |
| Grafana UI | 13000 | `monitoring/svc/vm-grafana:80` | 3000 |
| Argo CD UI | 18080 | `argocd/svc/argocd-server:80` | none |

**Safety.** The forward script pins the kubectl context, by default the one ending in `:cluster/eks-dev`. It never uses
your current context, which may point at another cluster. Set `EKS_CONTEXT` to override it.

**Mongo credentials.** In `eks` mode the Mongo server reads `eks-dev/exchange/mongodb` from Secrets Manager through the
AWS CLI, the same secret ESO gives the apps. It tries `aws` on the `PATH`, then the usual Homebrew paths, because the
desktop app's `PATH` may lack Homebrew. Set `SSP_MING_AWS` to point at another binary. Errors show the host, never the
credentials.

**The EKS SigNoz key.** Store it once in the Keychain item `ssp-signoz-eks-api-key`, as in "Settings of `ssp-signoz`".
The cluster is often destroyed, and its SigNoz loses the service account with it. After a rebuild, create a new key
and store it again with the same command. The `-U` flag replaces the old entry.

**`scripts/eks-env.sh` is optional now.** It still exports the EKS addresses into one shell, which helps tools such as
`mongosh` in a terminal. Claude Code no longer needs it.

## Adding a server

1. Create `src/<name>/server.ts` with a `buildServer()` and a stdio entry point, modelled on `src/victoriametrics/server.ts`.
2. Put its tools in `src/<name>/tools/` and reuse `src/common/result.ts`.
3. Add `test/<name>/server.test.ts` and, if useful, `test/<name>/smoke.ts` with a `smoke:<name>` script.
4. Add an entry to this repo's `.mcp.json` that runs `src/<name>/server.ts`, then run `npm run sync-config`.
5. Add the server name to every `.claude/settings.json`, and restart Claude Code.
