-- ============================================================
-- telegram_webhook_updates (idempotency ledger)
-- ============================================================
create table if not exists public.telegram_webhook_updates (
  update_id     bigint primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  chat_id       bigint not null,
  message_id    bigint,
  status        text not null default 'processing'
    check (status in ('processing', 'completed')),
  turn_id       uuid,
  claimed_at    timestamptz not null default now(),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_telegram_webhook_updates_user_id
  on public.telegram_webhook_updates(user_id);

create index if not exists idx_telegram_webhook_updates_status_claimed
  on public.telegram_webhook_updates(status, claimed_at desc);

alter table public.telegram_webhook_updates enable row level security;

create policy "Users can manage own telegram webhook updates"
  on public.telegram_webhook_updates for all
  using (auth.uid() = user_id);
