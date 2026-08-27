-- DFS Ops — in-app centrifuge service report form
-- Additive, non-destructive migration. All new columns are nullable and the
-- new foreign key is nullable with ON DELETE CASCADE, so existing rows and
-- existing features are unaffected. Safe to run once in the Supabase SQL editor.

-- Structured service-report fields on the maintenance_reports table.
ALTER TABLE public.maintenance_reports
  ADD COLUMN IF NOT EXISTS checklist      jsonb,
  ADD COLUMN IF NOT EXISTS run_hours      integer,
  ADD COLUMN IF NOT EXISTS work_performed text,
  ADD COLUMN IF NOT EXISTS score_pass     integer,
  ADD COLUMN IF NOT EXISTS score_total    integer,
  ADD COLUMN IF NOT EXISTS flagged_count  integer;

-- Link inspection photos to the service report they belong to.
ALTER TABLE public.maintenance_report_files
  ADD COLUMN IF NOT EXISTS report_id uuid
  REFERENCES public.maintenance_reports (id) ON DELETE CASCADE;

-- Helpful index for fetching a report's photos.
CREATE INDEX IF NOT EXISTS maintenance_report_files_report_id_idx
  ON public.maintenance_report_files (report_id);
