-- Job standby billing: equipment on location with no crew (no daily reports).
-- Each row is one standby period. end_date = the LAST standby day (null while
-- the job is still on standby). A job can have only one open period at a time.
create table if not exists public.job_standby_periods (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  rate numeric(12,2) not null check (rate > 0),
  start_date date not null,
  end_date date,
  ended_reason text check (ended_reason in ('report', 'manual')),
  created_by uuid references public.profiles(id) on delete set null,
  created_by_name text,
  ended_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists job_standby_periods_job_idx
  on public.job_standby_periods (job_id);

create unique index if not exists job_standby_periods_one_open
  on public.job_standby_periods (job_id) where end_date is null;

-- Same as job_rate_events: only the app's server (service key) reads/writes.
alter table public.job_standby_periods enable row level security;

notify pgrst, 'reload schema';
