-- Persist per-address pagination progress for bounded deposit scanner runs.
-- Existing high-water cursors remain unchanged; in-progress backfills resume
-- from the last fully handled page after process restarts.
ALTER TABLE deposit_scanner_cursors
    ADD COLUMN IF NOT EXISTS backfill_anchor_signature TEXT,
    ADD COLUMN IF NOT EXISTS backfill_before_signature TEXT,
    ADD COLUMN IF NOT EXISTS backfill_high_water_signature TEXT,
    ADD COLUMN IF NOT EXISTS backfill_high_water_slot BIGINT,
    ADD COLUMN IF NOT EXISTS backfill_high_water_block_time TIMESTAMPTZ;

ALTER TABLE deposit_scanner_cursors
    ADD CONSTRAINT chk_deposit_scanner_backfill_state
    CHECK (
      (backfill_anchor_signature IS NULL
       AND backfill_before_signature IS NULL
       AND backfill_high_water_signature IS NULL)
      OR
      (backfill_before_signature IS NOT NULL
       AND backfill_high_water_signature IS NOT NULL)
    );
