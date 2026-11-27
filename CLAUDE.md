# ssp-ming-mcp — local MCP servers (exchange-mongo, victoriametrics, ssp-signoz)

Read the workspace `../CLAUDE.md` first. Working mode: **Peer**.

## What it is

One Node/TypeScript project (`@modelcontextprotocol/sdk`) with three stdio MCP servers. Each server is a
separate process and a separate entry in the workspace root `.mcp.json`. All three point at the local Compose
stack, at EKS or at the local kind cluster, per the target in `~/.ssp-ming-mcp-target` (`src/common/target.ts`). They share `package.json`,
`node_modules` and `src/common/`. See `README.md` for the tools, layout and connection.

| Server | Entry point | Env |
|---|---|---|
| `exchange-mongo` | `src/mongo/server.ts` | Optional overrides `MONGO_URI`, `BIDDERS_MONGO_URI`. eks: credentials from Secrets Manager via the `aws` CLI. kind: from the cluster Secret `secret-source/exchange-mongodb` via `kubectl --context kind-ssp-local` |
| `victoriametrics` | `src/victoriametrics/server.ts` | Optional overrides `VM_URL`, `VMAGENT_URL` |
| `ssp-signoz` | `src/signoz/server.ts` | Optional `SIGNOZ_URL`; key `SIGNOZ_API_KEY` (local) or `SIGNOZ_EKS_API_KEY` (eks) or `SIGNOZ_KIND_API_KEY` (kind), else the Keychain items `ssp-signoz-api-key` / `ssp-signoz-eks-api-key` / `ssp-signoz-kind-api-key`. `.mcp.json` maps them from the shell's `SSP_MING_SIGNOZ_*` |

## Contract of exchange-mongo with the services (do not drift)

| Fact | Value |
|---|---|
| Collections | `supply_partners`, `bidders` in db `ssp-exchange` (`MONGO_URI`); `creatives` in db `ssp-bidders` (`BIDDERS_MONGO_URI`) |
| SupplyPartner fields | `_id`, `entityType` (SOURCE / PUBLISHER), `sourceId` (3 chars, SOURCE only), `publisherId` (PUBLISHER only, unique partial index), `name`, `_class` |
| Bidder fields | `_id`, `name`, `seat`, `endpoint` (path, joined to base-url), `tmaxMs?`, `_class` |
| Creative fields | `_id`, `bidderId`, `crid`, `format` (BANNER / VIDEO), `w`, `h`, `priceCpm`, `adomain[]`, `cat[]`, `adm`, `video{durationSec, mimes[]}` (VIDEO only) |
| Id conventions | seeds use `src-doc-N`, `pub-doc-N`, `bidder-<name>`, `cr-<crid>`; new rows default to `src-<sourceId>`, `pub-<publisherId>`, `bidder-<name>`, `cr-<crid>` |
| `_class` | exchange docs: always written (`com.ming.sspexchange.model.entity.SupplyPartner` / `.Bidder`); creatives: never (the Liquibase seed writes none) |
| Reload | exchange refreshes caches every 30 s; the bidders service reads creatives per bid |

If an entity in `ssp-ming-exchange/.../model/entity/` or `ssp-ming-bidders/.../model/entity/` gains a
field, update `src/mongo/schemas.ts`, the tool in `src/mongo/tools/`, this table and `README.md` together.

## Rules

- stdout is the MCP wire. Log to stderr only.
- `victoriametrics` stays read-only. Do not add tools that call `/api/v1/admin/*`, delete series or import data.
- `ssp-signoz` stays read-only. Do not add tools that create or change dashboards, alerts, channels or service accounts.
- Mongo write tools return `before`/`after`; keep that so changes stay auditable.
- Errors become an `isError` tool result through `guarded()` in `src/common/result.ts`.
- Keep answers small: `maxSeries` and `limit` cap VictoriaMetrics output, `query_range` picks about 120 points.
- Use `/opt/homebrew/bin/node` (prefix `PATH=/opt/homebrew/bin:$PATH` for npm). The Intel `node@24` under `/usr/local` is broken on this machine.
- `.mcp.json` starts the servers with `${SSP_MING_NODE:-node}` (22/11/2026). On this Mac the desktop app finds the Intel x64 `/usr/local/bin/node` first, and x64 Node can't load the arm64 esbuild that tsx needs (`You installed esbuild for another platform`, then `Connection closed`). `~/.zshrc` sets `SSP_MING_NODE=/opt/homebrew/bin/node`; other machines leave it unset.
- Pin dependency versions exactly (`--save-exact`).
- No single-character identifiers; braces on every `if`/`else`/`for`/`while`.
- No credentials in files or chat. Secrets come from Secrets Manager or the Keychain at runtime, and messages show hosts, never credentials.
- `.mcp.json` passes every setting as `${VAR:-}` (blank when unset). Never give it a default there: a default counts as an explicit setting and silently overrides the target.
- The owner manages git. Do not commit.

## Commands

```bash
PATH=/opt/homebrew/bin:$PATH npm test              # 49 tests, no backend needed; pins target local, skips the Keychain
PATH=/opt/homebrew/bin:$PATH npm run typecheck
PATH=/opt/homebrew/bin:$PATH npm run smoke:mongo   # stdio round-trip against both Mongo URIs
PATH=/opt/homebrew/bin:$PATH npm run smoke:victoriametrics
PATH=/opt/homebrew/bin:$PATH npm run smoke:signoz           # needs a key for the current target
./scripts/eks-port-forward.sh                              # EKS: forwards in their own terminal
echo eks > ~/.ssp-ming-mcp-target                          # EKS: then start a new Claude Code session
echo kind > ~/.ssp-ming-mcp-target                         # kind: forwards from ../ssp-ming-k8s-local/scripts/port-forward.sh
```

