# Contributing

## Setup and checks

The supported development runtime is Node 24. The exact versions are declared
in `mise.toml`, `.node-version`, and the root `packageManager` field. Use npm
workspaces and commit `package-lock.json`. Do not add a second package manager.

```sh
npm ci
git switch -c feat/short-description
npm run verify
```

| Command | What it does |
| --- | --- |
| `npm run build` | Builds the TypeScript project references and the private static website |
| `npm run dev:website` | Starts the private Astro site at `http://localhost:4321/runnel/` |
| `npm run build:website` | Builds only the static website into `apps/website/dist/` |
| `npm run preview:website` | Previews the built website locally |
| `npm run clean` | Removes workspace build outputs and TypeScript caches |
| `npm run typecheck` | Checks every workspace without emitting files; build first |
| `npm run lint` | Runs Biome's recommended lint rules |
| `npm run format` | Writes Biome formatting and the website Astro templates with Prettier |
| `npm run format:check` | Checks Biome formatting and the website Astro templates with Prettier |
| `npm run test:policy` | Tests Changeset parsing, version increments, and Git PR diffs |
| `npm run test` | Runs workspace behavior tests with Node's test runner and typed `.mts` tests |
| `npm run release-policy` | Checks current Changesets, package boundaries, versions, and lockfile |
| `npm run changeset` | Adds a release note through Changesets |
| `npm run changeset:status` | Shows Changesets' pending release plan |
| `npm run changeset:check` | Checks a PR using full `BASE_SHA` and `HEAD_SHA` environment values |
| `npm run pack:check` | Builds, checks pack destinations, and validates isolated tarball installs |
| `npm run verify` | Runs the complete development baseline verification |
| `npm run check:native-credentials` | Optional OS credential round-trip with one synthetic value and cleanup; requires an unlocked vault |
| `npm run check:mongodb` | Optional installed-tarball smoke check against a loopback test MongoDB server and native credential storage |
| `npm run check:mongodb-auth` | Optional disposable authenticated MongoDB check using rootless Podman and synthetic native credentials |
| `npm run install:local -- /absolute/new-directory` | Builds and installs all three tarballs locally; destination must be new and its parent must exist |
| `npm run version:packages` | Guards and applies a patch-only release plan, then updates the lockfile |

