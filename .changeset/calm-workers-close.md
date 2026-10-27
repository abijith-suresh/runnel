---
"@abijith-suresh/runnel": patch
---

Use bounded private IPC for normal worker cleanup on every platform, await adapter client close and actual child exit separately, fence late results, and retain forced no-replay cancellation for hung or broken workers. Preserve operation/history responses while daemon shutdown drains and test the installed production worker and adapter with synthetic driver I/O.
