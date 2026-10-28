-- Query A: data health. Run by itself in Supabase SQL Editor.
with eligible_orders as (
  select id, clover_merchant_id, clover_customer_id, total_cents, net_sales_cents, created_time
  from public.orders
  where clover_customer_id is not null and not coalesce(voided, false)
)
select
  (select count(*) from public.orders) as total_orders,
  (select count(*) from eligible_orders) as identified_nonvoid_orders,
  (select count(distinct (clover_merchant_id, clover_customer_id)) from eligible_orders) as identified_customers,
  (select count(*) from public.customers) as imported_customer_profiles,
  (select count(*) from public.order_items i join eligible_orders o on i.order_id = o.id) as linked_line_items;
