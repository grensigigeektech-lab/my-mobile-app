create index if not exists conversations_booking_idx
  on public.conversations (booking_id);
create index if not exists messages_sender_idx
  on public.messages (sender_id);
create index if not exists reviews_client_idx
  on public.reviews (client_id);
create index if not exists reviews_provider_idx
  on public.reviews (provider_id);
create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);
create index if not exists user_plan_state_plan_tier_idx
  on public.user_plan_state (plan_tier);

drop policy if exists billing_customers_no_client_access on public.billing_customers;
create policy billing_customers_no_client_access on public.billing_customers
for all to anon, authenticated
using (false)
with check (false);

drop policy if exists provider_payout_accounts_no_client_access on public.provider_payout_accounts;
create policy provider_payout_accounts_no_client_access on public.provider_payout_accounts
for all to anon, authenticated
using (false)
with check (false);

drop policy if exists server_secrets_no_client_access on public.server_secrets;
create policy server_secrets_no_client_access on public.server_secrets
for all to anon, authenticated
using (false)
with check (false);

drop policy if exists stripe_webhook_events_no_client_access on public.stripe_webhook_events;
create policy stripe_webhook_events_no_client_access on public.stripe_webhook_events
for all to anon, authenticated
using (false)
with check (false);

create or replace function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = app_private, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.user_has_feature(check_user_id uuid, check_feature_key text)
returns boolean
language sql
stable
set search_path = public
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
set search_path = public, app_private
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

grant execute on function public.user_has_feature(uuid, text) to authenticated, service_role;
