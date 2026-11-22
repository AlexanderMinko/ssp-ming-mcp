# scripts

Helper scripts for the MCP servers in this repo. Run every command from the repo root, `ssp-ming-mcp/`.

| Script | Run it when | How |
|---|---|---|
| `sync-mcp-config.ts` | You changed this repo's `.mcp.json`, or created a new sibling repo | `npm run sync-config` |
| `eks-port-forward.sh` | You want the MCP servers to reach EKS | In its own terminal, left running |
| `eks-env.sh` | Right after the forwards are open | `source` it in the shell that starts Claude Code |

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
```

2. In the terminal you start Claude Code from, source the environment, then start Claude Code:

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

3. To stop, press Ctrl-C in the forward terminal. To go back to the local Compose stack, open a new terminal.

### What to know

- **Sourced, not run.** A script cannot change its caller's environment, so `eks-env.sh` must be sourced. Run directly, it stops with a hint.
- **Pinned context.** `eks-port-forward.sh` always uses the kubectl context ending in `:cluster/eks-dev`, never your current one. Set `EKS_CONTEXT` to override it.
- **Reconnects.** A forward drops when its pod restarts. The script reopens it after 3 seconds.
- **No clashes.** The local ports 37017, 18428, 18429 and 13301 differ from the Compose stack, so both can run at once.
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
