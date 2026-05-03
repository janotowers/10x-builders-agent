# Supabase Postgres connection (LangGraph checkpointer)

LangGraph's `PostgresSaver` is what lets HITL approvals (calendar create
event, archive memory, etc.) **resume** the agent run after the user
clicks Approve. When it can't connect, the runtime falls back to
`MemorySaver`, which loses the checkpoint as soon as the dev process
restarts or hot-reloads. That makes HITL fragile and can make it look
like an approve "did nothing".

## Symptom

Logs show repeatedly:

```
[checkpointer] PostgresSaver failed to connect host=db.<ref>.supabase.co port=6543 code=ETIMEDOUT address=2600:1f18:...:... — falling back to MemorySaver
```

The `address=2600:...` is an IPv6 address. Local dev networks (Windows /
WSL / corporate Wi-Fi / many home ISPs) usually do **not** route IPv6 to
AWS, so the TCP connect just hangs until `ETIMEDOUT`.

In current Supabase projects, the *direct* host
`db.<ref>.supabase.co` only resolves to AAAA records (IPv4 is an add-on).
That's why even `dns.setDefaultResultOrder('ipv4first')` does not help:
there's no A record to fall back to.

## Fix: use the Supabase **Session Pooler**

Supabase offers two pooler endpoints that **do** publish IPv4:

| Endpoint           | Host pattern                                | Port | Good for                                  |
| ------------------ | ------------------------------------------- | ---- | ----------------------------------------- |
| Session Pooler     | `aws-0-<region>.pooler.supabase.com`        | 5432 | LangGraph checkpointer, prepared statements, anything stateful |
| Transaction Pooler | `aws-0-<region>.pooler.supabase.com`        | 6543 | Short serverless queries; **avoid** for the checkpointer |

For the checkpointer use the **Session Pooler (5432)**.

### Where to copy it from

Supabase Dashboard → Project Settings → Database → "Connection string"
section → tab **Session pooler**. Copy the URL. It looks like:

```
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Notice two differences vs. the direct connection:

- Username changes from `postgres` to `postgres.<ref>` (e.g.
  `postgres.bdaonfgippaoiwsbeapa`).
- Host changes from `db.<ref>.supabase.co` to
  `aws-0-<region>.pooler.supabase.com`.

### Update `.env.local`

In `apps/web/.env.local`:

```
DATABASE_URL=postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Restart `npm run dev`.

You should now see:

```
[checkpointer] PostgresSaver connected host=aws-0-<region>.pooler.supabase.com port=5432
```

…and HITL approvals (calendar, memory, etc.) will resume reliably across
hot reloads.

## If you see `Tenant or user not found`

This means the pooler endpoint was reached, but Supabase did not recognize
the tenant/user pair. Usually one of these is wrong:

- The host region was guessed (for example `aws-0-us-east-1...`) instead
  of copied from the dashboard.
- The username is still `postgres` instead of `postgres.<project-ref>`.
- The password belongs to another project.

Fix it by copying the **exact** "Session pooler" URL from Supabase
Dashboard → Project Settings → Database → Connection string. Do not infer
the region/host manually.

## Tunables

- `CHECKPOINTER_DNS_ORDER` — defaults to `ipv4first`. Leave as-is unless
  you know your network needs IPv6.
- `CHECKPOINTER_CONNECT_TIMEOUT_MS` — defaults to `5000`. We cap the
  initial connect attempt so we don't waste 30s every cold turn while
  Postgres is unreachable; the runtime still falls back to `MemorySaver`
  cleanly when it expires.
