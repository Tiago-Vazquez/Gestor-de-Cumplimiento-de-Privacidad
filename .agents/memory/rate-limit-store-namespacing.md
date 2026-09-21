---
name: Rate limit store namespacing
description: Why the persistent rate limit store must namespace its keys per limiter.
---

When a custom `Store` is shared by several `express-rate-limit` limiters in this repo (`artifacts/api-server/src/lib/rate-limit-store.ts`), every key must be prefixed with a per-limiter namespace (`optionalPersistentStore("login")`).

**Why:** MemoryStore (the default) gives each limiter its own map, so identical `keyGenerator` output never collides. The PostgreSQL store shares one `rate_limit_hits` table: `registerLimiter` and `loginLimiter` both build `${ip}:${email}`, so a signup consumed one of the 5 login attempts per 15 min and the fifth login already returned 429. `resetAll` must also be scoped by prefix, otherwise it wipes other limiters' buckets.

**How to apply:** Always pass a namespace when constructing the store; keep each limiter's namespace stable (it is part of the persisted key and visible in `rate_limit_hits.key`). When adding a new limited endpoint, add its own namespace instead of reusing an existing prefix.