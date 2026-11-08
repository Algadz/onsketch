-- OnSketch Pro: subscriptions sold through Lemon Squeezy.
-- Run after 0004 in the Supabase dashboard: SQL Editor → paste → Run.
-- Safe to run again.
--
-- account_plans (from 0002) holds each user's plan; only the service role
-- writes it: the lemonsqueezy-webhook Edge Function, on subscription
-- events. 'premium' is the database name of the Pro plan.
--  * New columns keep the subscription's state, so the app can show
--    "renews on …", "ends on …" and link to the customer portal.
--  * plan_of() also ends Pro by itself once a cancelled subscription's
--    end date has passed, in case the "expired" event is late or lost.
--  * billing_events keeps every webhook received (for support and
--    debugging); nobody but the service role can read it.

alter table public.account_plans add column if not exists status          text;     -- Lemon Squeezy: on_trial, active, paused, past_due, unpaid, cancelled, expired
alter table public.account_plans add column if not exists interval        text;     -- 'month' | 'year'
alter table public.account_plans add column if not exists renews_at       timestamptz;
alter table public.account_plans add column if not exists ends_at         timestamptz;
alter table public.account_plans add column if not exists portal_url      text;     -- Lemon Squeezy customer portal (manage, cancel, invoices)
alter table public.account_plans add column if not exists subscription_id text;
alter table public.account_plans add column if not exists customer_id     text;
alter table public.account_plans add column if not exists test_mode       boolean not null default false;

create or replace function public.plan_of(uid uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
             when plan = 'premium' and status = 'cancelled' and ends_at is not null and ends_at < now() then 'free'
             else plan
           end
      from public.account_plans where user_id = uid), 'free');
$$;

create table if not exists public.billing_events (
  id          bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  event_name  text,
  user_id     uuid,
  subscription_id text,
  test_mode   boolean,
  payload     jsonb not null
);
alter table public.billing_events enable row level security;
-- No policies: only the service role (the webhook) reads and writes it.
