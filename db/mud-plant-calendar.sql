-- Mud Plant billing calendar & daily centrifuge hours
-- Run once in the Supabase SQL editor BEFORE pushing the code.
-- Safe to run more than once.

-- 1) Billing mode "calendar" + billing start date on jobs
alter table public.jobs add column if not exists manual_billing_mode text not null default 'report_days';
alter table public.jobs drop constraint if exists jobs_manual_billing_mode_check;
alter table public.jobs add constraint jobs_manual_billing_mode_check
  check (manual_billing_mode in ('report_days', 'spud_to_latest', 'calendar'));
alter table public.jobs add column if not exists billing_start_date date;

-- 2) Days switched on/off (only days that were changed are stored;
--    every other day from the start date bills)
create table if not exists public.job_billing_days (
  job_id uuid not null references public.jobs(id) on delete cascade,
  day date not null,
  billing boolean not null,
  note text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz not null default now(),
  primary key (job_id, day)
);
alter table public.job_billing_days enable row level security;

-- 3) History of every change (day switches and start-date changes)
create table if not exists public.job_billing_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  kind text not null check (kind in ('day', 'start')),
  day date,
  billing boolean,
  start_date date,
  note text,
  changed_by uuid,
  changed_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists job_billing_events_job_idx on public.job_billing_events (job_id, created_at desc);
alter table public.job_billing_events enable row level security;

-- 4) Hand-entered centrifuge hours (no daily report behind them)
alter table public.asset_run_hours alter column daily_report_id drop not null;
alter table public.asset_run_hours add column if not exists source text not null default 'report';
alter table public.asset_run_hours add column if not exists entered_by uuid;
alter table public.asset_run_hours add column if not exists entered_by_name text;
create unique index if not exists asset_run_hours_manual_day_key
  on public.asset_run_hours (asset_id, job_id, report_date)
  where daily_report_id is null;

-- 5) Turn it on for the TGNR Mud Plant job, billing from 10/1/2026
update public.jobs
   set manual_day_rate = true,
       manual_billing_mode = 'calendar',
       billing_start_date = coalesce(billing_start_date, date '2026-10-01')
 where id = 'c0bb294a-517a-4b8d-a1c9-b3a491aba298';

notify pgrst, 'reload schema';

-- Check: should show one row, calendar, 2026-10-01, 6022.00
select job_number, manual_day_rate, manual_billing_mode, billing_start_date, day_rate
  from public.jobs where id = 'c0bb294a-517a-4b8d-a1c9-b3a491aba298';
