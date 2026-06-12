create extension if not exists pgcrypto;

create schema if not exists app_private;

create table if not exists public.plans (
  tier text primary key check (tier in ('free', 'pro')),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.plan_features (
  plan_tier text not null references public.plans(tier) on delete cascade,
  feature_key text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (plan_tier, feature_key)
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text check (role in ('client', 'provider')),
  full_name text,
  headline text,
  bio text,
  location text,
  avatar_url text,
  is_onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_plan_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  plan_tier text not null references public.plans(tier) default 'free',
  status text not null default 'active',
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_profiles (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  categories text[] not null default '{}',
  hourly_rate_cents integer not null default 0 check (hourly_rate_cents >= 0),
  availability jsonb not null default '{}'::jsonb,
  priority_placement boolean not null default false,
  stripe_onboarding_complete boolean not null default false,
  searchable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'usd',
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'scheduled', 'completed', 'cancelled')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid', 'refunded', 'failed')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end > scheduled_start)
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  client_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (booking_id, client_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.profiles(id) on delete cascade,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.bookings(id) on delete set null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (client_id, provider_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.billing_customers (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null unique,
  stripe_price_id text,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_payout_accounts (
  provider_id uuid primary key references public.profiles(id) on delete cascade,
  stripe_account_id text not null unique,
  onboarding_complete boolean not null default false,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  type text not null,
  status text not null default 'processing'
    check (status in ('processing', 'processed', 'failed')),
  payload jsonb not null,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.server_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create index if not exists provider_profiles_priority_idx
  on public.provider_profiles (priority_placement desc, hourly_rate_cents asc);
create index if not exists bookings_client_idx on public.bookings (client_id);
create index if not exists bookings_provider_idx on public.bookings (provider_id);
create index if not exists conversations_client_idx on public.conversations (client_id);
create index if not exists conversations_provider_idx on public.conversations (provider_id);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop function if exists public.user_has_feature(uuid, text);

create or replace function public.user_has_feature(check_user_id uuid, check_feature_key text)
returns boolean
language sql
stable
as $$
  select coalesce(pf.enabled, false)
  from public.user_plan_state ups
  join public.plan_features pf on pf.plan_tier = ups.plan_tier
  where ups.user_id = check_user_id
    and pf.feature_key = check_feature_key
    and (
      ups.plan_tier = 'free'
      or ups.status in ('active', 'trialing')
    )
  limit 1;
$$;

create or replace function app_private.sync_provider_priority()
returns trigger
language plpgsql
as $$
begin
  update public.provider_profiles
  set
    priority_placement = (
      new.plan_tier = 'pro'
      and new.status in ('active', 'trialing')
    ),
    updated_at = now()
  where profile_id = new.user_id;

  return new;
end;
$$;

create or replace function app_private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, app_private
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.user_plan_state (user_id, plan_tier, status)
  values (new.id, 'free', 'active')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function app_private.touch_updated_at();

drop trigger if exists user_plan_state_touch_updated_at on public.user_plan_state;
create trigger user_plan_state_touch_updated_at
before update on public.user_plan_state
for each row execute function app_private.touch_updated_at();

drop trigger if exists provider_profiles_touch_updated_at on public.provider_profiles;
create trigger provider_profiles_touch_updated_at
before update on public.provider_profiles
for each row execute function app_private.touch_updated_at();

drop trigger if exists bookings_touch_updated_at on public.bookings;
create trigger bookings_touch_updated_at
before update on public.bookings
for each row execute function app_private.touch_updated_at();

drop trigger if exists billing_customers_touch_updated_at on public.billing_customers;
create trigger billing_customers_touch_updated_at
before update on public.billing_customers
for each row execute function app_private.touch_updated_at();

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
before update on public.subscriptions
for each row execute function app_private.touch_updated_at();

drop trigger if exists provider_payout_accounts_touch_updated_at on public.provider_payout_accounts;
create trigger provider_payout_accounts_touch_updated_at
before update on public.provider_payout_accounts
for each row execute function app_private.touch_updated_at();

drop trigger if exists sync_provider_priority_on_plan on public.user_plan_state;
create trigger sync_provider_priority_on_plan
after insert or update of plan_tier, status on public.user_plan_state
for each row execute function app_private.sync_provider_priority();

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function app_private.handle_new_user();

insert into public.plans (tier, name)
values
  ('free', 'Free Plan'),
  ('pro', 'Pro Plan')
on conflict (tier) do update set name = excluded.name;

insert into public.plan_features (plan_tier, feature_key, enabled)
values
  ('free', 'browse_profiles', true),
  ('free', 'submit_reviews', true),
  ('free', 'schedule_bookings', false),
  ('free', 'in_app_payments', false),
  ('free', 'direct_messaging', false),
  ('free', 'priority_placement', false),
  ('free', 'enhanced_filters', false),
  ('free', 'availability_calendar', false),
  ('pro', 'browse_profiles', true),
  ('pro', 'submit_reviews', true),
  ('pro', 'schedule_bookings', true),
  ('pro', 'in_app_payments', true),
  ('pro', 'direct_messaging', true),
  ('pro', 'priority_placement', true),
  ('pro', 'enhanced_filters', true),
  ('pro', 'availability_calendar', true)
on conflict (plan_tier, feature_key)
do update set enabled = excluded.enabled;

alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.profiles enable row level security;
alter table public.user_plan_state enable row level security;
alter table public.provider_profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.reviews enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.provider_payout_accounts enable row level security;
alter table public.stripe_webhook_events enable row level security;
alter table public.server_secrets enable row level security;

drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans
for select to anon, authenticated
using (true);

drop policy if exists plan_features_read on public.plan_features;
create policy plan_features_read on public.plan_features
for select to anon, authenticated
using (true);

drop policy if exists profiles_read_authenticated on public.profiles;
create policy profiles_read_authenticated on public.profiles
for select to authenticated
using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert to authenticated
with check ((select auth.uid()) = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists user_plan_state_read_own on public.user_plan_state;
create policy user_plan_state_read_own on public.user_plan_state
for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists provider_profiles_read_authenticated on public.provider_profiles;
create policy provider_profiles_read_authenticated on public.provider_profiles
for select to authenticated
using (searchable = true or (select auth.uid()) = profile_id);

drop policy if exists provider_profiles_insert_own_provider on public.provider_profiles;
create policy provider_profiles_insert_own_provider on public.provider_profiles
for insert to authenticated
with check (
  (select auth.uid()) = profile_id
  and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'provider'
  )
);

drop policy if exists provider_profiles_update_own_provider on public.provider_profiles;
create policy provider_profiles_update_own_provider on public.provider_profiles
for update to authenticated
using ((select auth.uid()) = profile_id)
with check ((select auth.uid()) = profile_id);

drop policy if exists bookings_read_participants on public.bookings;
create policy bookings_read_participants on public.bookings
for select to authenticated
using (
  (select auth.uid()) = client_id
  or (select auth.uid()) = provider_id
);

drop policy if exists reviews_read_authenticated on public.reviews;
create policy reviews_read_authenticated on public.reviews
for select to authenticated
using (true);

drop policy if exists reviews_insert_after_completed_booking on public.reviews;
create policy reviews_insert_after_completed_booking on public.reviews
for insert to authenticated
with check (
  (select auth.uid()) = client_id
  and public.user_has_feature((select auth.uid()), 'submit_reviews')
  and exists (
    select 1
    from public.bookings b
    where b.id = booking_id
      and b.client_id = (select auth.uid())
      and b.provider_id = reviews.provider_id
      and b.status = 'completed'
      and b.payment_status = 'paid'
  )
);

drop policy if exists conversations_read_participants on public.conversations;
create policy conversations_read_participants on public.conversations
for select to authenticated
using (
  (select auth.uid()) = client_id
  or (select auth.uid()) = provider_id
);

drop policy if exists conversations_insert_pro_participant on public.conversations;
create policy conversations_insert_pro_participant on public.conversations
for insert to authenticated
with check (
  public.user_has_feature((select auth.uid()), 'direct_messaging')
  and (
    (select auth.uid()) = client_id
    or (select auth.uid()) = provider_id
  )
);

drop policy if exists conversations_update_participants on public.conversations;
create policy conversations_update_participants on public.conversations
for update to authenticated
using (
  (select auth.uid()) = client_id
  or (select auth.uid()) = provider_id
)
with check (
  (select auth.uid()) = client_id
  or (select auth.uid()) = provider_id
);

drop policy if exists messages_read_conversation_participants on public.messages;
create policy messages_read_conversation_participants on public.messages
for select to authenticated
using (
  exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and ((select auth.uid()) = c.client_id or (select auth.uid()) = c.provider_id)
  )
);

drop policy if exists messages_insert_conversation_participants on public.messages;
create policy messages_insert_conversation_participants on public.messages
for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and public.user_has_feature((select auth.uid()), 'direct_messaging')
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and ((select auth.uid()) = c.client_id or (select auth.uid()) = c.provider_id)
  )
);

drop policy if exists subscriptions_read_own on public.subscriptions;
create policy subscriptions_read_own on public.subscriptions
for select to authenticated
using ((select auth.uid()) = user_id);

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema app_private to service_role;
grant select on public.plans, public.plan_features to anon, authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.provider_profiles to authenticated;
grant select on public.user_plan_state to authenticated;
grant select on public.bookings to authenticated;
grant select, insert on public.reviews to authenticated;
grant select, insert, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant select on public.subscriptions to authenticated;
grant all on all tables in schema public to service_role;
grant execute on function public.user_has_feature(uuid, text) to authenticated, service_role;

do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
