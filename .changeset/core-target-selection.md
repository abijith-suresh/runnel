---
"@abijith-suresh/runnel-core": patch
---

Add pure database target selection. Require an explicit environment, validate
database aliases within that environment, and infer a database only when exactly
one alias exists. Return typed selection failures without database or catalog I/O.
