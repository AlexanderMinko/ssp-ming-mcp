/**
 * Every port the MCP servers and scripts use, read from ports.json at the project root, the one source of truth:
 *   local  the Compose stack and the apps on the laptop. The servers use these as their local-target defaults.
 *   eks    the port-forwards. scripts/eks-port-forward.sh opens them, scripts/eks-env.sh exports their URLs, and
 *          the servers use them as their eks-target defaults.
 */
import ports from "../../ports.json" with { type: "json" };

export type LocalName = keyof typeof ports.local;
export type ForwardName = keyof typeof ports.eks;

export interface LocalPort {
  port: number;
  owner: string;
}

export interface Forward {
  namespace: string;
  service: string;
  localPort: number;
  remotePort: number;
}

export const LOCAL_PORTS: Readonly<Record<LocalName, LocalPort>> = ports.local;
export const EKS_FORWARDS: Readonly<Record<ForwardName, Forward>> = ports.eks;

/** `localhost:<port>` of a local Compose service, for a Mongo URI. */
export function localHost(name: LocalName): string {
  return `localhost:${LOCAL_PORTS[name].port}`;
}

/** `http://localhost:<port>` of a local Compose service. */
export function localUrl(name: LocalName): string {
  return `http://${localHost(name)}`;
}

/** `localhost:<port>` of a forward, for a Mongo URI. */
export function forwardHost(name: ForwardName): string {
  return `localhost:${EKS_FORWARDS[name].localPort}`;
}

/** `http://localhost:<port>` of a forward. */
export function forwardUrl(name: ForwardName): string {
  return `http://${forwardHost(name)}`;
}
