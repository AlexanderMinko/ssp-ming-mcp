# Points the MCP servers at EKS. SOURCE it (do not run it) in the shell you start Claude Code from:
#   source scripts/eks-env.sh
# It needs scripts/eks-port-forward.sh running in another terminal. To go back to the local Compose stack,
# open a new terminal: nothing here is written to a file.
#
# What it sets:
#   VM_URL, VMAGENT_URL              the forwarded vmsingle and vmagent
#   MONGO_URI, BIDDERS_MONGO_URI     the forwarded Mongo, with the user and password read from Secrets Manager
#                                    (eks-dev/exchange/mongodb, the same secret ESO gives the apps)
#   SSP_MING_SIGNOZ_URL              the forwarded SigNoz
#   SSP_MING_SIGNOZ_API_KEY          the EKS SigNoz key from the macOS Keychain item ssp-signoz-eks-api-key.
#                                    The EKS SigNoz has its own service accounts, so the local key does not work there.
# Nothing secret is printed.

_eks_env_sourced=0
if [ -n "${ZSH_VERSION:-}" ]; then
  case "${ZSH_EVAL_CONTEXT:-}" in *:file*) _eks_env_sourced=1 ;; esac
elif [ -n "${BASH_VERSION:-}" ]; then
  [ "${BASH_SOURCE[0]}" != "$0" ] && _eks_env_sourced=1
fi
if [ "${_eks_env_sourced}" != 1 ]; then
  echo "Source this script instead of running it: source scripts/eks-env.sh" >&2
  exit 1
fi
unset _eks_env_sourced

_eks_env_main() {
  local region=${AWS_REGION:-eu-central-1}
  local secret_id=${EKS_MONGO_SECRET_ID:-eks-dev/exchange/mongodb}
  local mongo_hostport=localhost:37017

  export VM_URL=http://localhost:18428
  export VMAGENT_URL=http://localhost:18429
  export SSP_MING_SIGNOZ_URL=http://localhost:13301

  # The secret holds MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD. Python URL-encodes them, because a
  # password with @, : or / would otherwise break the URI. The values only pass through variables.
  local secret_json credentials
  if ! secret_json=$(aws secretsmanager get-secret-value --region "${region}" --secret-id "${secret_id}" \
      --query SecretString --output text 2>/dev/null); then
    echo "eks-env: could not read ${secret_id} from Secrets Manager (expired AWS session?). MONGO_URI left unchanged." >&2
  elif ! credentials=$(printf '%s' "${secret_json}" | python3 -c '
import json, sys, urllib.parse
secret = json.load(sys.stdin)
user = urllib.parse.quote(secret["MONGO_INITDB_ROOT_USERNAME"], safe="")
password = urllib.parse.quote(secret["MONGO_INITDB_ROOT_PASSWORD"], safe="")
print(f"{user}:{password}")
' 2>/dev/null); then
    echo "eks-env: ${secret_id} lacks MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD. MONGO_URI left unchanged." >&2
  else
    # directConnection: talk to the one forwarded pod, never discover other members by their in-cluster names.
    export MONGO_URI="mongodb://${credentials}@${mongo_hostport}/ssp-exchange?authSource=admin&directConnection=true"
    export BIDDERS_MONGO_URI="mongodb://${credentials}@${mongo_hostport}/ssp-bidders?authSource=admin&directConnection=true"
  fi

  local signoz_key
  if signoz_key=$(security find-generic-password -a "${USER}" -s ssp-signoz-eks-api-key -w 2>/dev/null); then
    export SSP_MING_SIGNOZ_API_KEY="${signoz_key}"
    local signoz_state="EKS key from the Keychain"
  else
    unset SSP_MING_SIGNOZ_API_KEY
    local signoz_state="NO key: create one in the EKS SigNoz, then: security add-generic-password -U -a \"\$USER\" -s ssp-signoz-eks-api-key -w"
  fi

  echo "MCP servers now point at EKS (restart Claude Code from this shell):"
  echo "  victoriametrics  ${VM_URL} (targets: ${VMAGENT_URL})"
  echo "  exchange-mongo   ${mongo_hostport} $([ -n "${MONGO_URI:-}" ] && case "${MONGO_URI}" in *37017*) echo "with credentials from ${secret_id}" ;; *) echo "NOT set" ;; esac)"
  echo "  ssp-signoz       ${SSP_MING_SIGNOZ_URL} (${signoz_state})"
}
_eks_env_main
unset -f _eks_env_main
