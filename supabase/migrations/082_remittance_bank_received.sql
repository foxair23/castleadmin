-- Track whether the bank deposit for a remittance has landed. One bank payment
-- per remittance email, so this lives on remittance_emails (not per line).
alter table public.remittance_emails
  add column if not exists bank_received_at timestamptz,
  add column if not exists bank_received_by uuid references public.profiles(id);
