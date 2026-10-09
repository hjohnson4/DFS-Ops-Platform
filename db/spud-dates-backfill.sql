-- Spud dates (cell AU6) for the existing set day rate (Verdun) daily reports.
-- New reports pick up AU6 automatically; this fills in the ones already on file.
-- Values were read from each report's own stored workbook. Safe to run more than once.
update daily_reports
set well_context = coalesce(well_context, '{}'::jsonb) || jsonb_build_object('spud_date', '2026-08-29')
where id in ('eca45cd0-cf47-4c6b-b08e-7c7ab6f23227', '7ae563a6-92ae-4867-9515-dd7ddb62ce49', 'a0d436dc-61a8-40ae-9452-53a9ed7797de', 'f9bcfec9-f75a-4a65-9c55-b7fa7f55c2ed', '74e68283-9419-4629-aaa7-77cb6f6d998e', '402c9b8f-cdc8-460f-a78d-332230552b66', '7d527286-f48b-4735-b48e-d41b901ba1de', 'f4031657-445e-404c-9c21-78cd85f769b8', '3c0c20a4-ba4b-4097-ae63-07c6845d0f30', '2f5b365e-6877-4a55-a767-e6d48bc93dec', '4058f87b-2f52-4fea-9e2f-16ea118e5a1d', 'bffeb462-3aff-4b57-ab34-4811c98ae83e');
update daily_reports
set well_context = coalesce(well_context, '{}'::jsonb) || jsonb_build_object('spud_date', '2026-09-20')
where id in ('510ac498-dabf-499a-83af-a8d0895f8cb9');

-- Check: one row per job showing the spud date it will bill from.
select j.job_number, r.well_context->>'spud_date' as spud_date, count(*) as reports
from daily_reports r join jobs j on j.id = r.job_id
where j.manual_day_rate
group by 1, 2 order by 1, 2;
