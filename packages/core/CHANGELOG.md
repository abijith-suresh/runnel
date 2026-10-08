# @abijith-suresh/runnel-core

## 0.0.6

No changes in this release.

## 0.0.5

No changes in this release.

## 0.0.4

No changes in this release.

## 0.0.3

No changes in this release.

## 0.0.2

### Patch Changes

- ce5b6c6: Add pure database target selection. Require an explicit environment, validate
  database aliases within that environment, and infer a database only when exactly
  one alias exists. Return typed selection failures without database or catalog I/O.
  
  Isolate release-policy fixtures from inherited Git hook variables so verification
  in a worktree cannot change the caller's repository metadata.
