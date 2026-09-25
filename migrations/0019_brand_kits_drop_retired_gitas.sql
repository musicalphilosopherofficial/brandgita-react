-- 0019 — drop the two retired Gita columns from brand_kits.
--
-- WHY: decisions/gita-consolidation.md (2026-09-24) retired Vision Gita and Aesthetic Gita.
-- Aesthetic Gita split three ways — taste to Ikivibe, resolution rules to kit config,
-- production values to brand-spec via the Stylist — and Vision Gita went with it. Voice Gita
-- is the one that survived, and it keeps its column (added by 0015).
--
-- ORDER OF OPERATIONS — THIS MIGRATION MUST RUN LAST, and the order is not a preference:
--
--   1. DEPLOY THE WORKER first. Until functions/api/kits.js stops naming these two columns in
--      its INSERT, dropping them breaks that statement — and it is a single statement, so the
--      failure takes brand_spec, voice_gita and stylist_memory down with it. Sync stops for
--      everyone, not just for the retired fields.
--   2. SHIP THE DESKTOP APP, whose KIT_FILES no longer reads or sends them. An older client
--      that still sends them is harmless either way: SYNCED_FIELDS is a filter and drops any
--      key it does not name.
--   3. THEN run this migration.
--
-- Running it earlier is the one sequence that causes an outage.
--
-- IRREVERSIBLE: the stored markdown goes with the columns. That is intended — a retired
-- artifact kept authoritative across devices is worse than no copy at all — but the creator's
-- LOCAL vision-gita.md and aesthetic-gita.md files are untouched by this and by the client
-- change, because writeLocalKit never deletes on the creator's behalf.

ALTER TABLE brand_kits DROP COLUMN vision_gita;
ALTER TABLE brand_kits DROP COLUMN aesthetic_gita;
