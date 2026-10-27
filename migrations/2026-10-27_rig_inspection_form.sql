-- DFS Ops — in-app rig inspection (rig-up report form)
-- Additive and safe to run more than once. Existing uploaded rig-up reports
-- are untouched (they become kind = 'upload').

-- 1) Inspection fields on rig_up_reports.
ALTER TABLE public.rig_up_reports
  ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS site_conducted text,
  ADD COLUMN IF NOT EXISTS rig_number     text,
  ADD COLUMN IF NOT EXISTS conducted_on   text,
  ADD COLUMN IF NOT EXISTS prepared_by    text,
  ADD COLUMN IF NOT EXISTS checklist      jsonb,
  ADD COLUMN IF NOT EXISTS score_pass     integer,
  ADD COLUMN IF NOT EXISTS score_total    integer,
  ADD COLUMN IF NOT EXISTS flagged_count  integer;

-- An in-app inspection has no uploaded file.
ALTER TABLE public.rig_up_reports ALTER COLUMN attachment_name   DROP NOT NULL;
ALTER TABLE public.rig_up_reports ALTER COLUMN attachment_base64 DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.rig_up_reports
    ADD CONSTRAINT rig_up_reports_kind_check CHECK (kind IN ('upload', 'inspection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Photos attached to a rig inspection.
CREATE TABLE IF NOT EXISTS public.rig_up_report_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rig_up_id   uuid NOT NULL REFERENCES public.rig_up_reports (id) ON DELETE CASCADE,
  file_name   text NOT NULL,
  file_mime   text NOT NULL,
  file_size   integer,
  file_base64 text NOT NULL,
  caption     text,
  uploaded_by uuid REFERENCES public.profiles (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rig_up_report_photos_rig_up_id_idx
  ON public.rig_up_report_photos (rig_up_id);

-- Check: should list the new columns.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'rig_up_reports'
  AND column_name IN ('kind','site_conducted','rig_number','conducted_on','prepared_by','checklist','score_pass','score_total','flagged_count')
ORDER BY column_name;
