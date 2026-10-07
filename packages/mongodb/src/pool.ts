import { type Db, MongoClient, type MongoClientOptions } from "mongodb";

type Client = Pick<MongoClient, "db" | "close">;
type ClientFactory = (uri: string, options: MongoClientOptions) => Client;

/** Native handles belong to the calling worker and must never cross IPC. */
export interface MongoPool {
  database(key: string, uri: string, database: string): Promise<Db>;
  close(): Promise<void>;
}

/** One client per registered connection, shared by its database aliases. */
export function createMongoPool(
  factory: ClientFactory = (uri, options) => new MongoClient(uri, options)
): MongoPool {
  const clients = new Map<string, { uri: string; client: Client }>();
  let closed = false;
  // Serialize creation, replacement and shutdown, including parallel script connects later.
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <A>(run: () => Promise<A>): Promise<A> => {
    const next = pending.then(run);
    pending = next.catch(() => undefined);
    return next;
  };
  return {
    database: (key, uri, database) =>
      serialize(async () => {
        if (closed) throw new Error("MongoDB pool is closed.");
        let existing = clients.get(key);
        if (existing && existing.uri !== uri) {
          await existing.client.close();
          clients.delete(key);
          existing = undefined;
        }
        if (!existing) {
          const client = factory(uri, {
            appName: "runnel",
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            maxPoolSize: 10,
            minPoolSize: 0,
          });
          existing = { uri, client };
          clients.set(key, existing);
        }
        // The driver connects lazily on the first operation and retains its pools.
        return existing.client.db(database);
      }),
    close: () =>
      serialize(async () => {
        closed = true;
        const current = [...clients.entries()];
        const outcomes = await Promise.allSettled(
          current.map(async ([key, { client }]) => {
            await client.close();
            // Failed closes remain tracked so a later shutdown attempt can retry them.
            clients.delete(key);
          })
        );
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new Error("Cannot close all MongoDB clients.");
      }),
  };
}
