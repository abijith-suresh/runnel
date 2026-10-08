# @abijith-suresh/runnel

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
