# @abijith-suresh/runnel

## 0.0.6

### Patch Changes

- 9c7c392: Add an optional installed-package MongoDB smoke check and a local testing guide.
- f2a020d: Add a local tarball installation command with overwrite protection and Linux/Windows usage instructions.
- c54f45b: Invoke npm helpers through Node for Windows portability and require native Windows build, package, lifecycle, and synthetic credential-storage checks in CI. Treat native null and undefined password results as missing credentials.
- @abijith-suresh/runnel-core@0.0.6
  - @abijith-suresh/runnel-mongodb@0.0.6

## 0.0.5

### Patch Changes

- a918f7e: Add attached CLI script execution with plain JSON inline/file/stdin arguments, catalog deadline defaults and duration overrides, bounded JSON/EJSON output, and cancellation without replay. Removing a queued caller preserves active work; interrupting or disconnecting an active script stops its worker and discards the queue. Keep long and disabled deadlines free of transport response timeouts.
- b821c0d: Add bounded JSON/EJSON exports to new files, with query options, explicit truncation, and atomic creation that preserves existing destinations.
- 583e8e5: Add an internal persistent-worker JavaScript runner with native database handles, cross-environment connects, plain JSON arguments, BSON helpers, bounded JSON/EJSON results, sanitized errors, explicit deadlines, and reset requirements for edited entry scripts. Record one private history entry per script operation.
- @abijith-suresh/runnel-core@0.0.5
  - @abijith-suresh/runnel-mongodb@0.0.5

## 0.0.4

### Patch Changes

- fc6c78a: Add interactive setup with hidden MongoDB URI input, accessible database discovery, manual alias selection, and atomic registration backed by OS credential storage. Preserve existing names and remove new credentials when catalog commits fail.
- d06bf8b: Add describe, find, count, and aggregate commands through the persistent worker. Support bounded inline/file/stdin JSON and EJSON inputs, explicit result truncation, canonical BSON output, safe relaxed Int64 handling, and structured driver errors with cursor cleanup.
- 5b81f32: Record bounded local database operation history by default, using configured target names and sanitized outcomes only. Add offline history inspection, a catalog opt-out setting, atomic private storage, and warnings that preserve database results when history cannot be saved.
- @abijith-suresh/runnel-core@0.0.4
  - @abijith-suresh/runnel-mongodb@0.0.4

## 0.0.3

### Patch Changes

- 41df4a3: Add serialized atomic catalog updates and native OS credential storage for future
  human setup. Keep connection secrets out of catalog files and sanitize storage errors.
- 533aa87: Start a user-wide local daemon for collection listing and add daemon status, reset, and stop commands. Preserve one persistent worker, prevent idle shutdown during active or queued work, and never replay an operation after a lost result.
- d17baf9: Add reusable MongoDB connection pools and an internal persistent worker with serial operation queueing, bounded IPC, deadlines, and reset without replay. Keep setup and database CLI commands planned.
- Updated dependencies [d17baf9]
  - @abijith-suresh/runnel-mongodb@0.0.3
  - @abijith-suresh/runnel-core@0.0.3

## 0.0.2

### Patch Changes

- bf53704: Read and validate a user-wide catalog and list configured environments, connections,
  and database aliases offline. Discovery omits credential references and returns JSON results.
- 14559f7: Implement CLI help and version flags, with help shown when no arguments are given.
  Read the version from the installed package metadata. Reject unsupported commands
  and arguments with a concise stderr diagnostic and nonzero exit status.
- ce5b6c6: Add pure database target selection. Require an explicit environment, validate
  database aliases within that environment, and infer a database only when exactly
  one alias exists. Return typed selection failures without database or catalog I/O.
  
  Isolate release-policy fixtures from inherited Git hook variables so verification
  in a worktree cannot change the caller's repository metadata.
- Updated dependencies [ce5b6c6]
  - @abijith-suresh/runnel-core@0.0.2
  - @abijith-suresh/runnel-mongodb@0.0.2
