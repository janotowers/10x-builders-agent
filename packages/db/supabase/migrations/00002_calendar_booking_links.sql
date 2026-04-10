-- Public booking links for Google Calendar FreeBusy (token is opaque; access via service role in API only for guests)
create table public.calendar_booking_links (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  token       text not null unique,
  calendar_id text not null default 'primary',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index calendar_booking_links_token_idx on public.calendar_booking_links (token);

alter table public.calendar_booking_links enable row level security;

create policy "Users can manage own booking links"
  on public.calendar_booking_links for all
  using (auth.uid() = user_id);
