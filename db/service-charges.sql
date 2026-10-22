-- DFS Ops — Service charges on any job (2026-10-22)
-- Run once in the Supabase SQL editor BEFORE pushing the app update.
-- Safe to run more than once.

-- 1) Allow the new "Service Charge" type alongside Drive-by / Call-out.
alter table public.job_services drop constraint if exists job_services_service_type_check;
alter table public.job_services
  add constraint job_services_service_type_check
  check (service_type in ('Service Charge', 'Drive-by Service', 'Call-out Service'));

-- 2) Optional piece of equipment the service was for.
alter table public.job_services
  add column if not exists asset_id uuid references public.assets(id) on delete set null;

-- 3) Faster area / recent lookups for the notification bell.
create index if not exists job_services_area_created_idx
  on public.job_services (area, created_at desc);
create index if not exists job_services_job_idx
  on public.job_services (job_id, service_date desc);

-- Check: should list the three types and show the asset_id column.
select pg_get_constraintdef(oid) as allowed_types
  from pg_constraint where conname = 'job_services_service_type_check';
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'job_services' and column_name = 'asset_id';
