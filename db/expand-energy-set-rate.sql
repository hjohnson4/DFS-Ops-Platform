-- DFS Ops — set day rate for Expand Energy (EDC 405, EDC 406)
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to run again.
--
-- 1) Adds a billing-mode setting to jobs:
--      report_days    = one day per daily report received on/after spud (Verdun — unchanged)
--      spud_to_latest = every day from the spud date (AU6) through the latest report date
-- 2) Turns set day rate ON for EDC 405 and EDC 406 (Expand Energy) with spud_to_latest.
--    Their saved day rate ($1,725.00) is what bills. Change it on the job page if needed.

alter table public.jobs
  add column if not exists manual_billing_mode text not null default 'report_days';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'jobs_manual_billing_mode_check'
  ) then
    alter table public.jobs
      add constraint jobs_manual_billing_mode_check
      check (manual_billing_mode in ('report_days', 'spud_to_latest'));
  end if;
end $$;

update public.jobs
set manual_day_rate = true,
    manual_billing_mode = 'spud_to_latest'
where id in (
  select j.id from public.jobs j
  join public.customers c on c.id = j.customer_id
  where c.name ilike 'Expand Energy%' and j.job_number in ('EDC 405', 'EDC 406')
);

notify pgrst, 'reload schema';

-- Check: should list Cactus 159 and Patterson 260 (report_days)
-- and EDC 405 and EDC 406 (spud_to_latest)
select j.job_number, c.name as customer, j.status, j.day_rate, j.manual_day_rate, j.manual_billing_mode
from public.jobs j join public.customers c on c.id = j.customer_id
where j.manual_day_rate = true order by j.job_number;
