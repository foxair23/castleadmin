-- Manual "Resend Reminder" support.
--
-- Admin/sales can manually re-fire a chosen stage of the reminder series to an
-- overdue customer (e.g. an invoice that's aged past the last automated stage).
-- These are logged as separate `manual = true` rows so they don't get confused
-- with — or block — the automated series.
--
-- The automated engine still guarantees "each stage's channel is sent at most
-- once per invoice", but that guarantee must NOT apply to manual sends (the
-- whole point is to send the same stage again). So we drop the plain unique
-- constraint and replace it with a PARTIAL unique index scoped to automated
-- rows only.

alter table public.invoice_reminders
  add column if not exists manual boolean not null default false;

-- Drop the original all-rows uniqueness (auto-named by the create table in 063).
alter table public.invoice_reminders
  drop constraint if exists invoice_reminders_sf_invoice_id_stage_index_channel_key;

-- Re-assert it for automated rows only. Manual resends are unconstrained.
create unique index if not exists uq_invoice_reminders_auto
  on public.invoice_reminders (sf_invoice_id, stage_index, channel)
  where manual = false;
