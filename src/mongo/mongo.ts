import { Db, MongoClient } from "mongodb";

/**
 * Two databases, two connection strings. Locally both live on the same Mongo (docker-compose);
 * on EKS the exchange and the bidders service each read their own URI, so we mirror that split.
 */
const SOURCES = {
  exchange: { envVar: "MONGO_URI", defaultUri: "mongodb://localhost:27017/ssp-exchange" },
  bidders: { envVar: "BIDDERS_MONGO_URI", defaultUri: "mongodb://localhost:27017/ssp-bidders" },
} as const;
export type Source = keyof typeof SOURCES;

const clients = new Map<Source, MongoClient>();

/** Lazily connects on first use so the server starts even while a port-forward is still coming up. */
export async function db(source: Source): Promise<Db> {
  let client = clients.get(source);
  if (!client) {
    const { envVar, defaultUri } = SOURCES[source];
    client = new MongoClient(process.env[envVar] ?? defaultUri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    clients.set(source, client);
  }
  return client.db();
}

export function describeSources(): string {
  return (Object.keys(SOURCES) as Source[])
    .map((source) => `${source}=${process.env[SOURCES[source].envVar] ? "set" : "default localhost"}`)
    .join(", ");
}

export async function closeMongo(): Promise<void> {
  await Promise.all([...clients.values()].map((client) => client.close()));
  clients.clear();
}
