-- DFS Ops — set day rate jobs (Verdun Oil & Gas)
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to run again.
--
-- 1) Adds a "set day rate" switch to jobs. When it's on, the job bills its day rate
--    every Active day from its oldest daily report, instead of reading costs from
--    the daily report. Rig Move, On Hold and Completed days bill $0.
-- 2) Adds job_rate_events: a dated history of each change to the rate or status on
--    those jobs, so earlier days keep the rate and status they had.
-- 3) Turns the switch on for the two Verdun Oil & Gas jobs (Patterson 260, Cactus 159).

alter table public.jobs
  add column if not exists manual_day_rate boolean not null default false;

create table if not exists public.job_rate_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  effective_date date not null,
  day_rate numeric,
  status text not null,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists job_rate_events_job_idx on public.job_rate_events (job_id, effective_date, created_at);

update public.jobs
set manual_day_rate = true
where id in (
  select j.id from public.jobs j
  join public.customers c on c.id = j.customer_id
  where c.name ilike 'Verdun Oil%' and j.job_number in ('Patterson 260', 'Cactus 159')
);

notify pgrst, 'reload schema';

-- Check: should list Patterson 260 and Cactus 159 with manual_day_rate = true
select j.job_number, c.name as customer, j.status, j.day_rate, j.manual_day_rate
from public.jobs j join public.customers c on c.id = j.customer_id
where j.manual_day_rate = true order by j.job_number;
