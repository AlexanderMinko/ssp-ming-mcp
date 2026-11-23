# scripts

Helper scripts for the MCP servers in this repo. Run every command from the repo root, `ssp-ming-mcp/`.

| Script | Run it when | How |
|---|---|---|
| `sync-mcp-config.ts` | You changed this repo's `.mcp.json`, or created a new sibling repo | `npm run sync-config` |
| `eks-port-forward.sh` | You want the MCP servers to reach EKS | In its own terminal, left running |
| `eks-env.sh` | Optional: you want EKS addresses in one terminal, for example for `mongosh` | `source` it in that terminal |

## Sync the MCP registration

Claude Code reads `.mcp.json` only from the folder where a session starts. This repo's `.mcp.json` is the master.
The script copies it into the workspace root and every sibling repo, with the relative path each folder needs.

```bash
PATH=/opt/homebrew/bin:$PATH npm run sync-config
```

Expected output: one line per copy, marked `written` or `unchanged`.

```
unchanged /Users/minko/Java-workspace/learning/AWS_EKS/.mcp.json
written   /Users/minko/Java-workspace/learning/AWS_EKS/ssp-ming-exchange/.mcp.json
```

Never edit a copy by hand. The next sync overwrites it.

## Point the servers at EKS

The servers always run on your laptop. These two scripts replace the manual port-forwards and exports.

1. Open the forwards in one terminal, and leave it running:

```bash
./scripts/eks-port-forward.sh
```

Expected output: the context, then one line per forward.

```
Context: arn:aws:eks:eu-central-1:<account>:cluster/eks-dev
[mongo] localhost:37017 -> production/svc/mongodb:27017
[vmsingle] localhost:18428 -> monitoring/svc/vmsingle-vm:8428
[vmagent] localhost:18429 -> monitoring/svc/vmagent-vm:8429
[signoz] localhost:13301 -> signoz/svc/signoz:8080
[grafana] localhost:13000 -> monitoring/svc/vm-grafana:80
[argocd] localhost:18080 -> argocd/svc/argocd-server:80

Forwards are open. The UIs: Grafana http://localhost:13000, Argo CD http://localhost:18080
```

2. Switch the MCP servers to EKS, then start a new Claude Code session, in the terminal or the desktop app:

```bash
echo eks > ~/.ssp-ming-mcp-target
```

Ask Claude to run `check_connection`. It should report `"target": "eks"` and `keyValid: true`.
To switch back, write `local` into the same file.

3. Optional: to use the EKS addresses in a terminal tool, such as `mongosh`, source the environment there:

```bash
source scripts/eks-env.sh
```

Expected output: one line per server.

```
MCP servers now point at EKS (restart Claude Code from this shell):
  victoriametrics  http://localhost:18428 (targets: http://localhost:18429)
  exchange-mongo   localhost:37017 with credentials from eks-dev/exchange/mongodb
  ssp-signoz       http://localhost:13301 (EKS key from the Keychain)
```

4. To stop, press Ctrl-C in the forward terminal.

### What to know

- **Target file, not variables.** Claude Code reads the target from `~/.ssp-ming-mcp-target` in every new session. The desktop app takes its environment once, at launch, so shell variables are an unreliable switch.
- **Sourced, not run.** A script cannot change its caller's environment, so `eks-env.sh` must be sourced. Run directly, it stops with a hint.
- **Pinned context.** `eks-port-forward.sh` always uses the kubectl context ending in `:cluster/eks-dev`, never your current one. Set `EKS_CONTEXT` to override it.
- **Reconnects.** A forward drops when its pod restarts. The script reopens it after 3 seconds.
- **One source of truth.** Every port lives in [`ports.json`](../ports.json) at the repo root. Its `eks` section holds the forwards: `eks-port-forward.sh` opens them, `eks-env.sh` exports their URLs, and the servers use them as their `eks` defaults. Its `local` section copies the Compose ports, which the servers use as their `local` defaults. The Compose files don't read it, so change a port in both places. To add or change a port, edit only that file.
- **No clashes.** The local ports differ from the Compose stack, so both can run at once. A test fails if two entries in `ports.json` share a laptop port.
- **The UIs.** The script also forwards Grafana (`vm-grafana`) and the Argo CD server. Argo CD's `admin` password is in the Secret `argocd-initial-admin-secret` in namespace `argocd`. Grafana's is in the Secret `vm-grafana` in namespace `monitoring`.
- **Cluster down.** If the forward script says the cluster doesn't answer and kubectl reports `no such host`, the cluster is destroyed, not broken.
- **Secrets.** `eks-env.sh` reads the Mongo user and password from Secrets Manager (`eks-dev/exchange/mongodb`) and prints neither.

### The EKS SigNoz key

The EKS SigNoz has its own service accounts, so the local key doesn't work there. Create a key in the EKS SigNoz
under Settings → Service Accounts, then store it in the Keychain. The command prompts for the key, so it never
lands in your shell history:

```bash
security add-generic-password -U -a "$USER" -s ssp-signoz-eks-api-key -w
```

The cluster is often destroyed, and its SigNoz loses the service account with it. After each rebuild, create a new
key and run the command again.
