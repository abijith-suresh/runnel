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
| `npm run build` | Builds the TypeScript project references in dependency order |
| `npm run clean` | Removes workspace build outputs and TypeScript caches |
| `npm run typecheck` | Checks every workspace without emitting files; build first |
| `npm run lint` | Runs Biome's recommended lint rules |
| `npm run format` | Writes Biome formatting |
| `npm run format:check` | Checks Biome formatting |
| `npm run test:policy` | Tests Changeset parsing, version increments, and Git PR diffs |
| `npm run release-policy` | Checks current Changesets, package boundaries, versions, and lockfile |
| `npm run changeset` | Adds a release note through Changesets |
| `npm run changeset:status` | Shows Changesets' pending release plan |
| `npm run changeset:check` | Checks a PR using full `BASE_SHA` and `HEAD_SHA` environment values |
| `npm run pack:check` | Builds, checks pack destinations, and validates isolated tarball installs |
| `npm run verify` | Runs the complete development baseline verification |
| `npm run version:packages` | Guards and applies a patch-only release plan, then updates the lockfile |

Typechecking checks dependency declarations as well as source, with
`skipLibCheck` disabled. Package scripts can be selected with npm's `--workspace`
flag. No database or credential configuration is needed for these checks.

## Branches and pull requests

Use `feat/`, `fix/`, `chore/`, `docs/`, or `ci/` branches. Use Conventional
Commits and a Conventional Commit PR title of at most 72 characters, with no
trailing period. Husky runs lint-staged before commits, commitlint for commit
messages, and verification before pushes. The pre-push hook rejects direct
pushes from local `main`. Do not bypass hooks with `--no-verify`.

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
Changeset policy, and PR title results. `main` requires an up-to-date branch and
resolved conversations. No approving review is required, so the owner can merge
their own PR after checks pass. Administrators are included; force pushes and
branch deletion are blocked. The owner can change repository settings, as with
any owner-managed repository. Merge using GitHub's squash merge after review.

CI reuses the owner's shared npm quality and Conventional Commit title workflows
at a pinned commit. It runs with read-only permissions and no release credentials.
There is no publication or auto-merge workflow in this baseline.

## Package boundaries and documentation

Keep core independent of concrete providers and applications. MongoDB depends
on core. The CLI composes both. Declare dependencies by package name in manifests
and TypeScript references in build configs. Use `.js` import specifiers in ESM
TypeScript when importing relative files. Keep new packages out until a real
ownership or distribution boundary needs them.

Effect v4 is the agreed effect system for future orchestration. Model fallible
operations with typed Effects and resource scopes when implementation begins;
pure transformations can remain ordinary functions. Do not silently use v3 APIs
or replace v4. The official MongoDB Node driver belongs to the adapter.

`docs/DESIGN.md` records planned behavior. `docs/ARCHITECTURE.md` records what
actually exists. Keep those roles separate as features land. Update docs when
commands, architecture, tooling, or release mechanics change. Do not add product
tests that assert placeholders; add behavior tests when there is behavior to test.

See [release policy](docs/RELEASING.md) for version PRs and publication boundaries.
