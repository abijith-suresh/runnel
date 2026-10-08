# Local testing

Runnel has not been published. Use Node 24 and npm at the versions pinned in
`mise.toml`, then run `npm ci` from the repository root.
The CLI commands below are implemented. MCP and other database providers remain
planned.

## Install a local build

Run `npm run install:local` with an absolute path to a new directory. Its parent
must exist. The command builds, packs and installs all three workspace packages
together, then checks the installed `runnel --version`. It keeps the tarballs
and lockfile in that directory so internal dependencies resolve without an npm
publication.

On Linux or WSL, run this from the checkout.

```sh
mkdir -p "$HOME/.local/share"
runnel_install="$HOME/.local/share/runnel-local"
npm run install:local -- "$runnel_install"
export PATH="$runnel_install/node_modules/.bin:$PATH"
runnel --version
runnel --help
```

On native Windows, run this from the checkout in PowerShell.

```powershell
$runnelInstall = Join-Path $env:LOCALAPPDATA 'RunnelLocal'
npm run install:local -- $runnelInstall
$env:Path = "$runnelInstall\node_modules\.bin;$env:Path"
runnel --version
runnel --help
```

The PATH change makes `runnel` available from any directory in this terminal.
Add the installation's `node_modules/.bin` directory to your shell profile or
Windows user PATH to retain it in new terminals. Remove any previous development
alias or function named `runnel` when switching to the installed executable.

The installer refuses existing files, directories and links, including empty
directories. A failed install removes its newly created directory; cleanup
failures are reported. It prints JSON with the installation, executable, bin
directory and version. There is no global install or shell-profile edit.

Windows installation paths cannot contain `&`, `%`, `^`, `!` or control
characters, including in their resolved parent directory. npm's generated
[Windows launcher](https://github.com/npm/cmd-shim/blob/v8.0.0/lib/index.js)
assigns its directory without quoting it. These characters can break command
execution. The installer rejects those paths before creating the installation
or running npm pack/install. Spaces, `#` and parentheses are supported; Linux
accepts the punctuation used in the packaging test.

Before switching versions, stop the old daemon with `runnel daemon stop`.
Install the new build into another new directory and update PATH. The installed
build stays unchanged when the checkout is edited or rebuilt. Catalogs and OS
credentials remain user-wide and separate from the installation directory.

## Try the compiled CLI instead

On Linux or WSL, define a terminal alias using the absolute checkout path.
This works from other directories and lasts for the current shell session.

```sh
npm run build
alias runnel='node /tmp/runnel-core-target-selection/apps/cli/dist/cli.js'
runnel --version
runnel --help
```

Replace that path with your checkout. On native Windows, use a PowerShell
function with your Windows checkout path.

```powershell
npm run build
function runnel { node C:\Code\runnel\apps\cli\dist\cli.js @args }
runnel --version
runnel --help
```

After rebuilding, run `runnel daemon stop` before your next database command.
The daemon keeps its loaded worker modules until it stops.

## Register and query a target

Linux requires a session D-Bus connection and an unlocked Secret Service store,
such as GNOME Keyring. Native Windows uses Windows credential storage. Run
`npm run check:native-credentials` from the repository to test the OS store with
one synthetic entry, which the check removes afterward.

Run `runnel setup` in an interactive terminal. Enter your URI only at its hidden
prompt. Choose an environment, a new connection name, and database aliases.
The final confirmation saves secret references in the user-wide catalog;
connection strings stay in OS storage. Setup can register a physical database
name manually even before that database exists.

For a local sandbox, register an environment named `local`, a physical database
named `runnel_sandbox`, and an alias named `sandbox`. To create one synthetic row
there, save this as `seed.mjs` and run it against that alias.

```js
export default async function ({ db, signal }) {
  await db.collection("users").updateOne(
    { _id: "runnel-demo-user" },
    { $set: { name: "Ada", active: true } },
    { upsert: true, signal }
  );
  return { users: await db.collection("users").countDocuments({}, { signal }) };
}
```

```sh
runnel run seed.mjs -e local -d sandbox --format json
```

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

Use your registered names. Every database command requires `-e`. Omit `-d` only
when the environment has exactly one alias. Check the output's `ok` and
`truncated` fields; a successful bounded export can still be incomplete.
Exports need a new filename in an existing directory. More options and script
examples are in [CLI usage](../apps/cli/README.md).

The default catalog is `$XDG_CONFIG_HOME/runnel` or `~/.config/runnel` on Linux,
and `%APPDATA%/runnel` on Windows. Set `RUNNEL_HOME` to an absolute private directory
before running commands if you want a separate test catalog. Unsetting it restores
the default location. Stop the test daemon before changing the variable.

## Check the installed packages against MongoDB

This optional check builds, packs, and installs all three workspace tarballs in a
temporary consumer, then runs that installed CLI against a local test server.
It uses an unauthenticated loopback URI constructed from a port number. Use a
development MongoDB instance that allows synthetic database creation and removal.
The check accepts no connection string and never reads your existing catalog.

For WSL, use rootless Podman with the
[official MongoDB Community image](https://www.mongodb.com/docs/manual/administration/install-community-docker/).
The [Podman port option](https://docs.podman.io/en/latest/markdown/podman-run.1.html#publish-p-ip-hostport-containerport-protocol)
below binds the test server to IPv4 loopback. This unauthenticated container is
for local synthetic data.

```sh
podman run --name runnel-smoke-mongodb -d \
  -p 127.0.0.1:37503:27017 \
  docker.io/mongodb/mongodb-community-server:8.0-ubuntu2204 --bind_ip_all
RUNNEL_TEST_MONGODB_PORT=37503 npm run check:mongodb
podman stop runnel-smoke-mongodb
podman rm runnel-smoke-mongodb
```

Wait for MongoDB to finish starting before running the check. If that container
name or port is already in use, choose another. Do not replace unrelated containers.
For a native Windows test server already listening on loopback, use PowerShell.

```powershell
$env:RUNNEL_TEST_MONGODB_PORT = '37503'
npm run check:mongodb
Remove-Item Env:RUNNEL_TEST_MONGODB_PORT
```

The check creates two randomly named databases prefixed `runnel_check_`, uses
two synthetic credential entries and a private temporary catalog, then removes
them and stops its daemon. Cleanup is attempted after ordinary assertion or
connection failures too. Abrupt process termination can leave fixtures behind.
The check does not create or stop your MongoDB server.

Coverage includes explicit environment selection, ambiguous and inferred aliases,
offline discovery, list/describe/find/count/aggregate, file and stdin input,
canonical Int64 output and relaxed precision refusal, native cross-environment
scripts with BSON helpers, warm modules, entry-change refusal and reset, bounded
exports with overwrite refusal, and history omissions. No global installation or
publication occurs. Registration uses the installed internal setup helper, so
interactive hidden-input behavior is outside this check.

The check passed on Linux in WSL with MongoDB 8.0.32 and native Secret Service
storage. A separate Linux PTY check passed installed-CLI setup, hidden URI input,
manual alias registration, queries, declined saving and Ctrl+C during setup.
Native Windows CI covers package installation, process/file lifecycle,
and credential persistence. Native Windows MongoDB access, terminal setup and
Ctrl+C behavior still need testing on the work laptop. Permission-denial behavior
also needs an authenticated MongoDB integration fixture. `npm run verify` remains
independent of MongoDB and OS credential configuration.
