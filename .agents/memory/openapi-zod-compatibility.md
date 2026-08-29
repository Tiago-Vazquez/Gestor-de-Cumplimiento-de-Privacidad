---
name: OpenAPI integer compatibility
description: Compatibility constraint between this workspace's OpenAPI generator and its installed Zod runtime.
---

When defining numeric fields in OpenAPI for this workspace, prefer `type: number` unless integer-specific validation is essential.

**Why:** The current generated Zod runtime is Zod 3, while the generator can emit `z.int()` for OpenAPI integer fields; that output does not typecheck.

**How to apply:** If integer semantics matter, enforce them in route validation or domain logic while keeping the generated schema compatible.