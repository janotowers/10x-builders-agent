# Lab / ops scripts

One-shot helpers for controlled recovery — **not** used in production runtime.

## Ungga publish recovery (proven pattern)

When a case closed as `published` without Ungga `published_url`, or Ungga publish
failed with a pre-side-effect error (`*_not_called`), reuse the same CLI GU-ID:

1. **Reopen** (preserves draft / GU-ID, sets Ungga back to publish_pending):

```bash
RECOVERY_CASE_ID=<case-uuid> npx tsx --env-file=.env.local scripts/lab/recover-ungga-publish-case.ts
```

2. **Retry publish** (serialized runner + force retry when ledger allows):

```bash
RECOVERY_CASE_ID=<case-uuid> npx tsx --env-file=.env.local scripts/lab/retry-ungga-publish-case.ts
```

Optional env:

- `RECOVERY_USER_ID` — defaults to the case owner from DB.
- `RECOVERY_REASON` — passed to reopen audit event (recover script only).

Do **not** create a new Ungga draft or adopt EasyBroker-imported listings for recovery.
