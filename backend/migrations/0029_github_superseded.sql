-- 0029 — LATEST-ONLY release queue (DATA ONLY — no schema rebuild).
--
-- WHY THIS MIGRATION LOOKS DIFFERENT
--   The first version rebuilt github_releases to add 'superseded' to its CHECK
--   constraint. SQLite cannot ALTER a CHECK, so a table rebuild is the only
--   way — but github_release_assets.release_id has a FOREIGN KEY to
--   github_releases(id), and dropping the parent table fails under
--   enforcement (that is the ❌ this migration produced in production).
--
--   So no DDL at all: a release replaced by a newer one is stored with the
--   EXISTING 'withdrawn' status plus a marker prefix in block_reason
--   ("Superseded by the newer GitHub release X"). 'withdrawn' is already
--   excluded from the queue and cannot be published, and the admin UI shows
--   it as "superseded".
--
-- WHAT IT DOES: archive older undecided candidates that are already piling up
-- in the queue (the sync used to import the whole release history). Releases
-- that are published, already decided, or are the newest candidate are left
-- untouched.
--
-- Re-running is safe: the WHERE clause only ever matches undecided rows.

UPDATE github_releases
   SET status = 'withdrawn',
       block_reason = 'Superseded by the newer GitHub release ' || (
         SELECT newer.version
           FROM github_releases AS newer
          WHERE newer.application_id = github_releases.application_id
            AND newer.status IN ('detected','verifying','pending_approval','verification_failed','blocked')
            AND newer.detected_at = (
              SELECT MAX(n2.detected_at) FROM github_releases AS n2
               WHERE n2.application_id = github_releases.application_id
                 AND n2.status IN ('detected','verifying','pending_approval','verification_failed','blocked')
            )
          LIMIT 1
       ) || '.'
 WHERE status IN ('detected','verifying','pending_approval','verification_failed','blocked')
   AND EXISTS (
     SELECT 1 FROM github_releases AS n
      WHERE n.application_id = github_releases.application_id
        AND n.id <> github_releases.id
        AND n.status IN ('detected','verifying','pending_approval','verification_failed','blocked')
        AND n.detected_at > github_releases.detected_at
   );
