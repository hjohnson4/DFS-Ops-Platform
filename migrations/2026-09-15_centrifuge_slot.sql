-- Two-centrifuge run-hours tracking.
-- Adds a per-asset "centrifuge slot" so a job with two centrifuges can route
-- each daily report's per-centrifuge run hours (Centrifuge 1 = workbook AA37,
-- Centrifuge 2 = workbook AM37) to the correct asset.
--
-- Additive and idempotent: safe to run more than once. NULL means "not mapped".
-- Only run-hour assets (Big Bowl / Small Bowl Centrifuge) on a job use this.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS centrifuge_slot integer;

-- Guard: slot must be 1 or 2 when set (NULL allowed = unmapped).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'assets_centrifuge_slot_check'
  ) THEN
    ALTER TABLE assets
      ADD CONSTRAINT assets_centrifuge_slot_check
      CHECK (centrifuge_slot IS NULL OR centrifuge_slot IN (1, 2));
  END IF;
END $$;