Typechecking checks dependency declarations as well as source, with
`skipLibCheck` disabled. Package scripts can be selected with npm's `--workspace`
flag. `npm run verify` needs no database or credential configuration. Add focused
tests for the behavior you change; CI owns the full suite. Keep credentials, real
URIs, returned documents, local catalogs, and operation histories out of the
repository. The optional
`check:native-credentials` command accesses OS storage, verifies persistence from
a second process, and removes its synthetic entry. Run packaging and versioning
helpers through npm so they inherit the npm JavaScript entry point.
See [local testing](#local-testing) for the MongoDB probe and manual CLI use.

## Branches and pull requests

Use `feat/`, `fix/`, `chore/`, `docs/`, or `ci/` branches. Use Conventional
Commits and a Conventional Commit PR title of at most 72 characters, with no
trailing period. Husky runs lint-staged before commits, commitlint for commit
messages, and verification before pushes. The pre-push hook rejects direct
pushes from local `main`. Do not bypass hooks with `--no-verify`, force-push
`main`, auto-merge, or publish without an explicit maintainer instruction.

Every ordinary PR adds a new, nonempty **patch** Changeset. This includes tooling
and documentation changes. Select an affected public package; for repository
tooling or documentation, select the CLI. The fixed group aligns the other two
packages when maintainers prepare the next release. Do not edit merged pending
Changesets. A release PR consumes them instead.

```sh
npm run changeset
npm run verify
git add .
git commit -m "chore: improve development tooling"
git push -u origin HEAD
gh pr create
```

The initial baseline bootstraps `main` once. Future changes go through PRs.
GitHub requires the `Baseline verified` check, which combines quality,
Changeset policy, PR title, and native Windows quality results. `main` requires an up-to-date branch and
resolved conversations. No approving review is required, so the owner can merge
their own PR after checks pass. Administrators are included; force pushes and
branch deletion are blocked. The owner can change repository settings, as with
any owner-managed repository. Merge using GitHub's squash merge after review.

CI reuses the owner's shared npm quality and Conventional Commit title workflows
at a pinned commit. It runs with read-only permissions and no release credentials.
A repository-owned Windows job runs the full verification suite and the synthetic
native credential probe. POSIX-only filesystem and signal tests stay on Linux.
Native MongoDB and interactive terminal behavior still need separate platform
integration testing. There is no publication or auto-merge workflow.

The maintainer authorized a local MongoDB CLI milestone: incremental development
until Runnel can be installed and tested locally against MongoDB. Each slice uses
a branch, a patch Changeset, focused tests, full verification, and a fresh
independent review; merge only when required checks pass. Publication, MCP, and
additional providers are outside that milestone.

## Releases

All Runnel releases advance exactly one patch. This rule includes functionality
additions and continues after 1.0. Minor or major Changesets, prerelease versions,
skipped increments, downgrades, and unaligned workspace versions are rejected.
The three public packages share a Changesets fixed group and use the same exact
internal version. They start at `0.0.1` and are not yet published.

`npm run release-policy` checks pending Changesets, the fixed group, package
versions, dependency direction, public package metadata, Effect v4 pins, and the
lockfile. `npm run changeset:check` adds a Git comparison on PRs. Every ordinary
PR must add a nonempty patch Changeset and leave versions unchanged.

After development PRs and their Changesets land on main, and after every three
merged feature PRs, prepare a version PR:

```sh
git switch main
git pull --ff-only
git switch -c chore/version-packages
npm ci
npm run version:packages
npm run verify
git add .
git commit -m "chore(release): version packages"
git push -u origin HEAD
gh pr create --title "chore(release): version packages"
```

A version PR must consume all existing valid patch Changesets and increment all
three packages exactly once. Its diff may contain only those deleted Changesets,
workspace versions and internal dependency versions, changelogs, and the lockfile.
It cannot mix source or package-script edits into a release. Do not invoke
unguarded `changeset version`, and do not combine new functionality with a version
PR. Review and merge it only after required checks pass.

The baseline deliberately has no npm publication command, release workflow,
GitHub release creation, registry credential, or auto-merge workflow. Versioning
is local and PR based, and packaging verification never publishes. A future,
separately authorized release task must define explicit publication controls and
publish the three matching artifacts; do not enable publication as a side effect
of a feature PR.

## Local testing

Runnel has not been published. The CLI requires Node `>=24.19.0 <25`. Use Node
24.19.0 and npm 11.16.0 as pinned in `mise.toml`, then run `npm ci` from the
repository root. The local tarball install does not bundle Node; keep a compatible
`node` (and npm, while installing) on `PATH`.

Install a local build with `npm run install:local` and an absolute path to a new
directory whose parent exists. It builds, packs, and installs all three workspace
packages together, keeps the tarballs and lockfile there so internal dependencies
resolve without publication, and checks the installed `runnel --version`.

```sh
mkdir -p "$HOME/.local/share"
runnel_install="$HOME/.local/share/runnel-local"
npm run install:local -- "$runnel_install"
export PATH="$runnel_install/node_modules/.bin:$PATH"
runnel --version
```

The installer refuses existing files, directories, and links, including empty
directories, and removes only its own newly created directory on failure. Add
`node_modules/.bin` to your shell profile or user PATH to keep `runnel` available
in new terminals. Windows installation paths reject the npm launcher
metacharacters `&`, `%`, `^`, `!` and control characters, including in their
resolved parent; spaces and `#` are supported. Before switching versions, run
`runnel daemon stop`, install into another new directory, and update `PATH`.

To use the compiled CLI directly, `npm run build` and invoke
`node apps/cli/dist/cli.js` (use a terminal alias or PowerShell function for a
short name). After rebuilding, run `runnel daemon stop` before the next database
command so the worker and protocol modules reload.

Register and query a target from an interactive terminal. Linux requires a
session D-Bus connection and an unlocked Secret Service store, such as GNOME
Keyring; native Windows uses Windows credential storage. `npm run
check:native-credentials` tests the OS store with one synthetic entry and removes
it afterward. `runnel setup` prompts for a hidden URI, lists accessible databases,
and lets you choose and name aliases; each alias defaults to its database name
when available. The catalog stores secret references, so connection strings stay
in OS storage. Configured names are never overwritten; manual names are not
verified against the database.

```sh
runnel envs
runnel connections -e local
runnel databases -e local
runnel list -e local -d sandbox
runnel count users -e local -d sandbox
runnel find users -e local -d sandbox --limit 10
runnel export users -e local -d sandbox --output users.ejson
runnel history
runnel daemon status
runnel daemon stop
```

Every database command requires `-e`; omit `-d` only when the environment has
exactly one alias. Check the output's `ok` and `truncated` fields; a successful
bounded export can still be incomplete. Exports need a new filename in an
existing directory. More options and script examples are in
[CLI usage](apps/cli/README.md).

The default catalog is `$XDG_CONFIG_HOME/runnel` or `~/.config/runnel` on Linux,
and `%APPDATA%/runnel` on Windows. Set an absolute private `RUNNEL_HOME` for an
isolated test catalog, and stop the test daemon before changing the variable.

`RUNNEL_TEST_MONGODB_PORT=<port> npm run check:mongodb` optionally builds, packs,
and installs all three tarballs in a temporary consumer, then runs that installed
CLI against a local test server. Use a development MongoDB that allows synthetic
database creation and removal; the check accepts no connection string and never
reads your existing catalog. On WSL, use rootless Podman with the official MongoDB
Community image bound to IPv4 loopback. The check creates two random
`runnel_check_` databases, two synthetic credential entries, and a private
temporary catalog, then removes them and stops its daemon. Abrupt termination can
leave fixtures behind. The check passed on Linux in WSL with MongoDB 8.0.32 and
native Secret Service storage. Native Windows MongoDB access, interactive
terminal setup and Ctrl+C behavior, and authenticated permission-denial
integration remain separate checks. `npm run verify` stays independent of MongoDB
and OS credential configuration.

`npm run check:mongodb-auth` creates its own authenticated MongoDB server using
rootless Podman and `docker.io/mongodb/mongodb-community-server:8.0-ubuntu2204`.
It requires Podman, a compatible image or registry access, and unlocked native
credential storage. It installs the three tarballs together, creates random
synthetic users and a private catalog, and tests successful reads, denied writes,
BSON precision, truncation, credential rotation, pool refresh, alias changes,
credential expiry, recovery, and history redaction.
The container binds only to IPv4 loopback on an allocated port. Normal cleanup
stops its daemon, removes its native credential entries, destroys its container
and volumes, and removes temporary files. It never reads an existing catalog or
accepts user credentials. Abrupt termination can leave synthetic fixtures behind.
This optional check has been run on Linux; it does not establish native Windows
interactive setup or Ctrl+C behavior.

## Package boundaries and documentation

The private `apps/website` workspace owns the static marketing site. See its
[website guide](apps/website/README.md) for local preview, build, and font licensing.
It has no live deployment workflow and does not join the three public packages
in releases or local tarball installs. Root verification builds and checks it;
its pinned tooling stays in its own dev dependencies.

Keep core independent of concrete providers and applications. MongoDB depends
on core. The CLI composes both. Declare dependencies by package name in manifests
and TypeScript references in build configs. Use `.js` import specifiers in ESM
TypeScript when importing relative files. Keep new packages out until a real
ownership or distribution boundary needs them.

Effect v4 is the agreed effect system for future orchestration. Model fallible
operations with typed Effects and resource scopes when implementation begins;
pure transformations can remain ordinary functions. Do not silently use v3 APIs
or replace v4. The official MongoDB Node driver belongs to the adapter.

[AGENTS.md](AGENTS.md) states product intent and philosophy. [README.md](README.md)
contains status and a current architecture summary. This file owns the development
workflow and release process. Update the document that owns the changed truth when
commands, architecture, tooling, or release mechanics change. Keep prose plain and
mark proposals, examples, and unresolved decisions as planned. Do not turn planned
examples into implemented commands as part of an unrelated change. Do not add product
tests that assert placeholders; add behavior tests when there is behavior to test.
