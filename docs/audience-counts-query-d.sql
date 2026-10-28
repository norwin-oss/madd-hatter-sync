-- Query D: event audiences. Run by itself in Supabase SQL Editor.
with eligible_orders as (
  select id, clover_customer_id, clover_merchant_id,
         to_timestamp(created_time / 1000.0) as visit_time,
         to_timestamp(created_time / 1000.0) at time zone 'America/New_York' as local_time
  from public.orders
  where clover_customer_id is not null and not coalesce(voided, false)
),
ufc as (
  select unnest(array[
    date '2023-01-21', date '2023-02-04', date '2023-02-18', date '2023-03-04',
    date '2023-03-18', date '2023-04-08', date '2023-04-15', date '2023-04-29',
    date '2023-05-06', date '2023-05-13', date '2023-05-20', date '2023-06-03',
    date '2023-06-10', date '2023-06-17', date '2023-07-01', date '2023-07-08',
    date '2023-07-15', date '2023-07-22', date '2023-07-29', date '2023-08-05',
    date '2023-08-12', date '2023-08-19', date '2023-09-09', date '2023-09-16',
    date '2023-10-07', date '2023-10-14', date '2023-10-21', date '2023-11-04',
    date '2023-11-11', date '2023-11-18', date '2023-12-02', date '2023-12-09',
    date '2023-12-16',
    date '2024-01-13', date '2024-01-20', date '2024-02-03', date '2024-02-10',
    date '2024-02-17', date '2024-03-02', date '2024-03-09', date '2024-03-23',
    date '2024-04-06', date '2024-04-13', date '2024-04-27', date '2024-05-04',
    date '2024-05-11', date '2024-05-18', date '2024-06-01', date '2024-06-08',
    date '2024-06-15', date '2024-06-22', date '2024-06-29', date '2024-07-06',
    date '2024-07-13', date '2024-07-20', date '2024-07-27', date '2024-08-03',
    date '2024-08-10', date '2024-08-17', date '2024-09-07', date '2024-09-14',
    date '2024-09-28', date '2024-10-05', date '2024-10-12', date '2024-10-19',
    date '2024-11-02', date '2024-11-09', date '2024-11-16', date '2024-11-23',
    date '2024-12-07', date '2024-12-14',
    date '2025-01-11', date '2025-01-18', date '2025-02-01', date '2025-02-08',
    date '2025-02-15', date '2025-03-01', date '2025-03-08', date '2025-03-22',
    date '2025-04-05', date '2025-04-12', date '2025-04-26', date '2025-05-03',
    date '2025-05-10', date '2025-05-17', date '2025-06-07', date '2025-06-14',
    date '2025-06-21', date '2025-06-28', date '2025-07-19', date '2025-07-26',
    date '2025-08-02', date '2025-08-16', date '2025-09-06', date '2025-09-13',
    date '2025-09-27', date '2025-10-04', date '2025-10-11', date '2025-10-18',
    date '2025-10-25', date '2025-11-01', date '2025-11-08', date '2025-11-15',
    date '2025-11-22', date '2025-12-06', date '2025-12-13'
  ]::date[]) as event_date
),
event_attendance as (
  select distinct clover_merchant_id, clover_customer_id, 'ufc' as event_type, u.event_date
  from eligible_orders o join ufc u
    on o.visit_time >= ((u.event_date + time '20:00') at time zone 'America/New_York')
   and o.visit_time < (((u.event_date + time '20:00') at time zone 'America/New_York') + interval '10 hours')
  union
  select distinct clover_merchant_id, clover_customer_id, 'halloween', local_time::date
  from eligible_orders where local_time::date in (date '2024-10-26', date '2024-10-31', date '2025-10-25', date '2025-10-31')
  union
  select distinct clover_merchant_id, clover_customer_id, 'thanksgiving_eve', local_time::date
  from eligible_orders where local_time::date in (date '2024-11-27', date '2025-11-26')
  union
  select distinct clover_merchant_id, clover_customer_id, 'thanksgiving_day', local_time::date
  from eligible_orders where local_time::date in (date '2023-11-23', date '2024-11-28', date '2025-11-27')
)
select 'ufc_fight_night' as audience, count(distinct (clover_merchant_id, clover_customer_id)) as customers from event_attendance where event_type = 'ufc'
union all
select 'halloween', count(distinct (clover_merchant_id, clover_customer_id)) from event_attendance where event_type = 'halloween'
union all
select 'thanksgiving_eve', count(distinct (clover_merchant_id, clover_customer_id)) from event_attendance where event_type = 'thanksgiving_eve'
union all
select 'thanksgiving_day', count(distinct (clover_merchant_id, clover_customer_id)) from event_attendance where event_type = 'thanksgiving_day'
union all
select 'repeat_special_event', count(*) from (
  select clover_merchant_id, clover_customer_id
  from event_attendance
  where event_type in ('ufc','halloween','thanksgiving_eve')
  group by clover_merchant_id, clover_customer_id
  having count(distinct event_date) >= 2
) s;
