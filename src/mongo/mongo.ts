import { Db, MongoClient } from "mongodb";
import { forwardHost, localHost } from "../common/ports.js";
import { EKS_REGION, currentTarget, describeTarget, explicitSetting, runAws } from "../common/target.js";

/**
 * Two databases, two connection strings. Locally both live on the same Mongo (docker-compose);
 * on EKS the exchange and the bidders service each read their own URI, so we mirror that split.
 *
 * Where the URIs come from (first match wins):
 *   1. MONGO_URI / BIDDERS_MONGO_URI, when set and not blank
 *   2. target local: the Compose Mongo (ports.json local), no credentials
 *   3. target eks:   the mongo forward (ports.json eks) (scripts/eks-port-forward.sh), with the root user and
 *                    password read from Secrets Manager (the same secret ESO gives the apps)
 */
const SOURCES = {
  exchange: { envVar: "MONGO_URI", database: "ssp-exchange" },
  bidders: { envVar: "BIDDERS_MONGO_URI", database: "ssp-bidders" },
} as const;
export type Source = keyof typeof SOURCES;

const LOCAL_HOST = localHost("mongo");
const EKS_HOST = forwardHost("mongo");
const eksSecretId = (): string => explicitSetting("SSP_MING_EKS_MONGO_SECRET_ID") ?? "eks-dev/exchange/mongodb";

/** Builds the EKS URI from the secret's JSON. User and password are URL-encoded, so any character is safe. */
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

async function resolveUri(source: Source): Promise<string> {
  const { envVar, database } = SOURCES[source];
  const explicit = explicitSetting(envVar);
  if (explicit !== undefined) {
    return explicit;
  }
  if (currentTarget().target === "local") {
    return `mongodb://${LOCAL_HOST}/${database}`;
  }
  let secretJson: string;
  try {
    secretJson = await runAws([
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
  return eksMongoUri(secretJson, database);
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
    return `${source}=${currentTarget().target === "eks" ? EKS_HOST : LOCAL_HOST}/${SOURCES[source].database}`;
  });
  return `${describeTarget()}; ${hosts.join(", ")}`;
}

export async function closeMongo(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.close()));
  clients.clear();
}
