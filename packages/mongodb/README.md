# Runnel MongoDB

`@abijith-suresh/runnel-mongodb` owns MongoDB connection pools for Runnel's worker.
It depends on Runnel core, Effect v4, the official MongoDB Node driver, and its
connection-string parser.

`mongoConnectionDatabase(uri)` validates URI syntax locally and returns the
percent-decoded path database, or undefined. It never uses `authSource` as the
target, creates a client, or performs DNS or database I/O. Errors omit URI contents.
The caller validates physical database names and input bounds.

`createMongoPool` reuses one client per registered connection key. Database aliases
share that client; independent registrations do not share clients even when their
URIs match. Changing a credential replaces the client. Shutdown closes all clients
and prevents later acquisition. Returned `Db` objects are actual local driver
handles. They must stay inside the worker and never cross IPC.

Build with `npm run build` at the repository root. Unit tests inject a client
factory and need no database. Run them with
`npm test --workspace @abijith-suresh/runnel-mongodb`.

See [the repository](https://github.com/abijith-suresh/runnel) for design and
development documentation. This package has not been published.
