#!/usr/bin/env bash
# Opens every port-forward the MCP servers need to reach the EKS cluster, and reconnects each one when it drops
# (a forward dies when its pod restarts). Run it in its own terminal and leave it running; Ctrl-C closes all.
#
# The forwards come from the "eks" section of ports.json at the project root, the one source of truth that the MCP servers and
# eks-env.sh read too. Add or change a forward there, never here. Its local ports avoid the local Compose stack,
# so both can run at once. Besides the MCP resources it forwards the Grafana and Argo CD UIs.
#
# Then, in the shell that starts Claude Code: source scripts/eks-env.sh
#
# The kubectl context is pinned (EKS_CONTEXT, default: the one ending in :cluster/eks-dev). The current context
# is never used, so a forward can never open against another cluster by accident.
set -euo pipefail

PORTS_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ports.json"
# One line per forward: name namespace svc/<service> local_port remote_port. A while loop, not mapfile,
# because macOS ships bash 3.2.
FORWARDS=()
while IFS= read -r line; do
  FORWARDS+=("${line}")
done < <(python3 -c '
import json, sys
for name, forward in json.load(open(sys.argv[1]))["eks"].items():
    print(name, forward["namespace"], "svc/" + forward["service"], forward["localPort"], forward["remotePort"])
' "${PORTS_FILE}")
if [[ ${#FORWARDS[@]} -eq 0 ]]; then
  echo "No forwards read from ${PORTS_FILE}" >&2
  exit 1
fi
RECONNECT_DELAY_SECONDS=3

context=${EKS_CONTEXT:-$(kubectl config get-contexts -o name | grep ':cluster/eks-dev$' | head -1 || true)}
if [[ -z "${context}" ]]; then
  echo "No kubectl context for eks-dev. Run: aws eks update-kubeconfig --region eu-central-1 --name eks-dev" >&2
  exit 1
fi
echo "Context: ${context}"

if ! kubectl --context "${context}" get namespace production --request-timeout=8s >/dev/null 2>&1; then
  echo "The cluster does not answer. If kubectl says 'no such host', the cluster is destroyed, not broken." >&2
  exit 1
fi

for line in "${FORWARDS[@]}"; do
  read -r name namespace target local_port remote_port <<<"${line}"
  if lsof -nP -iTCP:"${local_port}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${local_port} (${name}) is already in use. Is another eks-port-forward.sh running?" >&2
    exit 1
  fi
done

loop_pids=()

stop_all() {
  trap - EXIT INT TERM
  echo
  echo "Closing the forwards..."
  for pid in "${loop_pids[@]}"; do
    pkill -P "${pid}" 2>/dev/null || true
    kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap stop_all EXIT INT TERM

port_of() {
  local wanted=$1 line name namespace target local_port remote_port
  for line in "${FORWARDS[@]}"; do
    read -r name namespace target local_port remote_port <<<"${line}"
    if [[ "${name}" == "${wanted}" ]]; then
      echo "${local_port}"
      return
    fi
  done
  echo "?"
}

# One reconnect loop per forward. kubectl's own output is prefixed with the forward's name.
forward_loop() {
  local name=$1 namespace=$2 target=$3 local_port=$4 remote_port=$5
  while true; do
    kubectl --context "${context}" -n "${namespace}" port-forward "${target}" "${local_port}:${remote_port}" 2>&1 \
      | sed -u "s/^/[${name}] /" || true
    echo "[${name}] forward ended; reconnecting in ${RECONNECT_DELAY_SECONDS} s"
    sleep "${RECONNECT_DELAY_SECONDS}"
  done
}

for line in "${FORWARDS[@]}"; do
  read -r name namespace target local_port remote_port <<<"${line}"
  forward_loop "${name}" "${namespace}" "${target}" "${local_port}" "${remote_port}" &
  loop_pids+=("$!")
  echo "[${name}] localhost:${local_port} -> ${namespace}/${target}:${remote_port}"
done

echo
echo "Forwards are open. The UIs: Grafana http://localhost:$(port_of grafana), Argo CD http://localhost:$(port_of argocd)"
echo "In the shell that starts Claude Code, run: source scripts/eks-env.sh"
echo "Ctrl-C closes them all."
wait
