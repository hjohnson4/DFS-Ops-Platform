-- DFS Ops — Forecast tables (run once in the Supabase SQL editor)
create table if not exists public.forecast_jobs (
  id uuid primary key default gen_random_uuid(),
  rig text not null,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text,
  area ops_area not null,
  stage text not null default 'Bid'
    check (stage in ('Bid','Likely','Awarded','Converted','Lost')),
  odds int not null default 25 check (odds between 0 and 100),
  start_on date not null,
  end_on date,                       -- empty = indefinite
  day_rate numeric,
  big_bowl_needed int not null default 0,
  small_bowl_needed int not null default 0,
  notes text,
  converted_job_id uuid references public.jobs(id) on delete set null,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on is null or end_on >= start_on)
);

create table if not exists public.forecast_units (
  forecast_job_id uuid not null references public.forecast_jobs(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  primary key (forecast_job_id, asset_id)
);
create index if not exists forecast_units_asset_idx on public.forecast_units(asset_id);

-- Planned release date for active jobs (empty = indefinite)
alter table public.jobs add column if not exists est_release_on date;

-- Bid PDFs for upcoming jobs. When a bid is converted, job_id is filled in so
-- the documents stay with the real job.
create table if not exists public.bid_documents (
  id uuid primary key default gen_random_uuid(),
  forecast_job_id uuid references public.forecast_jobs(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  area ops_area not null,
  file_name text not null,
  file_mime text not null default 'application/pdf',
  file_size int not null default 0,
  file_base64 text not null,
  uploaded_by uuid,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);
create index if not exists bid_documents_forecast_idx on public.bid_documents(forecast_job_id);
create index if not exists bid_documents_job_idx on public.bid_documents(job_id);

-- Refresh the API so the new tables show up right away
notify pgrst, 'reload schema';
