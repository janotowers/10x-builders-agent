<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing new code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Operational cases & tool provisioning (web)

- **Tool readiness:** `apps/web/src/app/api/tool-readiness/route.ts` — `GET ?case_type_id=…` (auth).
- **Per-account secrets:** `apps/web/src/app/api/account-tool-secrets/` — list, upsert by provider, test connection.
- **Global tool requests:** `apps/web/src/app/api/global-tool-requests/route.ts`.
- **Operational case tests:** `apps/web/src/app/api/operational-case-tests/` and `…/run/`.
- **Shared UI:** `apps/web/src/components/account-tool-connection-form.tsx`, provider spec `apps/web/src/lib/account-tool-providers.ts`.
- **Docs:** `docs/operational-cases/architecture.md` §10, `docs/manuals/architecture-manual.md` (Casos operacionales / tools).
