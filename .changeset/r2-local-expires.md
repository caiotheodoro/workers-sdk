---
"wrangler": patch
---

Parse `--expires` correctly for local R2 object uploads

Previously, `wrangler r2 object put --local` and `wrangler r2 bulk put --local` passed `--expires` through `parseInt()`. HTTP-date strings became `NaN` and failed with a cache expiry type error, while ISO dates were truncated to their leading digits and stored near the Unix epoch. Local uploads now parse HTTP-date and ISO 8601 values as dates while continuing to accept integer epoch milliseconds.
