---
"@abijith-suresh/runnel": patch
---

Add attached CLI script execution with plain JSON inline/file/stdin arguments, catalog deadline defaults and duration overrides, bounded JSON/EJSON output, and cancellation without replay. Removing a queued caller preserves active work; interrupting or disconnecting an active script stops its worker and discards the queue. Keep long and disabled deadlines free of transport response timeouts.
