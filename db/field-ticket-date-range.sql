-- DFS Ops: field ticket date ranges (run once in the Supabase SQL editor)
-- Adds an optional end date. Blank end date = a one-day ticket, so every
-- existing ticket stays exactly as it is.
alter table public.field_tickets
  add column if not exists ticket_end_date date;

alter table public.field_tickets
  drop constraint if exists field_tickets_end_after_start;
alter table public.field_tickets
  add constraint field_tickets_end_after_start
  check (ticket_end_date is null or ticket_end_date >= ticket_date);

notify pgrst, 'reload schema';
