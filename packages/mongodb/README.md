# Runnel MongoDB

`@abijith-suresh/runnel-mongodb` owns MongoDB connection pools for Runnel's worker.
It depends on Runnel core, Effect v4, and the official MongoDB Node driver.

`createMongoPool` reuses one client per registered connection key. Database aliases
share that client; independent registrations do not share clients even when their
URIs match. Changing a credential replaces the client. Shutdown closes all clients
and prevents later acquisition. Returned `Db` objects are actual local driver
handles. They must stay inside the worker and never cross IPC.

Build with `npm run build` at the repository root. Unit tests inject a client
factory and need no database. See the current architecture for runtime defaults.

See [the repository](https://github.com/abijith-suresh/runnel) for design and
development documentation. This package has not been published.