## Gotchas

- This repo's `.mcp.json` is the master. Claude Code reads only the session folder's own `.mcp.json` and resolves its relative paths against that folder, so `npm run sync-config` (`scripts/sync-mcp-config.ts`) writes the root copy with `ssp-ming-mcp/` and each sibling repo's copy with `../ssp-ming-mcp/`. All paths are relative and every copy is committed (decided 22/11/2026; before, absolute paths and gitignored copies). Never hand-edit a copy.
- A fresh clone needs `npm install` here before any server starts: the commands run `node_modules/tsx`.
- Claude Code reads `.mcp.json` at session start; restart after editing it.
- `upsert_supply_partner` matches on the natural key, not `_id`; `id` is used only on insert.
- `creatives.bidderId` points at the bidders service's own `bidders` collection in `ssp-bidders`, not the exchange's.
- Older local Mongo documents carry a `status` field the exchange ignores; `$set` leaves it in place.
- The server was `prometheus` with `PROMETHEUS_URL` until 16/11/2026. It now targets VictoriaMetrics, whose API is Prometheus-compatible and whose MetricsQL extends PromQL.
- On EKS, queries go to the Service `vmsingle-vm` (port 8428) in namespace `monitoring`, and targets to `vmagent-vm` (port 8429). Both are ClusterIP only, so each needs a port-forward. `vmsingle` does not scrape, so `list_targets` against it finds nothing.
- VictoriaMetrics label endpoints search only about the last day by default. `list_metrics` and `label_values` take `start` for a longer lookback.
- Locally, the Compose VictoriaMetrics single (`:8428`) scrapes both apps on the host through `host.docker.internal`: the exchange on 8080 and bidders on 8081. A target shows `connection refused` while its app is not running.
- The SigNoz server is `ssp-signoz`, not `signoz`: the work SigNoz server is user-scoped as `signoz`, and a project server with the same name would shadow it in these folders.
- SigNoz needs an API key for every query (a service-account key, Settings → Service Accounts), one per SigNoz instance. In eks mode `SIGNOZ_API_KEY` is ignored on purpose: `~/.zshrc` exports the local key everywhere and the EKS SigNoz would reject it. The client refuses redirects, so a key never leaves `SIGNOZ_URL`.
- SigNoz serves its web UI (HTML, HTTP 200) for API routes that do not exist; the client turns that into a "no such API route" error. Real routes answer 401 without a key.
- Units differ per SigNoz endpoint: `query_range` takes milliseconds, `/api/v2/services` and `top_operations` take nanoseconds as strings. Latencies come back in nanoseconds and are converted to milliseconds.
- Row keys of raw span results were not confirmed against v0.150 when the server was written (21/11/2026); `shapeSpan` tries several spellings. If a shaped field is empty, call the tool with `raw: true` and fix the getter.
- On EKS, SigNoz is the Service `signoz` (port 8080) in namespace `signoz`, from `ssp-ming-exchange-terraform/platform/07-signoz.tf`. Its service accounts differ from the local SigNoz, so it needs its own key.
- EKS scripts: `eks-port-forward.sh` pins the kubectl context (`EKS_CONTEXT`, default `*:cluster/eks-dev`) because the current context may be a work cluster; never make it fall back to the current context. Every port lives only in `ports.json` (decided 23/11/2026). Its `local` section mirrors the Compose stack and the host apps. The Compose files stay independent of it (decided 23/11/2026), so a port change there must be copied here by hand. Its `eks` section lists the forwards (namespace, Service, local and remote port), including the Grafana (`vm-grafana`) and Argo CD (`argocd-server`) UIs. Both scripts read the `eks` section with `python3`. `src/common/ports.ts` (`localUrl`, `localHost`, `forwardUrl`, `forwardHost`) gives the servers their defaults for both targets. Never hardcode a port elsewhere. A test fails if two entries share a laptop port. `eks-env.sh` must be sourced, reads the Mongo user and password from Secrets Manager and the EKS SigNoz key from the Keychain item `ssp-signoz-eks-api-key`, and must never print either.
- Target `kind` (added 25/11/2026): the local kind cluster of `ssp-ming-k8s-local`. The target is the one flag that decides the address AND where credentials come from. `kind` reuses the `eks` forwards of `ports.json` (same namespaces and Service names, so only one cluster can be forwarded at a time) and differs only in credentials: Mongo from the cluster Secret `secret-source/exchange-mongodb` (override `SSP_MING_KIND_MONGO_SECRET`, `<namespace>/<name>`) through `kubectl` with the context `kind-ssp-local` (override `SSP_MING_KIND_CONTEXT`; never the current context), SigNoz from the Keychain item `ssp-signoz-kind-api-key`. `runKubectl` tries `kubectl`, `/usr/local/bin/kubectl`, `/opt/homebrew/bin/kubectl` (override `SSP_MING_KUBECTL`). `SIGNOZ_KIND_API_KEY` is not mapped in `.mcp.json`; the Keychain is the supported path. `eks-port-forward.sh` and `eks-env.sh` stay EKS-only.
- Target switch (decided 22/11/2026): `SSP_MING_MCP_TARGET`, else the first word of `~/.ssp-ming-mcp-target` (`local` | `eks` | `kind`), else `local`; an unknown value is an error, never a silent `local`. Chosen over shell variables because the desktop app takes its environment once at launch (from an older `~/.zshrc` read, as seen 22/11/2026), so `source eks-env.sh` and toggles in `~/.zshrc` did not reach it. Resolved once per server process; a new session picks up a change. `runAws` tries `aws`, `/opt/homebrew/bin/aws`, `/usr/local/bin/aws` because the app's `PATH` may lack Homebrew.
