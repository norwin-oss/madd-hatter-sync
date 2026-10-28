-- Query C: counts for all day/time and spending/lifecycle audiences.
-- Run this query by itself in Supabase SQL Editor.
with eligible_orders as (
  select
    id,
    clover_customer_id,
    clover_merchant_id,
    total_cents,
    net_sales_cents,
    to_timestamp(created_time / 1000.0) as visit_time,
    to_timestamp(created_time / 1000.0) at time zone 'America/New_York' as local_time
  from public.orders
  where clover_customer_id is not null
    and not coalesce(voided, false)
),
customer_stats as (
  select
    clover_merchant_id,
    clover_customer_id,
    count(*) as visit_count,
    min(visit_time) as first_visit,
    max(visit_time) as last_visit,
    sum(coalesce(nullif(net_sales_cents, 0), total_cents, 0)) as lifetime_spend_cents,
    count(distinct extract(dow from local_time)) as distinct_visit_days
  from eligible_orders
  group by clover_merchant_id, clover_customer_id
),
monthly_visits as (
  select
    clover_merchant_id,
    clover_customer_id,
    date_trunc('month', local_time) as visit_month,
    count(*) as visits
  from eligible_orders
  group by clover_merchant_id, clover_customer_id, date_trunc('month', local_time)
)
select 'sunday_football' as audience, count(distinct (clover_merchant_id, clover_customer_id)) as customers
from eligible_orders
where extract(dow from local_time) = 0 and (
  local_time::date between date '2023-09-01' and date '2024-02-29' or
  local_time::date between date '2024-09-01' and date '2025-02-28' or
  local_time::date between date '2025-09-01' and date '2026-02-28'
)
union all
select 'tuesday_visitors', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where extract(dow from local_time) = 2
union all
select 'wednesday_karaoke', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where
  (extract(dow from local_time) = 3 and extract(hour from local_time) >= 21) or
  (extract(dow from local_time) = 4 and extract(hour from local_time) < 2)
union all
select 'weekday_daytime', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders
where extract(dow from local_time) between 1 and 5
  and extract(hour from local_time) >= 11 and extract(hour from local_time) < 20
union all
select 'thursday_nightlife', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where
  (extract(dow from local_time) = 4 and extract(hour from local_time) >= 19) or
  (extract(dow from local_time) = 5 and extract(hour from local_time) < 3)
union all
select 'friday_nightlife', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where
  (extract(dow from local_time) = 5 and extract(hour from local_time) >= 19) or
  (extract(dow from local_time) = 6 and extract(hour from local_time) < 3)
union all
select 'saturday_nightlife', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where
  (extract(dow from local_time) = 6 and extract(hour from local_time) >= 19) or
  (extract(dow from local_time) = 0 and extract(hour from local_time) < 3)
union all
select 'multi_day_visitors', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where distinct_visit_days > 1
union all
select 'single_check_250', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where total_cents >= 25000
union all
select 'single_check_500', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where total_cents >= 50000
union all
select 'single_check_750', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where total_cents >= 75000
union all
select 'single_check_1000', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders where total_cents >= 100000
union all
select 'visits_2_plus_month', count(distinct (clover_merchant_id, clover_customer_id))
from monthly_visits where visits >= 2
union all
select 'visits_4_plus_month', count(distinct (clover_merchant_id, clover_customer_id))
from monthly_visits where visits >= 4
union all
select 'inactive_30', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where last_visit > to_timestamp(0) and last_visit < now() - interval '30 days'
union all
select 'inactive_60', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where last_visit > to_timestamp(0) and last_visit < now() - interval '60 days'
union all
select 'inactive_90', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where last_visit > to_timestamp(0) and last_visit < now() - interval '90 days'
union all
select 'lifetime_2500', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where lifetime_spend_cents >= 250000
union all
select 'lifetime_5000', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats where lifetime_spend_cents >= 500000
union all
select 'weekday_check_100', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders
where extract(dow from local_time) between 1 and 5 and total_cents > 10000
union all
select 'weekend_check_500', count(distinct (clover_merchant_id, clover_customer_id))
from eligible_orders
where extract(dow from local_time) in (0, 6) and total_cents > 50000
union all
select 'first_time_customers', count(distinct (clover_merchant_id, clover_customer_id))
from customer_stats
where first_visit > to_timestamp(0) and first_visit >= now() - interval '30 days';
