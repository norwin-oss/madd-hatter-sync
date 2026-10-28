-- Focused consistency check for inactive_30/60/90.
-- The counts must satisfy inactive_90 <= inactive_60 <= inactive_30.
with customer_last_visit as (
  select
    clover_merchant_id,
    clover_customer_id,
    max(to_timestamp(created_time / 1000.0)) as last_visit
  from public.orders
  where clover_customer_id is not null
    and not coalesce(voided, false)
  group by clover_merchant_id, clover_customer_id
)
select
  count(*) filter (
    where last_visit > to_timestamp(0)
      and last_visit < now() - interval '30 days'
  ) as inactive_30,
  count(*) filter (
    where last_visit > to_timestamp(0)
      and last_visit < now() - interval '60 days'
  ) as inactive_60,
  count(*) filter (
    where last_visit > to_timestamp(0)
      and last_visit < now() - interval '90 days'
  ) as inactive_90,
  min(last_visit) as oldest_last_visit,
  max(last_visit) as newest_last_visit,
  now() as database_now
from customer_last_visit;
