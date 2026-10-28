-- Query B: product audiences. Run by itself in Supabase SQL Editor.
with eligible as (
  select o.id, o.clover_customer_id, o.clover_merchant_id,
         o.total_cents,
         to_timestamp(o.created_time / 1000.0) at time zone 'America/New_York' as local_time,
         lower(regexp_replace(trim(i.item_name), '\s+', ' ', 'g')) as item_name
  from public.orders o
  join public.order_items i on i.order_id = o.id
  where o.clover_customer_id is not null and not coalesce(o.voided, false)
)
select 'wings_buyers' as audience, count(distinct (clover_merchant_id, clover_customer_id)) as customers from eligible where item_name like '%wing%'
union all
select 'taco_buyers', count(distinct (clover_merchant_id, clover_customer_id)) from eligible where item_name like '%taco%'
union all
select 'all_food_buyers', count(distinct (clover_merchant_id, clover_customer_id)) from eligible
union all
select 'brunch_buyers', count(distinct (clover_merchant_id, clover_customer_id)) from eligible
  where extract(dow from local_time) in (0, 6)
    and item_name like any (array['%brunch%','%eggs benedict%','%mimosa%','%french toast%','%breakfast%','%pancake%','%omelet%','%omelette%'])
union all
select 'bottle_service_buyers', count(distinct (clover_merchant_id, clover_customer_id)) from eligible
  where item_name like any (array['%bottle%','%vodka bottle%','%tequila bottle%','%whiskey bottle%','%rum bottle%','%gin bottle%','%champagne bottle%','%prosecco%','%hennessy%','%patron%','%don julio%','%jack daniel%','%jameson%','%grey goose%','%ciroc%','%moet%','%veuve%','%dom perignon%'])
union all
select 'fishbowl_buyers', count(distinct (clover_merchant_id, clover_customer_id)) from eligible
  where item_name like any (array['%fishbowl%','%fish bowl%']);
