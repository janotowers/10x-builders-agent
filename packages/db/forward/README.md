# Forward-only migration workdir (B′)

This directory is a **Supabase CLI workdir**. The CLI discovers migrations at
`<workdir>/supabase/migrations`, so pointing it here — `--workdir packages/db/forward`
— means it sees the forward era and **never** the frozen legacy chain.

## Why the two eras are separate

`packages/db/supabase/migrations` holds 87 historical files applied by hand to
deployed environments. Three numeric prefixes are duplicated (`00036`, `00044`,
`00045` — two files each). `supabase_migrations.schema_migrations` keys on
`version`, so two files sharing one can never both be recorded: a `db push`
over that directory aborts at the first duplicate with a primary-key violation,
and `migration repair` does not change that. Renumbering is not an option —
those files are already applied.

So the legacy era stays frozen and is applied by the ordered-apply bootstrap
path, and every future migration lives here with a globally unique
14-digit timestamp version that the CLI can record normally.

## No baseline

There is deliberately **no artificial baseline row**. A remote-only baseline
produces `Remote migration versions not found in local migrations directory`,
which is synthetic drift the CLI then polices forever.
`supabase_migrations.schema_migrations` is created by the **first genuine
post-cutover migration**. Until then this directory is legitimately empty.

## Ordering

14-digit timestamps sort lexicographically after every 5-digit legacy version
(`00001` … `00084` … `20260901120000`), so `legacy → forward` is a single
deterministic total order even across two directories.

## Creating and applying

```bash
npm run migration:new -- add_something          # creates a timestamped file here
npm run migrations:verify                       # structure + frozen-legacy integrity
npm run deliver:forward -- --env-file .env.staging.local   # dry-run by default
```

Never add files to the frozen legacy directory. `npm run validate:migrations`
enforces that by exact set and content hash.
