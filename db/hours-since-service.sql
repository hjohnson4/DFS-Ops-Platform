-- DFS Ops — hours since service: run-hours log
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to run again: it never duplicates rows.
--
-- 1) Creates asset_run_hours: one row per centrifuge per signed-off daily report,
--    with the job, well, report date and hours that report added.
-- 2) Fills it in from the daily reports that have already added run hours:
--    a) first from each report's activity log ("Run hours applied: CTF-103 +24 hrs"),
--       which records exactly which unit got which hours at sign-off;
--    b) then, for reports with no such log line, using the sign-off rule with the
--       centrifuges on that job today (one centrifuge = the day's hours; two =
--       each unit's own Centrifuge 1 / Centrifuge 2 hours).
-- It does NOT change any asset's run-hours meter.

create table if not exists public.asset_run_hours (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  daily_report_id uuid not null references public.daily_reports(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  well_name text,
  report_date date,
  hours numeric not null check (hours >= 0),
  created_at timestamptz not null default now(),
  unique (asset_id, daily_report_id)
);
create index if not exists asset_run_hours_asset_idx on public.asset_run_hours (asset_id, report_date);
create index if not exists asset_run_hours_job_idx on public.asset_run_hours (job_id);

-- 2a) From the activity log.
insert into public.asset_run_hours (asset_id, daily_report_id, job_id, well_name, report_date, hours)
select a.id, d.id, d.job_id, d.well_name, d.report_date, max(m[2]::numeric)
from public.daily_report_events e
join public.daily_reports d on d.id = e.report_id
cross join lateral regexp_matches(e.detail, '([A-Za-z]+-\s?[0-9]+) \+([0-9]+(?:\.[0-9]+)?) hrs', 'g') m
join public.assets a on a.tag = m[1]
where e.detail ilike '%Run hours applied%' and d.run_hours_applied = true
group by a.id, d.id, d.job_id, d.well_name, d.report_date
on conflict (asset_id, daily_report_id) do nothing;

-- 2b) Reports that added run hours but have no log line.
with rep as (
  select d.id, d.job_id, d.well_name, d.report_date,
    case when d.kpis->>'daily_run_hours' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (d.kpis->>'daily_run_hours')::numeric end as daily,
    case when d.kpis->>'daily_run_hours_cent1' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (d.kpis->>'daily_run_hours_cent1')::numeric end as c1,
    case when d.kpis->>'daily_run_hours_cent2' ~ '^\s*[0-9]+(\.[0-9]+)?\s*$' then (d.kpis->>'daily_run_hours_cent2')::numeric end as c2
  from public.daily_reports d
  where d.run_hours_applied = true and d.job_id is not null
    and not exists (select 1 from public.asset_run_hours l where l.daily_report_id = d.id)
),
cents as (
  select a.id as asset_id, a.job_id, a.centrifuge_slot,
         count(*) over (partition by a.job_id) as n,
         bool_and(coalesce(a.centrifuge_slot in (1, 2), false)) over (partition by a.job_id) as all_mapped
  from public.assets a
  where a.category::text in ('Big Bowl Centrifuge', 'Small Bowl Centrifuge') and a.job_id is not null
),
alloc as (
  select c.asset_id, r.id as daily_report_id, r.job_id, r.well_name, r.report_date,
    case
      when c.n = 1 then coalesce(r.daily, r.c1)
      when c.all_mapped and c.centrifuge_slot = 1 then coalesce(r.c1, r.daily)
      when c.all_mapped and c.centrifuge_slot = 2 then r.c2
    end as hours
  from rep r join cents c on c.job_id = r.job_id
)
insert into public.asset_run_hours (asset_id, daily_report_id, job_id, well_name, report_date, hours)
select asset_id, daily_report_id, job_id, well_name, report_date, hours
from alloc where hours is not null and hours > 0
on conflict (asset_id, daily_report_id) do nothing;

-- Make the new table visible to the app right away.
notify pgrst, 'reload schema';

-- Check: hours logged per centrifuge
select a.tag, count(l.*) as report_days, sum(l.hours) as logged_hours, a.run_hours as meter
from public.asset_run_hours l join public.assets a on a.id = l.asset_id
group by a.tag, a.run_hours order by a.tag;
