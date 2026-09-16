-- What Cassie works on at all, as opposed to what she may send unattended.
--
-- Two different gates that were being conflated. `auto_question_types` decides which types
-- may go out WITHOUT a person; everything else was still classified, grounded against
-- Service Fusion, drafted by the model, and dropped in the review queue or posted to Chat
-- as a question for the team. With ~6 partner emails a day across a dozen types, that is
-- most of the noise: she was working on everything and handing over the result.
--
-- `handle_question_types` is the earlier gate: anything outside it stops right after
-- classification. Starting at 'status' alone, which is the office's choice of where to
-- train her first; widen it in the Cassie settings, no deploy needed.
--
-- `skip_notifications` covers the other half. A good share of the mail is not a question at
-- all — "Order 181195118 has been staged for pickup on 9/23" wants nothing from us. Those
-- are recorded and left alone.
alter table public.agent_settings
  add column if not exists handle_question_types text[] not null default '{status}',
  add column if not exists skip_notifications    boolean not null default true;
