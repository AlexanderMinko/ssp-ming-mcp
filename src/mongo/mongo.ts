import { Db, MongoClient } from "mongodb";
import { forwardHost, localHost } from "../common/ports.js";
import { EKS_REGION, KIND_CONTEXT, currentTarget, describeTarget, explicitSetting, isCluster, runAws, runKubectl } from "../common/target.js";

/**
 * Two databases, two connection strings. Locally both live on the same Mongo (docker-compose);
 * on EKS the exchange and the bidders service each read their own URI, so we mirror that split.
 *
 * Where the URIs come from (first match wins):
 *   1. MONGO_URI / BIDDERS_MONGO_URI, when set and not blank
 *   2. target local: the Compose Mongo (ports.json local), no credentials
 *   3. target eks:   the mongo forward (ports.json eks) (scripts/eks-port-forward.sh), with the root user and
 *                    password read from Secrets Manager (the same secret ESO gives the apps)
 *   4. target kind:  the same forward, with the root user and password read from the cluster Secret that ESO's
 *                    Kubernetes provider uses as its source (ssp-ming-k8s-local terraform/03-eso.tf), via kubectl
 *
 * The target decides where the credentials come from; nothing else does. Both cluster sources hold the same two
 * keys, so one function builds the URI.
 */
const SOURCES = {
  exchange: { envVar: "MONGO_URI", database: "ssp-exchange" },
  bidders: { envVar: "BIDDERS_MONGO_URI", database: "ssp-bidders" },
} as const;
export type Source = keyof typeof SOURCES;

const LOCAL_HOST = localHost("mongo");
const EKS_HOST = forwardHost("mongo");
const eksSecretId = (): string => explicitSetting("SSP_MING_EKS_MONGO_SECRET_ID") ?? "eks-dev/exchange/mongodb";
/** `<namespace>/<name>` of the kind cluster's source Secret. */
const kindSecretRef = (): string => explicitSetting("SSP_MING_KIND_MONGO_SECRET") ?? "secret-source/exchange-mongodb";

/**
 * Builds the URI of the forwarded Mongo (eks or kind) from the secret's JSON. User and password are URL-encoded,
 * so any character is safe.
 */
export function eksMongoUri(secretJson: string, database: string): string {
  const secret = JSON.parse(secretJson) as Record<string, unknown>;
  const user = secret.MONGO_INITDB_ROOT_USERNAME;
  const password = secret.MONGO_INITDB_ROOT_PASSWORD;
  if (typeof user !== "string" || typeof password !== "string") {
    throw new Error("The secret lacks MONGO_INITDB_ROOT_USERNAME / MONGO_INITDB_ROOT_PASSWORD.");
  }
  // directConnection: talk to the one forwarded pod, never discover other members by their in-cluster names.
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${EKS_HOST}/${database}?authSource=admin&directConnection=true`;
}

/** Host and database of a URI, for messages. Never includes the credentials. */
export function describeUri(uri: string): string {
  return uri.replace(/^mongodb(\+srv)?:\/\/([^@/]*@)?/, "").replace(/\?.*$/, "");
}

/**
 * Turns `kubectl get secret -o json` output into the same JSON shape the Secrets Manager secret has.
 * A Kubernetes Secret stores every value base64-encoded under `data`.
 */
export function decodeKubernetesSecret(secretManifestJson: string): string {
  const manifest = JSON.parse(secretManifestJson) as { data?: Record<string, unknown> };
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(manifest.data ?? {})) {
    if (typeof value === "string") {
      decoded[key] = Buffer.from(value, "base64").toString("utf8");
    }
  }
  return JSON.stringify(decoded);
}

async function readEksSecret(): Promise<string> {
  try {
    return await runAws([
      "secretsmanager",
      "get-secret-value",
      "--region",
      EKS_REGION(),
      "--secret-id",
      eksSecretId(),
      "--query",
      "SecretString",
      "--output",
      "text",
    ]);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${eksSecretId()} from Secrets Manager (expired AWS session?): ${reason}`);
  }
}

async function readKindSecret(): Promise<string> {
  const [namespace, name] = kindSecretRef().split("/");
  if (namespace === undefined || name === undefined || namespace === "" || name === "") {
    throw new Error(`SSP_MING_KIND_MONGO_SECRET must be <namespace>/<name>, got "${kindSecretRef()}".`);
  }
  try {
    return decodeKubernetesSecret(
      await runKubectl(["--context", KIND_CONTEXT(), "--namespace", namespace, "get", "secret", name, "--output", "json"]),
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read the Secret ${kindSecretRef()} with context ${KIND_CONTEXT()} (is the kind cluster up?): ${reason}`);
  }
}

async function resolveUri(source: Source): Promise<string> {
  const { envVar, database } = SOURCES[source];
  const explicit = explicitSetting(envVar);
  if (explicit !== undefined) {
    return explicit;
  }
  const target = currentTarget().target;
  if (target === "local") {
    return `mongodb://${LOCAL_HOST}/${database}`;
  }
  return eksMongoUri(target === "kind" ? await readKindSecret() : await readEksSecret(), database);
}

const clients = new Map<Source, MongoClient>();

/** Lazily connects on first use so the server starts even while a port-forward is still coming up. */
export async function db(source: Source): Promise<Db> {
  let client = clients.get(source);
  if (!client) {
    const uri = await resolveUri(source);
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    try {
      await client.connect();
    } catch (error: unknown) {
      await client.close().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Mongo ${source} at ${describeUri(uri)} (${describeTarget()}): ${reason}`);
    }
    clients.set(source, client);
  }
  return client.db();
}

export function describeSources(): string {
  const hosts = (Object.keys(SOURCES) as Source[]).map((source) => {
    const explicit = explicitSetting(SOURCES[source].envVar);
    if (explicit !== undefined) {
      return `${source}=${describeUri(explicit)} (explicit)`;
    }
    return `${source}=${isCluster(currentTarget().target) ? EKS_HOST : LOCAL_HOST}/${SOURCES[source].database}`;
  });
  return `${describeTarget()}; ${hosts.join(", ")}`;
}

export async function closeMongo(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.close()));
  clients.clear();
}
