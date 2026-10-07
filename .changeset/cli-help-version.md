---
"@abijith-suresh/runnel": patch
---

Implement CLI help and version flags, with help shown when no arguments are given.
Read the version from the installed package metadata. Reject unsupported commands
and arguments with a concise stderr diagnostic and nonzero exit status.
