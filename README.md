# ssp-ming-mcp

Local MCP servers for the SSP/Exchange workspace. One Node project holds three servers. Each server
runs as its own process with its own `.mcp.json` entry.

| Server | Entry point | Talks to | Tools |
|---|---|---|---|
| `exchange-mongo` | `src/mongo/server.ts` | Mongo (`MONGO_URI`, `BIDDERS_MONGO_URI`) | CRUD on supply partners, bidders, creatives |
| `victoriametrics` | `src/victoriametrics/server.ts` | VictoriaMetrics HTTP API (`VM_URL`, `VMAGENT_URL`) | Read-only MetricsQL, discovery and cardinality |
| `ssp-signoz` | `src/signoz/server.ts` | SigNoz HTTP API (`SSP_MING_SIGNOZ_URL`, `SSP_MING_SIGNOZ_API_KEY`) | Read-only logs, traces, services and aggregations |

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

Unlike the other backends, SigNoz requires an API key for every query. The `.mcp.json` entry maps two
shell variables onto the names the server reads, so a key exported for another SigNoz is never sent here.

| Shell variable | Server reads | Default |
|---|---|---|
| `SSP_MING_SIGNOZ_URL` | `SIGNOZ_URL` | `http://localhost:3301`, the local Compose SigNoz |
| `SSP_MING_SIGNOZ_API_KEY` | `SIGNOZ_API_KEY` | Empty, which makes every query stop with a message that says how to set it |

To create a key, open the SigNoz UI as an admin and go to Settings → Service Accounts → New Service Account.
Give the account a viewer role, then open its Keys tab and add a key. SigNoz shows the key only once.
Export it in the shell you start Claude Code from, and never put it into `.mcp.json` or a chat:

```bash
export SSP_MING_SIGNOZ_API_KEY='<the key>'
```

Then ask Claude to run `check_connection`. It should report `keyValid: true`.

## Install and verify

Node 22+ must run from `/opt/homebrew/bin/node`. The Intel `node@24` under `/usr/local` is broken on this machine.

```bash
PATH=/opt/homebrew/bin:$PATH npm install
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run typecheck
```

```bash
PATH=/opt/homebrew/bin:$PATH npm test
```

Expected: 33 passing tests, with no backend needed. The SigNoz tests start a small fake SigNoz.

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:mongo
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:victoriametrics
```

```bash
PATH=/opt/homebrew/bin:$PATH npm run smoke:signoz
```

The SigNoz smoke test needs `SSP_MING_SIGNOZ_API_KEY` in the shell. Without it, it shows only the version and the missing-key message.

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

The servers always run on your laptop. To point them at EKS, two scripts replace the manual port-forwards and exports.
[`scripts/README.md`](scripts/README.md) is the short how-to for every script.

| Script | How you run it | What it does |
|---|---|---|
| `scripts/eks-port-forward.sh` | In its own terminal, left running | Opens the four forwards and reconnects each one when it drops. Ctrl-C closes them all |
| `scripts/eks-env.sh` | `source` it in the shell that starts Claude Code | Exports the EKS URLs, builds `MONGO_URI` and `BIDDERS_MONGO_URI` from Secrets Manager, and sets the EKS SigNoz key |

1. In one terminal, open the forwards:

```bash
./scripts/eks-port-forward.sh
```

2. In the terminal you start Claude Code from, point the servers at EKS, then start Claude Code there:

```bash
source scripts/eks-env.sh
```

It prints one line per server. A script cannot change its caller's environment, which is why this one is sourced.
To go back to the local Compose stack, open a new terminal.

The forwards use local ports that don't clash with the local Compose stack, so both can run at the same time:

| Forward | Local port | Cluster target | Local Compose port |
|---|---|---|---|
| Mongo | 37017 | `production/svc/mongodb:27017` | 27017, and 27018 for the bidders' own Mongo |
| vmsingle | 18428 | `monitoring/svc/vmsingle-vm:8428` | 8428 |
| vmagent | 18429 | `monitoring/svc/vmagent-vm:8429` | none |
| SigNoz | 13301 | `signoz/svc/signoz:8080` | 3301 |

**Safety.** The forward script pins the kubectl context, by default the one ending in `:cluster/eks-dev`. It never uses
your current context, which may point at another cluster. Set `EKS_CONTEXT` to override it.

**Mongo credentials.** `eks-env.sh` reads `eks-dev/exchange/mongodb` from Secrets Manager, the same secret ESO gives the
apps. It URL-encodes the user and password and prints neither.

**The EKS SigNoz key.** The EKS SigNoz has its own service accounts, so the local key doesn't work there. Create a key
in the EKS SigNoz the same way as locally, then store it in the Keychain once:

```bash
security add-generic-password -U -a "$USER" -s ssp-signoz-eks-api-key -w
```

The cluster is often destroyed, and its SigNoz loses the service account with it. After a rebuild, create a new key
and run the same command again.

## Adding a server

1. Create `src/<name>/server.ts` with a `buildServer()` and a stdio entry point, modelled on `src/victoriametrics/server.ts`.
2. Put its tools in `src/<name>/tools/` and reuse `src/common/result.ts`.
3. Add `test/<name>/server.test.ts` and, if useful, `test/<name>/smoke.ts` with a `smoke:<name>` script.
4. Add an entry to this repo's `.mcp.json` that runs `src/<name>/server.ts`, then run `npm run sync-config`.
5. Add the server name to every `.claude/settings.json`, and restart Claude Code.
