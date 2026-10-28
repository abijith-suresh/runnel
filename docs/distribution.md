# Manual development artifact preparation

Publication is disabled. This repository prepares candidate tarballs and Actions
artifacts without npm credentials, registry writes, GitHub Releases or dashboard
changes. The `publish` workflow input defaults to false; true fails closed. There
is no publish implementation or `id-token: write` permission to enable by changing
a variable. Future publication requires a separately reviewed owner-approved
change and protected authorization.

## Exact version and tag policy

The three source packages remain aligned at `0.0.7`. Patch Changesets are preserved.
Preparation stages all three at one version from one full Git SHA:

```
0.0.0-dev.YYYYMMDD.RUN.ATTEMPT
0.0.0-alpha.YYYYMMDD.RUN.ATTEMPT
```

The channel and intended dist-tag must both be exactly `dev` or both `alpha`.
Stable versions, `latest`, other tags, channel mismatches, malformed/noncanonical
identifiers and bad SHAs are rejected. The UTC date must be a real calendar date;
run/attempt are positive safe integers with no leading zeros. Manual Actions use
the actual GitHub run ID and attempt, so reruns receive another version identity.
Local candidate IDs are explicit and must never be treated as registry allocation.
Preparation does not query registry availability. Before any future publication,
the owner must check that the version is unused for every package; npm forbids
reusing a published package/version even after removal.

Every staged package contains the same bounded `runnelBuild` identity and exact
internal prerelease dependencies. The CLI's `runnel build-info` reports the full
source SHA, source version, channel, date, run and attempt without reading a
catalog or starting database processes. Ordinary source/local builds without this
receipt report `build: null`. `--version` remains plain version text.

## Preparation and artifact verification

Use Node 24.19.0 and npm 11.16.0, as pinned in the repository. Runtime CLI engines
remain Node `>=24.19.0 <25`; npm is needed for installation/preparation, not each
CLI command. Do not bypass engine checks or replace a managed laptop's global
runtime. Have the owner supply an approved compatible runtime first if needed.

The manual `Prepare dev or alpha artifacts` workflow must be on the default
branch and dispatched from `main`. It refuses other repositories, refs/events,
publication requests and source SHA mismatches. It snapshots exact Git objects
without another checkout, builds in a newly owned temporary directory, and changes
only staged public manifests. Dependency installation inside the snapshot and
consumer is offline with lifecycle scripts disabled; the initial locked `npm ci`
primes the dependency cache. The final bundle is outside the source repository.

Only public package contents are packed. A strict manifest records the three
names/versions, common build identity, per-file sizes/hashes, tarball SHA256 and
SHA512 integrity. `SHA256SUMS` covers the manifest and all tarballs. Content hashes,
versions and internal dependencies are checked in an outside-repository install
before executing CLI code or uploading the candidate. Checksums detect corruption;
trust comes from the approved source SHA and workflow, not a checksum beside an
untrusted download.

Ubuntu prepares and tests one canonical bundle. Native Windows downloads those
same tarball bytes, rechecks hashes and the expected source SHA, then runs installed
offline/agent, HTTP and synthetic production-worker lifecycle checks. Wait for both
jobs to pass before accepting a candidate. The artifact existing on Actions does
not itself mean Windows validation passed. Verification uses synthetic providers
and no native vault or live MongoDB. Actions retain candidates for 14 days; they
are not GitHub Releases or permanent release storage.

A local candidate can be prepared from an explicit commit using the same tools:

```powershell
# Run from an approved source checkout after locked dependency installation.
$sha = git rev-parse HEAD
$bundle = Join-Path $env:TEMP "runnel-dev-candidate"
$date = [DateTime]::UtcNow.ToString("yyyyMMdd")
$run = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()
npm.cmd run prepare:prerelease -- --output $bundle --channel dev --source-sha $sha --date $date --run-id $run --attempt 1
```

Use the actual UTC date and a distinct local run/attempt for each candidate.
`--dispatch` additionally enforces the trusted Actions/main context; local
preparation does not grant that trust or publication authority. Existing output
paths are refused, and failures remove only newly owned staging data. Source
versions, lockfile and Changesets are not rewritten.

## Native PowerShell installation

Source and local-tarball installation do not require publication. Start from an
approved source commit and user-writable installation path. Git and compatible
Node/npm must already be available; no WSL, administrator, execution-policy bypass
or downloaded-code piping is required.

