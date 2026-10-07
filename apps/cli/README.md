# Runnel CLI

`@abijith-suresh/runnel` is the scoped public CLI package, with executable name
`runnel`. Bare npm `runnel` belongs to an existing package. The CLI depends on
the matching public core and MongoDB packages, plus Effect v4.

The CLI currently supports information flags only:

```sh
runnel --help     # also -h; no arguments show help too
runnel --version  # also -v
```

Help lists available flags and marks database commands as planned. Version output
comes from the installed package metadata. Both write to stdout and exit with
status 0. If both flags are supplied, help takes precedence.

Unsupported commands, unknown flags, and malformed options write a concise
diagnostic to stderr and exit with status 1. No database command, setup, or
discovery command exists yet. The library entry point still exports an empty
module; there is no public CLI composition API.

For local development, build at the repository root and invoke the compiled CLI:

```sh
npm run build
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
```

Run CLI tests with `npm test --workspace @abijith-suresh/runnel`.
`npm run pack:check` checks
all package artifacts and imports in a temporary local consumer without global
installation or publication.

See [the repository](https://github.com/abijith-suresh/runnel) for planned commands
and development documentation. This package has not been published.
