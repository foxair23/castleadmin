-- Scheduler → Service Fusion: match an existing customer by contact email/phone
-- so a returning customer's booking attaches to their existing SF profile instead
-- of creating a duplicate.
--
-- Returns the single best matching (non-deleted) SF customer id, or NULL:
--   • Email match is preferred over phone match (email is more unique).
--   • Phone match compares the last 10 digits, ignoring formatting.
--   • Ties broken by most recent service (last_serviced_date desc).

create or replace function public.find_sf_customer_by_contact(p_email text, p_phone text)
returns text
language sql
stable
as $$
  with cand as (
    -- Email matches (preferred)
    select c.id, 0 as pref, c.last_serviced_date as lsd
    from public.sf_contact_emails e
    join public.sf_customer_contacts ct on ct.id = e.contact_id
    join public.sf_customers c on c.id = ct.customer_id
    where nullif(trim(coalesce(p_email, '')), '') is not null
      and lower(e.email) = lower(trim(p_email))
      and coalesce(c.is_deleted, false) = false

    union all

    -- Phone matches (last 10 digits, formatting-insensitive)
    select c.id, 1 as pref, c.last_serviced_date as lsd
    from public.sf_contact_phones ph
    join public.sf_customer_contacts ct on ct.id = ph.contact_id
    join public.sf_customers c on c.id = ct.customer_id
    where length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
      and right(regexp_replace(coalesce(ph.phone, ''), '\D', '', 'g'), 10)
        = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
      and coalesce(c.is_deleted, false) = false
  )
  select id
  from cand
  order by pref asc, lsd desc nulls last
  limit 1;
$$;