```powershell
git clone https://github.com/abijith-suresh/runnel.git runnel-source
Set-Location runnel-source
# Use the owner's approved full commit SHA, then verify the displayed revision.
$approvedSha = "<owner-approved-40-character-SHA>"
git switch --detach $approvedSha
git rev-parse HEAD
node --version
npm.cmd --version
# Use the pinned npm locally if the supplied npm differs; this changes no global toolchain.
npx.cmd --yes --package=npm@11.16.0 npm ci --ignore-scripts
npx.cmd --yes --package=npm@11.16.0 npm run install:local -- "C:\Users\you\AppData\Local\runnel-source-install"
$env:PATH = "C:\Users\you\AppData\Local\runnel-source-install\node_modules\.bin;$env:PATH"
runnel.cmd --version
runnel.cmd build-info
```

The source install reports `build: null`; retain the approved Git SHA with that
installation. Initial dependencies require approved registry access. Later
installation from the verified dependency cache can be offline. npm's Windows
launcher paths must not contain `&`, `%`, `^`, `!` or control characters; spaces
and `#` are supported. Existing installation directories are never overwritten.

For a prepared Actions bundle, download it only from the approved workflow run,
extract with PowerShell `Expand-Archive`, inspect `manifest.json`, and check the
approved source SHA and `SHA256SUMS`. From the approved source checkout:

```powershell
$bundle = "C:\Users\you\Downloads\runnel-dev-bundle"
npx.cmd --yes --package=npm@11.16.0 npm run install:prerelease -- $bundle "C:\Users\you\AppData\Local\runnel-dev-install"
$env:PATH = "C:\Users\you\AppData\Local\runnel-dev-install\node_modules\.bin;$env:PATH"
runnel.cmd --version
runnel.cmd build-info
runnel.cmd envs
```

The installer verifies the complete bundle, installs all three tarballs together
with scripts disabled, checks unpacked contents and build identity, and keeps the
tarballs/lockfile for later `npm ci --offline`. It needs an already primed approved
dependency cache; it never silently fetches unpublished sibling packages. Do not
install the CLI tarball alone. PATH changes above affect only the current shell;
permanent user PATH changes are an explicit owner action.

Before switching installations, stop the old database daemon with `runnel.cmd daemon
stop` and any foreground manager with Stop manager or Ctrl+C. Install into another
new directory and select its PATH. Keep the previous directory to roll back;
never downgrade across an unsupported catalog schema without a compatible tool.

## Remaining owner-only publication decisions

These are deferred actions, not requests to perform them now:

1. Approve the channel, complete source SHA and exact unique version for all three
   packages; confirm package existence/ownership and a supported first-publication
   route. Registry availability/ownership and initial login/2FA are unverified.
2. Approve a separate implementation change for publication and its protected
   GitHub environment, required reviewers and main-branch restrictions. Keep the
   default explicit opt-in false, repeat all byte/identity checks before any write,
   and bind authorization to the exact prepared artifact and source.
3. Configure npm trusted publishing for each package's precise repository,
   workflow filename and owner-selected environment on supported hosted runners.
   Give only the approved action permissions. Do this near the approved first
   publication because new configurations currently expire without a successful
   first publish within two days. No such configuration is created here.
4. Recheck current OIDC/toolchain support and initial-package requirements.
   npm 11.16 meets the documented OIDC minimum, but newer independent OIDC dist-tag
   commands require a later CLI; preparation invokes neither those commands nor
   registry mutation. Never rely on the implicit npm publish tag, which is latest.
   Future writes must explicitly use the approved dev/alpha tag and must not move
   latest. Publishing three packages is not atomic; inspect partial/unknown results
   before any retry and keep exact dependency ordering and hashes.
5. Finish managed-laptop runtime, install/update/rollback, browser, Ctrl+C, native
   vault and approved live-database acceptance. No corporate endpoint is used as
   an automated test fixture and no credentials are requested in chat.

## Official policy references

Reviewed 2026-10-28. npm documents prerelease versioning, explicit dist-tags and
irreversible package/version reuse rules in [semantic versioning](https://docs.npmjs.com/about-semantic-versioning/),
[dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages/) and
[npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
[Trusted publishing](https://docs.npmjs.com/trusted-publishers/) documents hosted
runner, npm/Node minimum, package/workflow/environment configuration and first-use
restrictions. GitHub documents [manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)
and [protected environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
These are platform rules; the stricter dev/alpha namespace and disabled gate above
are this repository's preparation policy. No platform configuration was changed.
