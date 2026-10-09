-- DFS Ops — Rental centrifuges (run once in the Supabase SQL editor)
-- Safe to run more than once.

-- 1) Rental details on an asset
alter table public.assets add column if not exists is_rental boolean not null default false;
alter table public.assets add column if not exists rental_vendor text;          -- rental company
alter table public.assets add column if not exists rental_ref text;             -- their serial / reference #
alter table public.assets add column if not exists rental_monthly_rate numeric; -- what we pay per month
alter table public.assets add column if not exists rental_start date;           -- received (on rent)
alter table public.assets add column if not exists rental_end date;             -- returned (off rent); empty = still on rent
alter table public.assets add column if not exists rental_notes text;

-- 2) One-time rental charges (delivery, pickup, etc.)
create table if not exists public.rental_charges (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  charge_date date not null,
  description text not null,
  amount numeric not null check (amount >= 0),
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists rental_charges_asset_idx on public.rental_charges(asset_id);

-- 3) Which job each asset was on, day by day. Kept automatically by the
--    trigger below whenever an asset's job or day rate changes, so earnings
--    ("our day rate x days on a job") can be worked out later.
create table if not exists public.asset_job_stints (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  day_rate numeric,
  start_date date not null,
  end_date date,               -- empty = still on this job
  created_at timestamptz not null default now()
);
create index if not exists asset_job_stints_asset_idx on public.asset_job_stints(asset_id);

create or replace function public.track_asset_job_stint() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  today date := (now() at time zone 'America/Chicago')::date;
begin
  if tg_op = 'UPDATE'
     and old.job_id is not distinct from new.job_id
     and old.day_rate is not distinct from new.day_rate then
    return new;
  end if;
  update public.asset_job_stints
     set end_date = today
   where asset_id = new.id and end_date is null;
  if new.job_id is not null then
    insert into public.asset_job_stints (asset_id, job_id, day_rate, start_date)
    values (new.id, new.job_id, new.day_rate, today);
  end if;
  return new;
end $$;

drop trigger if exists assets_job_stint on public.assets;
create trigger assets_job_stint
  after insert or update of job_id, day_rate on public.assets
  for each row execute function public.track_asset_job_stint();

-- Start a record for every asset that's on a job right now (from today).
insert into public.asset_job_stints (asset_id, job_id, day_rate, start_date)
select a.id, a.job_id, a.day_rate, (now() at time zone 'America/Chicago')::date
  from public.assets a
 where a.job_id is not null
   and not exists (select 1 from public.asset_job_stints s where s.asset_id = a.id and s.end_date is null);

-- Refresh the API so the new columns and tables show up right away
notify pgrst, 'reload schema';

-- Check: should list the 3 new pieces
select
  (select count(*) from information_schema.columns where table_schema='public' and table_name='assets' and column_name like 'rental%') as rental_columns,
  (select count(*) from public.asset_job_stints where end_date is null) as open_job_records,
  (select count(*) from public.assets where job_id is not null) as assets_on_jobs;
