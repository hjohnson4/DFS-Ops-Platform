-- DFS Ops — Field ticket workflow (Open → Closed → Approved)
-- Safe to run more than once. Run it once in the Supabase SQL Editor.

-- 1) Ticket status, type, ordered-by, close/approve stamps and a history log
alter table field_tickets add column if not exists status text not null default 'open';
alter table field_tickets add column if not exists ticket_type text;
alter table field_tickets add column if not exists ordered_by text;
alter table field_tickets add column if not exists closed_at timestamptz;
alter table field_tickets add column if not exists closed_by uuid references profiles(id);
alter table field_tickets add column if not exists approved_at timestamptz;
alter table field_tickets add column if not exists approved_by uuid references profiles(id);
alter table field_tickets add column if not exists history jsonb not null default '[]'::jsonb;

do $$ begin
  alter table field_tickets add constraint field_tickets_status_check
    check (status in ('open', 'closed', 'approved'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table field_tickets add constraint field_tickets_type_check
    check (ticket_type is null or ticket_type in ('service', 'delivery'));
exception when duplicate_object then null; end $$;

-- 2) Ticket numbers must be unique (numbers can now be typed in by hand)
create unique index if not exists field_tickets_ticket_number_key on field_tickets (ticket_number);

-- 3) Read / set the next automatic ticket number (admin setting in the app)
create or replace function field_ticket_next_number() returns integer
language sql security definer set search_path = public as $$
  select greatest(
    (select case when is_called then last_value + 1 else last_value end
       from field_tickets_ticket_number_seq),
    coalesce((select max(ticket_number) + 1 from field_tickets), 1)
  )::integer;
$$;

create or replace function set_field_ticket_next_number(n integer) returns integer
language plpgsql security definer set search_path = public as $$
begin
  if n is null or n < 1 then
    raise exception 'Next ticket number must be 1 or more';
  end if;
  if exists (select 1 from field_tickets where ticket_number >= n) then
    raise exception 'Ticket number % or higher is already used', n;
  end if;
  perform setval('field_tickets_ticket_number_seq', n, false);
  return n;
end $$;

revoke all on function field_ticket_next_number() from public, anon, authenticated;
revoke all on function set_field_ticket_next_number(integer) from public, anon, authenticated;
grant execute on function field_ticket_next_number() to service_role;
grant execute on function set_field_ticket_next_number(integer) to service_role;

-- Check: should list the new columns
select column_name from information_schema.columns
where table_name = 'field_tickets'
  and column_name in ('status','ticket_type','ordered_by','closed_at','closed_by','approved_at','approved_by','history')
order by column_name;
