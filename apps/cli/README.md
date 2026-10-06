# Runnel CLI

`@abijith-suresh/runnel` is the scoped public CLI package, with executable name
`runnel`. Bare npm `runnel` belongs to an existing package. The CLI depends on
the matching public core and MongoDB packages, plus Effect v4.

This development baseline has no implemented commands. Its executable prints
"Runnel is a development baseline. Planned commands are not implemented." to
stderr and exits with status 1. The library entry point exports an empty module.
This includes `--help` and `--version`; no argument parser exists yet.

Build with `npm run build` at the repository root. `npm run pack:check` checks
all package artifacts and imports in a temporary local consumer without global
installation or publication.

See [the repository](https://github.com/abijith-suresh/runnel) for planned commands
and development documentation. This package has not been published.
