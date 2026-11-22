#!/usr/bin/env bash
# Opens every port-forward the MCP servers need to reach the EKS cluster, and reconnects each one when it drops
# (a forward dies when its pod restarts). Run it in its own terminal and leave it running; Ctrl-C closes all.
#
# Local ports avoid the local Compose stack, so both can run at once:
#   mongo     production/svc/mongodb       37017 -> 27017   (local Compose Mongo: 27017, bidders' own: 27018)
#   vmsingle  monitoring/svc/vmsingle-vm   18428 -> 8428    (local VictoriaMetrics: 8428)
#   vmagent   monitoring/svc/vmagent-vm    18429 -> 8429
#   signoz    signoz/svc/signoz            13301 -> 8080    (local SigNoz: 3301)
#
# Then, in the shell that starts Claude Code: source scripts/eks-env.sh
#
# The kubectl context is pinned (EKS_CONTEXT, default: the one ending in :cluster/eks-dev). The current context
# is never used, so a forward can never open against another cluster by accident.
set -euo pipefail

FORWARDS=(
  "mongo     production  svc/mongodb      37017  27017"
  "vmsingle  monitoring  svc/vmsingle-vm  18428  8428"
  "vmagent   monitoring  svc/vmagent-vm   18429  8429"
  "signoz    signoz      svc/signoz       13301  8080"
)
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
echo "Forwards are open. In the shell that starts Claude Code, run: source scripts/eks-env.sh"
echo "Ctrl-C closes them all."
wait
