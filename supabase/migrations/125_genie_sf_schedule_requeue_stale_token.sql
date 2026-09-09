-- Re-queue the Genie appointments that failed only at the status step.
--
-- The first live run wrote every date and window, then failed each status post with SF's
-- "This job has been modified by another user": the concurrency token had been read before
-- our own two writes changed the job. Extension 0.9.10 re-reads the token after those
-- writes. The orders it marked failed are put back in the queue so the fixed extension
-- finishes them; re-writing the same date and window on the way is harmless.
--
-- Idempotent in effect: only rows carrying that exact failure note are touched, and a row
-- that has since posted no longer carries it.
update public.vendor_orders
   set sf_schedule_status    = 'queued',
       sf_schedule_sync_note = 'requeued by migration 125 after the stale-token status failure'
 where sf_schedule_status = 'failed'
   and sf_schedule_sync_note like '%modified by another user%';
