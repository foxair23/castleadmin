create or replace function google_reviews_monthly_trend()
returns table (
  month      text,
  count      bigint,
  avg_rating numeric
)
language sql
stable
security definer
as $$
  select
    to_char(date_trunc('month', created_at_google), 'Mon ''YY') as month,
    count(*)                                                      as count,
    round(avg(star_rating)::numeric, 1)                          as avg_rating
  from google_reviews
  where
    deleted_at is null
    and created_at_google >= now() - interval '18 months'
  group by date_trunc('month', created_at_google)
  order by date_trunc('month', created_at_google)
$$;
