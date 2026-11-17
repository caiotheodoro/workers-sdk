---
"@cloudflare/autoconfig": minor
"@cloudflare/codemods": patch
---

Export the Wrangler configuration migration from autoconfig

`@cloudflare/autoconfig` now exports `migrateWranglerToCf`, and the in-memory `convertWranglerConfig` from `@cloudflare/autoconfig/wrangler-to-cf`, so that every project setup path can share one migration. `@cloudflare/codemods` runs `wrangler-to-cf` through them, and `@cloudflare/codemods/wrangler-to-cf` re-exports the converter.
