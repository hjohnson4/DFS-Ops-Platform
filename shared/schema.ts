import { z } from "zod";

// ---- Enums / vocab ---------------------------------------------------------
export const ROLES = ["admin", "area", "super", "field"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  area: "Area Manager",
  super: "Supervisor",
  field: "Field Tech",
};

export const AREAS = ["West Texas", "South Texas", "North Louisiana"] as const;
export type Area = (typeof AREAS)[number];

export const CATEGORIES = [
  "Big Bowl Centrifuge",
  "Small Bowl Centrifuge",
  "Excavator",
  "Open Top",
  "Dewatering Unit",
  "Drying Shaker Tank",
  "Pump",
  "VFD",
  "Effluent Tank",
] as const;
export type Category = (typeof CATEGORIES)[number];

// Categories that track run-hours
export const RUN_HOUR_CATEGORIES: Category[] = [
  "Big Bowl Centrifuge",
  "Small Bowl Centrifuge",
];
export const tracksRunHours = (c: string) =>
  RUN_HOUR_CATEGORIES.includes(c as Category);

export const WORK_TYPES = [
  "Preventive",
  "Repair",
  "Inspection",
  "Corrective",
  "General Maintenance",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const REPORT_STATUS = ["Pending Sign-off", "Signed off"] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];

export const JOB_STATUS = ["Active", "Rig Move", "On Hold", "Completed"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];
// A job that is still running (crew on location or moving between wells).
// "Rig Move" jobs stay open for reports, assets and tickets like Active ones.
export const isLiveJobStatus = (s: string | null | undefined): boolean =>
  s === "Active" || s === "Rig Move";

export const CREWING = ["Manned", "Unmanned"] as const;
export type Crewing = (typeof CREWING)[number];

// ---- Row types (mirror the Postgres tables) --------------------------------
export interface Profile {
  id: string;
  email: string;
  name: string;
  role: Role;
  area: Area | null;
  active: boolean;
  created_at: string;
  // Computed at auth time from Supabase Auth user_metadata (not a profiles
  // column). When true, the app forces the user to set a new password before
  // using the rest of the app. Set when an admin creates them with a temporary
  // password and asks for a change on first login; cleared once they change it.
  must_change_password?: boolean;
}

export interface Customer {
  id: string;
  name: string;
  primary_contact: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export interface Job {
  id: string;
  job_number: string;
  area: Area;
  customer_id: string;
  description: string | null;
  status: JobStatus;
  crewing: Crewing; // whether the job is Manned or Unmanned
  started_on: string | null;
  ended_on: string | null;
  day_rate: number | null; // billable day rate ($/day) used for revenue
  well_name: string | null; // used to match emailed Excel daily reports
  archived_at: string | null; // set when the job is archived (soft-deleted)
  est_release_on?: string | null; // planned release for forecasting (null = indefinite)
  created_at: string;
  // Set day rate: bill day_rate every Active day instead of reading costs from
  // the daily report (Verdun Oil & Gas). See server/manualBilling.ts.
  manual_day_rate?: boolean;
  // "report_days" (Verdun) or "spud_to_latest" (Expand Energy). See manualBilling.ts.
  manual_billing_mode?: ManualBillingMode | null;
  billing_start_date?: string | null; // calendar mode (Mud Plant)
  manual_billing?: ManualBilling | null;
  // Standby billing (equipment on location, no crew). See server/standby.ts.
  standby?: JobStandby | null;
}

export interface JobStandbyPeriod {
  id: string;
  rate: number;
  start_date: string; // first standby day
  end_date: string | null; // last standby day; null = still on standby
  ended_reason: "report" | "manual" | null;
  created_by_name: string | null;
  ended_by_name: string | null;
  created_at: string | null;
  days: number;
  total: number;
}

export interface JobStandby {
  active: boolean;
  rate: number | null; // current standby day rate (when active)
  start_date: string | null;
  days: number; // every standby day so far
  total: number; // standby revenue so far
  periods: JobStandbyPeriod[]; // newest first
}

export interface ManualBillingEvent {
  effective_date: string; // yyyy-mm-dd (2000-01-01 = from the first report)
  day_rate: number | null;
  status: string;
  created_by_name: string | null;
  created_at: string;
}

export type ManualBillingMode = "report_days" | "spud_to_latest" | "calendar";

export interface ManualBilling {
  mode?: ManualBillingMode; // how days are counted
  billing_start_date?: string | null; // calendar mode: first billed day
  not_billed_days?: number; // calendar mode: days marked Not billing
  latest_report_date?: string | null; // newest report date on the job
  start_date: string | null; // first well's spud date (AU6), else oldest daily report date
  start_source?: "spud_date" | "first_report" | "billing_start" | null;
  current_well_spud_date?: string | null;
  through_date: string; // today (report_days) or the latest report date (spud_to_latest)
  billable_days: number; // report days on/after spud, or calendar days spud → latest report
  missing_rate_days: number; // Active days with no rate set
  total: number | null; // billed to date; null = no reports or no rate
  today_rate: number | null; // 0 on Rig Move / On Hold / Completed
  today_status: string;
  current_well: string | null;
  current_well_revenue: number | null;
  by_well: { well: string; revenue: number; start?: string; spud_date?: string | null }[];
  events: ManualBillingEvent[];
}

// Job with the customer name joined in (for list/detail views)
export interface JobWithCustomer extends Job {
  customer_name: string;
}

// ---- Pads / Wells / Well stints -------------------------------------------
// A job can contain multiple pads. Each pad holds one or more wells. At most
// one well per pad is "Open" at a time; opening a well auto-closes the current
// open well on that pad. Each open/close interval is recorded as a well_stint.
export const PAD_STATUS = ["Open", "Closed"] as const;
export type PadStatus = (typeof PAD_STATUS)[number];
export const WELL_STATUS = ["Pending", "Open", "Closed"] as const;
export type WellStatus = (typeof WELL_STATUS)[number];

export interface Pad {
  id: string;
  job_id: string;
  name: string;
  status: PadStatus;
  opened_on: string | null;
  closed_on: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface Well {
  id: string;
  pad_id: string;
  job_id: string;
  name: string;
  status: WellStatus;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface WellStint {
  id: string;
  well_id: string;
  pad_id: string;
  job_id: string;
  well_name: string;
  opened_on: string; // yyyy-mm-dd
  closed_on: string | null;
  opened_by: string | null;
  opened_by_name: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  created_at: string;
}

// A pad with its wells (each well carrying its stints) — the shape the job
// detail page consumes for the explicit "Wells on pad" view.
export interface WellWithStints extends Well {
  stints: WellStint[];
}
export interface PadWithWells extends Pad {
  wells: WellWithStints[];
}

// ---- Report-driven pads/wells ---------------------------------------------
// Wells are no longer opened/closed by hand. Instead the crew's current well is
// inferred from the sequence of daily reports (report_date + well_name): the
// well named on the latest report is "Open", the rest are "Closed". Days on a
// well = count of report-days naming it; revenue = day_rate x days. A well is
// attached to a pad once, then its activity is derived from reports.
export interface PadWellDerived {
  id: string;
  pad_id: string;
  job_id: string;
  name: string;
  status: WellStatus; // derived: Open (current), Closed (had reports), Pending (none yet)
  report_days: number; // number of daily reports naming this well
  first_report: string | null; // yyyy-mm-dd of earliest report on this well
  last_report: string | null; // yyyy-mm-dd of latest report on this well
  revenue: number | null; // accrued (cell AS57) on the well's latest report; falls back to day_rate x report_days
  is_current: boolean; // true for the well on the job's most recent report
  is_month?: boolean; // billing-calendar jobs (Mud Plant): row is a month, not a well
  not_billed_days?: number; // month rows: days marked Not billing (or $0 status)
}
export interface PadWithDerivedWells extends Pad {
  wells: PadWellDerived[];
}
// A well name seen in a job's daily reports that is not yet attached to a pad.
export interface UnassignedWell {
  name: string;
  report_days: number;
  first_report: string | null;
  last_report: string | null;
  is_current: boolean;
}

export const SCHEDULE_CADENCE = ["run_hours", "calendar_days"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCE)[number];
export const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  run_hours: "Run-hours",
  calendar_days: "Calendar days",
};

// A reusable, named maintenance schedule template that assets can link to.
export interface MaintenanceSchedule {
  id: string;
  name: string;
  cadence: ScheduleCadence;
  interval_value: number;
  notes: string | null;
  created_at: string;
}

// Human-readable summary of a schedule's cadence, e.g. "Every 250 run-hours".
export function scheduleSummary(s: {
  cadence: ScheduleCadence;
  interval_value: number;
}): string {
  const unit = s.cadence === "run_hours" ? "run-hours" : "days";
  return `Every ${s.interval_value.toLocaleString()} ${unit}`;
}

export interface Asset {
  id: string;
  tag: string;
  category: Category;
  area: Area;
  description: string | null;
  job_or_well: string | null;
  job_id: string | null;
  status: string;
  run_hours: number | null;
  last_maintained: string | null;
  // Run-hours between services for this asset (default 250, editable per asset).
  service_hours_interval: number;
  // Asset run_hours meter captured at the last filed report; null if never serviced.
  run_hours_at_service: number | null;
  // Optional link to a named maintenance schedule template.
  maintenance_schedule_id: string | null;
  // Rental day rate ($/day) for this unit; independent of any job. Null = not set.
  day_rate: number | null;
  // Which centrifuge column on the daily report this asset represents while it
  // is assigned to its current job: 1-4 = "Centrifuge 1".."Centrifuge 4"
  // column on the daily report, null = not mapped. Only meaningful for
  // run-hour categories on jobs with 2+ centrifuges; drives which centrifuge's
  // actual hours accrue to this asset at sign-off.
  centrifuge_slot: number | null;
  // Rented from a third party. Monthly rate and notes are only sent to Admins
  // and Area Managers.
  is_rental?: boolean;
  rental_vendor?: string | null;
  rental_ref?: string | null;
  rental_monthly_rate?: number | null;
  rental_start?: string | null;
  rental_end?: string | null;
  rental_notes?: string | null;
  created_at: string;
}

// Rental cost vs. earnings for one rented unit (see server/rentals.ts).
export interface RentalSummary {
  through: string | null;
  days_on_rent: number;
  days_on_job: number;
  days_missing_rate: number; // days on a job with no day rate saved
  rent_cost: number;
  one_time_charges: number;
  total_cost: number;
  earned: number;
  profit: number;
  on_rent: boolean;
  monthly_rate: number | null;
}
export interface RentalCharge {
  id: string;
  asset_id: string;
  charge_date: string;
  description: string;
  amount: number;
  created_by_name: string | null;
  created_at: string;
}
export interface RentalDetail {
  summary: RentalSummary;
  charges: RentalCharge[];
  jobs: { id: string; job_id: string; job_number: string | null; day_rate: number | null; start_date: string; end_date: string | null }[];
}
// Back-date (or correct) the day a unit went onto a job, e.g. a rental that
// was entered in DFS Ops after it had already been working.
export const setStintStartSchema = z.object({
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
});
export const createRentalChargeSchema = z.object({
  charge_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  description: z.string().trim().min(1, "Describe the charge").max(200),
  amount: z.coerce.number().nonnegative("Amount can't be negative"),
});

// Minimal job info joined onto an asset to show where it is deployed.
export interface AssetJobRef {
  id: string;
  job_number: string;
  well_name: string | null;
  area: Area;
  status: JobStatus;
}

// Asset with its linked maintenance schedule + current job joined in (both nullable).
export interface AssetWithSchedule extends Asset {
  maintenance_schedule: MaintenanceSchedule | null;
  job: AssetJobRef | null;
}

// Human-readable current location of an asset, derived from its assigned job.
// When the asset is deployed to a job we show the well/job and its area. When
// it is NOT on a job (unassigned) we show its deployable area followed by
// "/unassigned" (e.g. "West Texas/unassigned"), so the location still reflects
// which area the asset belongs to. Falls back to "Unassigned" only when the
// asset has no area at all.
export function assetLocation(a: AssetWithSchedule): string {
  if (a.job) {
    const where = a.job.well_name || a.job.job_number;
    return `${where} \u00b7 ${a.job.area}`;
  }
  if (a.area) return `${a.area}/unassigned`;
  return "Unassigned";
}

// A maintenance/inspection history entry for an asset, with the supervisor name
// joined in. Used by the asset detail pop-up.
export interface AssetHistoryEntry {
  id: string;
  work_type: WorkType;
  status: ReportStatus;
  report_date: string;
  filed_at: string;
  notes: string | null;
  supervisor_name: string | null;
  has_form?: boolean; // in-app service form → can be opened with "View"
  score_pass?: number | null;
  score_total?: number | null;
  flagged_count?: number | null;
}

// Full detail payload for the asset pop-up: the asset (with joins) + its history.
export interface AssetDetail extends AssetWithSchedule {
  history: AssetHistoryEntry[];
  // Derived at the detail endpoint via serviceStatusFor() for centrifuges:
  // run_hours - run_hours_at_service ("since last full service").
  run_hours_since_service?: number | null;
  service_state?: ServiceState;
}

// One row of the utilization export.
export interface AssetUtilizationRow {
  tag: string;
  category: Category;
  area: Area;
  status: string;
  location: string;
  day_rate: number | null;
  run_hours: number | null;
  days_deployed: number | null; // days assigned to a job overlapping the window
  window_days: number; // total days in the selected window
  utilization_pct: number | null; // days_deployed / window_days, null if unknown
  est_revenue: number | null; // day_rate * days_deployed, null if either unknown
  maintenance_events: number; // reports filed in the window
}

// A maintenance report document (e.g. PDF) attached to a specific asset.
// File bytes are stored base64 on the row; the list select omits file_base64
// so payloads stay small — it is only read by the download route.
export interface MaintenanceReportFile {
  id: string;
  asset_id: string;
  file_name: string;
  file_mime: string;
  file_size: number;
  work_performed: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
}

// Maintenance report file with the uploader name (and asset info) joined in.
export interface MaintenanceReportFileWithLinks extends MaintenanceReportFile {
  uploaded_by_name: string | null;
  asset_tag: string | null;
  area: Area | null;
}

// One row in the Maintenance asset matrix: an asset that is NOT in the field
// (no job assignment). Carries service status + counts of logged maintenance
// entries and uploaded report files.
export interface MaintenanceMatrixRow {
  id: string;
  tag: string;
  category: Category;
  area: Area;
  status: string;
  description: string | null;
  run_hours: number | null;
  run_hours_at_service: number | null;
  service_hours_interval: number;
  last_maintained: string | null;
  entry_count: number; // logged maintenance_reports for this asset
  file_count: number; // uploaded maintenance report files for this asset
  last_activity: string | null; // most recent of last logged / last uploaded
}

// Default run-hours between services for a newly added run-hour asset.
export const DEFAULT_SERVICE_HOURS_INTERVAL = 250;

// A centrifuge is "needs service soon" once it is within this fraction of its
// interval, and "overdue" once it has reached/passed the interval.
export const SERVICE_SOON_FRACTION = 0.1;

export type ServiceState =
  | "OK"
  | "Soon"
  | "Overdue"
  | "No baseline"
  | "Not tracked";

// Centrifuges assigned to a job are serviced on a fixed weekly (7-day) cadence,
// measured from the date of their last filed service report. Unassigned
// centrifuges are not tracked. "Soon" turns on the day before it comes due.
export const WEEKLY_SERVICE_DAYS = 7;
export const WEEKLY_SERVICE_SOON_DAYS = 1;

// Whole days between a past ISO date and now (never negative).
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const ms = Date.now() - then;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

// Weekly time-based service status for a job-assigned centrifuge. Baseline is
// the last filed service report date (`lastMaintained`); with none, the unit
// has no baseline and is treated as due now.
export function weeklyServiceStatusFor(lastMaintained: string | null): {
  daysSince: number | null;
  intervalDays: number;
  state: ServiceState;
} {
  const intervalDays = WEEKLY_SERVICE_DAYS;
  const d = daysSince(lastMaintained);
  if (d == null) return { daysSince: null, intervalDays, state: "No baseline" };
  let state: ServiceState = "OK";
  if (d >= intervalDays) state = "Overdue";
  else if (d >= intervalDays - WEEKLY_SERVICE_SOON_DAYS) state = "Soon";
  return { daysSince: d, intervalDays, state };
}

// Compute service status for a run-hour asset from its meter + interval.
// `run_hours_at_service` is the meter reading at the last service; when null
// the asset has no service baseline yet, so hours-since-service is unknown.
export function serviceStatusFor(a: {
  run_hours: number | null;
  run_hours_at_service: number | null;
  service_hours_interval: number | null;
}): { hoursSince: number | null; interval: number; state: ServiceState } {
  const interval = a.service_hours_interval ?? DEFAULT_SERVICE_HOURS_INTERVAL;
  if (a.run_hours == null || a.run_hours_at_service == null)
    return { hoursSince: null, interval, state: "No baseline" };
  const hoursSince = Math.max(0, a.run_hours - a.run_hours_at_service);
  let state: ServiceState = "OK";
  if (hoursSince >= interval) state = "Overdue";
  else if (hoursSince >= interval * (1 - SERVICE_SOON_FRACTION)) state = "Soon";
  return { hoursSince, interval, state };
}

// ---- Run-hours service interval (centrifuges) ------------------------------
// A centrifuge must be serviced within this many run hours of its last
// service report. "Service soon" turns on at SERVICE_SOON_FRACTION of the
// interval (135 hrs); "Overdue" at 150 hrs or more.
export const SERVICE_INTERVAL_HOURS = 150;

// One row of the per-report run-hours log (table asset_run_hours): the hours a
// signed-off daily report added to one centrifuge, with the job and well the
// report was for. Drives hours-since-service and per-job / per-well totals.
export interface AssetRunHoursEntry {
  asset_id: string;
  daily_report_id: string;
  job_id: string | null;
  well_name: string | null;
  report_date: string | null;
  hours: number;
}

// Hours-since-service state for a centrifuge from its logged run hours.
// `hoursSince` = hours logged on daily reports dated AFTER the last service
// report's date. With no service report on file, every logged hour counts and
// `neverServiced` is true; with no hours and no service the state is
// "No baseline".
export function hoursServiceStatusFor(
  hoursSince: number,
  hasService: boolean,
  interval: number = SERVICE_INTERVAL_HOURS,
): { hoursSince: number | null; interval: number; state: ServiceState } {
  if (!hasService && hoursSince <= 0)
    return { hoursSince: null, interval, state: "No baseline" };
  let state: ServiceState = "OK";
  if (hoursSince >= interval) state = "Overdue";
  else if (hoursSince >= interval * (1 - SERVICE_SOON_FRACTION)) state = "Soon";
  return { hoursSince, interval, state };
}

// Service history + run-hours breakdown for one centrifuge (Service module
// asset pop-up).
export interface ServiceHistoryItem {
  id: string;
  report_date: string;
  filed_at: string;
  supervisor_name: string | null;
  status: string;
  score_pass: number | null;
  score_total: number | null;
  flagged_count: number | null;
  has_form: boolean; // true when it's an in-app form that can be opened
}
export interface WellHours {
  well_name: string;
  hours: number;
  report_days: number;
  first_date: string | null;
  last_date: string | null;
}
export interface JobHours {
  job_id: string | null;
  job_number: string | null;
  is_current: boolean;
  hours: number;
  report_days: number;
  wells: WellHours[];
}
export interface ServiceAssetDetail {
  id: string;
  tag: string;
  is_rental?: boolean;
  rental_vendor?: string | null;
  category: Category;
  area: Area;
  job_id: string | null;
  job_number: string | null;
  hours_since_service: number | null;
  service_interval_hours: number;
  service_state: ServiceState;
  never_serviced: boolean;
  last_service_date: string | null;
  last_service_supervisor: string | null;
  current_job_hours: number | null; // null when not on a job
  total_logged_hours: number;
  history: ServiceHistoryItem[];
  jobs: JobHours[];
  ledger_ready: boolean; // false until db/hours-since-service.sql is run
}

// One centrifuge row on the Service dashboard's active-asset list.
export interface ServiceAssetRow {
  id: string;
  tag: string;
  is_rental?: boolean;
  rental_vendor?: string | null;
  category: Category;
  area: Area;
  status: string; // deployment status (e.g. On Job / Available)
  job_id: string | null;
  assigned: boolean; // true when the centrifuge is assigned to a job
  job_number: string | null;
  job_or_well: string | null;
  technician: string | null; // supervisor who last filed a service report
  run_hours: number | null;
  run_hours_since_service: number | null;
  service_hours_interval: number;
  // Run hours logged on daily reports dated after the last service report
  // (all logged hours when never serviced). Interval is SERVICE_INTERVAL_HOURS.
  hours_since_service: number | null;
  service_interval_hours: number;
  never_serviced: boolean;
  current_job_hours: number | null; // hours logged on its current job
  last_service_date: string | null;
  last_maintained: string | null;
  service_state: ServiceState;
}

// Aggregate payload for the Service dashboard.
export interface ServiceDashboard {
  metrics: {
    active_centrifuges: number; // deployed centrifuges (status not Available)
    total_centrifuges: number;
    due_soon: number; // within SERVICE_SOON_FRACTION of interval
    overdue: number; // reached/passed interval
    reports_filed: number; // maintenance reports in scope
    reports_pending_signoff: number;
  };
  centrifuges: ServiceAssetRow[]; // all in-scope centrifuges; use `assigned` to split job-assigned vs unassigned
}

// A single billable line on a field ticket. Total is Qty × Unit cost, computed
// and stored so the PDF and totals stay stable even if pricing logic changes.
export interface LineItem {
  description: string;
  quantity: number;
  unit_cost: number;
  total: number; // quantity * unit_cost
  // Optional per-line context (added with the ticket workflow). Older tickets
  // have none of these and still render as plain lines.
  start_date?: string | null; // first day this line covers (yyyy-mm-dd)
  end_date?: string | null; // last day; null/same = one day
  well_name?: string | null; // well this line is billed to
  section?: string | null; // section heading the line is grouped under
  service_id?: string | null; // job_services row this line bills (service charges)
}

// Field ticket lifecycle: an Area Manager/Admin builds it while Open, closes it
// when the work is all on it, and an Admin approves it.
export const FIELD_TICKET_STATUSES = ["open", "closed", "approved"] as const;
export type FieldTicketStatus = (typeof FIELD_TICKET_STATUSES)[number];
export const FIELD_TICKET_STATUS_LABEL: Record<FieldTicketStatus, string> = {
  open: "Open",
  closed: "Closed",
  approved: "Approved",
};
export const FIELD_TICKET_TYPES = ["service", "delivery"] as const;
export type FieldTicketType = (typeof FIELD_TICKET_TYPES)[number];
export const FIELD_TICKET_TYPE_LABEL: Record<FieldTicketType, string> = {
  service: "Service ticket",
  delivery: "Delivery ticket",
};

// One entry in a ticket's history log.
export interface TicketHistoryEntry {
  at: string; // ISO timestamp
  by: string | null; // actor name
  role?: string | null;
  action: string; // "Opened", "Saved", "Closed", "Reopened", "Approved", ...
  note?: string | null;
}

// Number of calendar days a line covers (inclusive), or null without dates.
export function lineDays(start?: string | null, end?: string | null): number | null {
  const parse = (d?: string | null) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(start);
  if (a == null) return null;
  const b = parse(end) ?? a;
  if (b < a) return null;
  return Math.round((b - a) / 86400000) + 1;
}

// Normalized well key for matching report wells to ticket lines.
export function wellKey(w: string | null | undefined): string {
  return String(w ?? "").toUpperCase().replace(/\s+/g, " ").trim();
}

// What's still missing before a ticket can be closed (empty = ready).
export function ticketCloseProblems(t: {
  ticket_type?: string | null;
  well_name?: string | null;
  line_items?: LineItem[] | null;
}): string[] {
  const out: string[] = [];
  const items = t.line_items ?? [];
  if (!t.ticket_type) out.push("Pick the ticket type (Service or Delivery).");
  if (items.length === 0) out.push("Add at least one line.");
  if (items.some((li) => !li.start_date)) out.push("Every line needs its dates.");
  if (items.some((li) => !(li.well_name || t.well_name)))
    out.push("Every line needs a well.");
  return out;
}

// A field ticket records billable field work performed on a job.
export interface FieldTicket {
  id: string;
  job_id: string;
  ticket_number: number; // human-friendly sequential number
  ticket_date: string; // first day of work (yyyy-mm-dd)
  ticket_end_date: string | null; // last day of work (yyyy-mm-dd); null = one day
  county: string | null; // county where the work was performed
  well_name: string | null;
  po_afe: string | null; // customer PO or AFE reference
  description: string | null;
  line_items: LineItem[]; // itemized billable lines
  asset_ids: string[]; // equipment used on the ticket
  amount: number | null; // billable amount ($) — line-item total or manual override
  comments: string | null;
  created_by: string | null;
  created_at: string;
  // Workflow (db/field-ticket-workflow.sql). Missing on older databases; the
  // server fills status = "open" and history = [] in that case.
  status: FieldTicketStatus;
  ticket_type: FieldTicketType | null;
  ordered_by: string | null;
  closed_at: string | null;
  closed_by: string | null;
  approved_at: string | null;
  approved_by: string | null;
  history: TicketHistoryEntry[];
}

// Human label for a ticket's work dates: "Oct 1, 2026" for one day, or
// "Sep 28 – Oct 2, 2026 (5 days)" for a range. Dates are plain calendar days.
export function workDatesLabel(
  start: string | null | undefined,
  end?: string | null,
): string {
  const parse = (d: string | null | undefined): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const a = parse(start);
  if (!a) return "—";
  const b = parse(end);
  const full = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (!b || b.getTime() <= a.getTime()) return full(a);
  const days = Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
  const sameYear = a.getFullYear() === b.getFullYear();
  const left = sameYear
    ? a.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : full(a);
  return `${left} – ${full(b)} (${days} days)`;
}

// Ticket work dates. With dated lines the day count is the distinct days the
// lines cover (gaps between sections aren't counted); otherwise it's the span.
export function ticketDatesLabel(t: {
  ticket_date: string | null | undefined;
  ticket_end_date?: string | null;
  line_items?: LineItem[] | null;
}): string {
  const dated = (t.line_items ?? []).filter((l) => l.start_date);
  if (dated.length === 0) return workDatesLabel(t.ticket_date, t.ticket_end_date);
  const days = new Set<string>();
  for (const l of dated) {
    const a = Date.UTC(+l.start_date!.slice(0, 4), +l.start_date!.slice(5, 7) - 1, +l.start_date!.slice(8, 10));
    const n = lineDays(l.start_date, l.end_date) ?? 1;
    for (let i = 0; i < n; i++) days.add(new Date(a + i * 86400000).toISOString().slice(0, 10));
  }
  const sorted = Array.from(days).sort();
  const span = workDatesLabel(sorted[0], sorted[sorted.length - 1]).replace(/ \(\d+ days\)$/, "");
  return sorted.length > 1 ? `${span} (${sorted.length} days)` : span;
}

// Sum of a set of line-item totals (the computed ticket subtotal).
export function lineItemsTotal(items: LineItem[] | null | undefined): number {
  return (items ?? []).reduce((s, li) => s + (Number(li.total) || 0), 0);
}

// Field ticket with parent-job context joined in (for list/detail views)
export interface FieldTicketWithJob extends FieldTicket {
  job_number: string;
  area: Area;
  job_status: JobStatus;
  customer_id: string;
  customer_name: string;
  // Customer contact details — used to fill the PDF header once a customer is
  // selected. Joined from the parent job's customer record.
  customer_contact: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  created_by_name: string | null;
  closed_by_name?: string | null;
  approved_by_name?: string | null;
}

// One signed-off report day on a job, and whether a ticket line covers it.
export interface TicketCoverageDay {
  well_name: string;
  date: string; // yyyy-mm-dd
  rate: number | null; // day rate from the report (AL57) or the job
  tickets: number[]; // ticket numbers whose lines cover this day
}
export interface TicketCoverage {
  days: TicketCoverageDay[];
  uncovered: number; // report days on no ticket
  doubled: number; // report days on more than one ticket
}

// ---- Field daily report + JSA shared bits ----------------------------------
export interface CrewMember {
  name: string;
  role?: string | null;
}

// Solids-control KPIs captured on a field daily report (mirrors the daily
// report workbook). All optional; numbers stored as-entered.
export interface DailyFieldKpis {
  mud_type?: string | null;
  mud_weight_ppg?: number | null;
  lgs_pct?: number | null;
  retort_roc_pct?: number | null;
  daily_fluid_recovery_bbl?: number | null;
  total_fluid_recovery_bbl?: number | null;
  daily_run_hours?: number | null;
  total_run_hours?: number | null;
  maintenance_hours?: number | null;
  // Per-centrifuge run hours. Original workbook: Centrifuge 1 = AA37/AA38,
  // Centrifuge 2 = AM37/AM38. Updated workbook (4 centrifuges): 1 = AA39/AA40,
  // 2 = AG39/AG40, 3 = AM39/AM40, 4 = AS39/AS40. Used to accrue each
  // centrifuge's actual hours to the asset mapped to that slot on the job.
  daily_run_hours_cent1?: number | null;
  total_run_hours_cent1?: number | null;
  daily_run_hours_cent2?: number | null;
  total_run_hours_cent2?: number | null;
  daily_run_hours_cent3?: number | null;
  total_run_hours_cent3?: number | null;
  daily_run_hours_cent4?: number | null;
  total_run_hours_cent4?: number | null;
  // Volume processed by Centrifuge 1 / 2 (bbls) — workbook cells AR60 / AR61.
  volume_processed_bbl?: number | null; // Centrifuge 1 (AR60)
  volume_processed_cent2_bbl?: number | null; // Centrifuge 2 (AR61)
  // Centrifuge operating parameters (workbook cells AA31–AA36).
  centrifuge_feed_rate_gpm?: number | null;
  centrifuge_feed_pump_speed_rpm?: number | null;
  centrifuge_bowl_speed_rpm?: number | null;
  centrifuge_backdrive_rpm?: number | null;
  centrifuge_feed_weight_ppg?: number | null;
  centrifuge_effluent_weight_ppg?: number | null;
  // Same six parameters for Centrifuge 2-4 (suffix _cent2/_cent3/_cent4).
  // Original workbook: Centrifuge 2 = AM31-AM36. Updated workbook:
  // Centrifuge 2/3/4 = AG/AM/AS rows 33-38. Centrifuge 1 uses the fields above.
  [k: `centrifuge_${string}_cent${2 | 3 | 4}`]: number | null | undefined;
  add_base_diesel_bbl?: number | null;
  add_water_bbl?: number | null;
  add_barite_bbl?: number | null;
  add_chemicals_bbl?: number | null;
  end_dumps_loaded?: number | null;
  cuttings_volume_bbl?: number | null;
  vac_trucks?: number | null;
  liquids_to_disposal_bbl?: number | null;
  // Accrued total for the CURRENT well — workbook cell AS57. This is a running
  // cumulative figure that grows each report day; the most recent report for a
  // well therefore holds that well's latest accrued amount. Used by the jobs
  // page "Accrued (current well)" column in preference to the day_rate×days
  // rollup, which is only a fallback for reports imported before this field.
  accrued_current_well?: number | null;
  // Billable day rate ($/day) for THIS report day — workbook cell AL57. The day
  // rate can change mid-job by operation/period, so each report carries its own
  // rate rather than the job holding one fixed value. Revenue's day_rate×days
  // fallback sums each report-day's own rate, and the job's displayed day rate
  // is taken from the most recent report that carried one.
  day_rate?: number | null;
}

export const SIGNOFF_STATUS = [
  "Pending sign-off",
  "Signed off",
  "Changes requested",
] as const;
export type SignoffStatus = (typeof SIGNOFF_STATUS)[number];

// A field daily report is created by a field tech per job per day.
// Field daily reports are now unified into DailyReport (source === "field").
// These aliases are kept so existing imports keep compiling; new code should
// prefer DailyReport / DailyReportWithLinks directly.
export type FieldDailyReport = DailyReport;
export type FieldDailyReportWithJob = DailyReportWithLinks;

// A JSA (Job Safety Analysis) step: one row of hazards + controls.
export interface JsaStep {
  id: string;
  jsa_id: string;
  step_order: number;
  step_description: string;
  hazards: string | null;
  controls: string | null;
}

export interface Jsa {
  id: string;
  job_id: string;
  jsa_number: number;
  jsa_date: string;
  well_name: string | null;
  task_description: string | null;
  ppe: string | null;
  crew: CrewMember[];
  status: SignoffStatus;
  submitted_by: string | null;
  signed_by: string | null;
  signed_at: string | null;
  change_notes: string | null;
  created_at: string;
}

export interface JsaWithJob extends Jsa {
  job_number: string;
  area: Area;
  job_status: JobStatus;
  customer_id: string;
  customer_name: string;
  submitted_by_name: string | null;
  signed_by_name: string | null;
  steps: JsaStep[];
}

export interface MaintenanceReport {
  id: string;
  asset_id: string;
  supervisor_id: string;
  work_type: WorkType;
  notes: string | null;
  report_date: string;
  status: ReportStatus;
  filed_at: string;
}

export interface SignOff {
  id: string;
  report_id: string;
  area_mgr_id: string;
  signed_at: string;
}

// An uploaded service report: an area manager or supervisor uploads a PDF
// (or other document) tied to a specific job where they are servicing
// equipment. The file bytes are stored base64 in the row, matching the
// certification / daily-report attachment pattern used elsewhere in the app.
export interface ServiceReport {
  id: string;
  job_id: string;
  file_name: string; // original uploaded filename
  file_mime: string; // e.g. application/pdf
  file_size: number; // bytes
  notes: string | null; // optional note from the uploader
  uploaded_by: string | null; // profile that uploaded the file
  created_at: string;
}

// Service report with job + uploader joined and flattened for display.
export interface ServiceReportWithLinks extends ServiceReport {
  job_number: string | null;
  well_name: string | null;
  area: Area | null;
  customer_name: string | null;
  uploaded_by_name: string | null;
}

export interface ReportPhoto {
  id: string;
  report_id: string;
  storage_path: string;
  file_name: string | null;
  created_at: string;
}

export interface AuditEvent {
  id: string;
  report_id: string;
  asset_id: string;
  actor_id: string | null;
  actor_name: string;
  actor_role: Role;
  action: string;
  occurred_at: string;
}

export const DAILY_REPORT_STATUS = [
  "Needs job match", // Excel imported but its well name matched no job yet
  "Pending Review",
  "Signed off",
  "Changes requested",
  // A corrected workbook for a day that was already signed off; waiting for
  // an Admin / Area Manager to apply it onto the original report.
  "Correction pending",
] as const;
export type DailyReportStatus = (typeof DAILY_REPORT_STATUS)[number];

// Structured analysis extracted from the email body
export interface DailyReportAnalysis {
  job_area_customer?: {
    job_number?: string | null;
    area?: string | null;
    customer?: string | null;
  };
  equipment?: string[]; // asset tags / equipment referenced
  work_completed?: string; // narrative of work done
  crew?: string[]; // crew members on site
  hours?: string | null; // hours / run-hours called out
  // Critical hand-entered fields that were blank on the imported day tab
  // (e.g. "Report date (D3)", "Measured depth (AI9)"). Set by email intake;
  // non-empty = reviewer is alerted and must check before signing off.
  missing_fields?: string[];
}

// Provenance for a single KPI value: which sheet/cell it was read from.
export interface KpiCellRef {
  sheet: string;
  cell: string;
  value: string | number | null;
}

// Well header context read from the top of the "Report Day N" sheet.
export interface DailyReportWellContext {
  operator?: string | null;
  company_man?: string | null;
  mud_company?: string | null;
  mud_engineer?: string | null;
  rig?: string | null;
  // "Rig Activity" section on the Report Day sheet (header AE8): the activity
  // type (AI8, e.g. "Drilling"/"POOH"), measured depth (AI9), day-tour
  // supervisor (AI11). Read verbatim from the emailed workbook.
  rig_activity?: string | null;
  meas_depth_ft?: number | null;
  supervisor?: string | null;
  // Crew notes / comments from cell B57 on the Report Day sheet.
  remarks?: string | null;
  // Spud date from cell AU6 ("Spud Date:" label in AQ6). Set day rate billing
  // starts on this date.
  spud_date?: string | null;
}

// Report origin. Emailed reports arrive as an Excel workbook and carry locked,
// Excel-sourced KPIs. Field reports are entered manually from a job's page and
// never carry KPIs (KPIs only ever come from the emailed workbook).
export type DailyReportSource = "email" | "field";

// Unified daily report. One record type covers both emailed (Excel) reports
// and manually-entered field reports, discriminated by `source`.
export interface DailyReport {
  id: string;
  source: DailyReportSource;
  // --- Email-sourced fields (null/empty for field reports) -----------------
  email_message_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  received_at: string;
  raw_body: string | null;
  analysis: DailyReportAnalysis;
  // KPIs are read directly from the emailed workbook's "Report Day N" sheet and
  // are locked (read-only). Field reports leave this empty.
  kpis: DailyFieldKpis;
  attachment_name: string | null;
  // Original submitted workbook, kept so the detail page can link to the real
  // document. Bytes are omitted from list/detail JSON and streamed on demand
  // from /api/daily-reports/:id/attachment; `has_attachment` is the UI flag.
  attachment_mime?: string | null;
  attachment_size?: number | null;
  has_attachment?: boolean;
  source_sheet: string | null; // e.g. "Report Day 1"
  report_day: number | null;
  kpi_cell_map: Record<string, KpiCellRef>;
  well_context: DailyReportWellContext;
  email_out_status: string | null;
  email_out_at: string | null;
  // --- Field-sourced fields (null/empty for emailed reports) ---------------
  report_number: number | null; // per-job sequence for field reports
  work_summary: string | null;
  crew_hours: number | null;
  crew: CrewMember[];
  asset_ids: string[];
  comments: string | null;
  submitted_by: string | null;
  submitted_by_name: string | null;
  signed_by: string | null;
  signed_by_name: string | null;
  signed_at: string | null;
  // --- Shared fields --------------------------------------------------------
  area: Area | null;
  customer_id: string | null;
  job_id: string | null;
  report_date: string | null;
  well_name: string | null;
  summary: string | null;
  status: DailyReportStatus;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  change_notes: string | null;
  // True once this report's daily run hours (M33) have been rolled into the
  // centrifuge assets on its job at sign-off. Guards against double-counting if
  // a report is somehow reviewed twice.
  run_hours_applied: boolean;
  created_at: string;
}

// One centrifuge on a report's job, used when the reviewer allocates the day's
// run hours across multiple centrifuges at sign-off.
export interface CentrifugeOnJob {
  id: string;
  tag: string;
  is_rental?: boolean;
  rental_vendor?: string | null;
  category: Category;
  run_hours: number | null;
  // Which centrifuge column this asset is mapped to on the job (1-4), or
  // null when it has not been mapped yet. Drives slot-based run-hours accrual.
  centrifuge_slot: number | null;
}

// What GET /api/daily-reports/:id/centrifuges returns so the sign-off UI can
// decide whether to auto-apply (0 or 1 centrifuge) or prompt for a per-asset
// split (2+ centrifuges).
export interface ReportRunHoursContext {
  daily_run_hours: number | null; // combined day hours (Centrifuge 1, AA37)
  // Per-centrifuge daily hours read from the workbook (slots 1-4). Null when
  // the report did not carry that slot's value (the original workbook only
  // has Centrifuge 1 and 2).
  daily_run_hours_cent1: number | null;
  daily_run_hours_cent2: number | null;
  daily_run_hours_cent3: number | null;
  daily_run_hours_cent4: number | null;
  // Sum of Centrifuge 1-4 day hours on the report (null = none).
  day_total_hours?: number | null;
  // Hours a lone centrifuge on the job receives at sign-off (its own column).
  solo_hours?: number | null;
  already_applied: boolean;
  centrifuges: CentrifugeOnJob[];
  // True when the job has 2+ run-hour assets and at least one of them has no
  // centrifuge_slot mapping — accrual is blocked until every centrifuge is
  // mapped so hours are never applied to the wrong asset.
  needs_slot_mapping: boolean;
}

// A per-asset allocation of the day's run hours, supplied at sign-off when a
// job has 2+ centrifuges.
export interface RunHourAllocation {
  asset_id: string;
  hours: number;
}

// Daily report joined with customer + job identifiers for lists/detail
export interface DailyReportWithLinks extends DailyReport {
  customer_name: string | null;
  job_number: string | null;
  job_status: JobStatus | null;
}

export interface DailyReportEvent {
  id: string;
  report_id: string;
  actor_id: string | null;
  actor_name: string;
  actor_role: Role;
  action: string;
  detail: string | null;
  occurred_at: string;
}

export interface DailyReportConfig {
  id: number;
  inbox_email: string | null;
  gmail_query: string;
  active: boolean;
  updated_at: string;
}

export interface NotificationPrefs {
  user_id: string;
  on_signed: boolean;
  on_needs_signoff: boolean;
  on_filed: boolean;
}

// ---- Insert / validation schemas -------------------------------------------
// Password rule shared by manual create and password reset. No length or
// strength rule (owner decision 2026-10-27) — any non-empty password. Short
// passwords are padded server-side (authPw in routes.ts) to satisfy Supabase.
const strongPassword = z
  .string()
  .min(1, "Enter a password");

// Creating a user supports two modes:
//   - "invite": no password; the system emails a secure set-password link.
//   - "password": admin sets a temporary password now (password required).
// Password is optional at the schema level and validated per-mode in the route.
export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  // Default to "password" (admin sets credentials and shares them). Email
  // invites remain supported but are dormant unless an email provider is set up.
  mode: z.enum(["invite", "password"]).default("password"),
  password: strongPassword.optional(),
  // Password mode only: when true, the user must set a new password on first
  // login before they can use the app.
  requirePasswordChange: z.boolean().optional().default(true),
  role: z.enum(ROLES),
  area: z.enum(AREAS).nullable().optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// A signed-in user changing their own password. `currentPassword` is required
// to re-authenticate; unless they are completing a forced first-login change,
// where the current (temporary) password is re-entered too.
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: strongPassword,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  area: z.enum(AREAS).nullable().optional(),
  active: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// Day rate: accept a non-negative number, or null/blank to clear it.
// Note: null/"" are checked BEFORE coercion so clearing the field stays null
// (z.coerce.number() would otherwise turn null/"" into 0).
const dayRateField = z
  .union([
    z.null(),
    z.literal("").transform(() => null),
    z.coerce.number().nonnegative(),
  ])
  .optional();

// Rental fields (third-party rented units). Dates are yyyy-mm-dd or null.
const optDate = z
  .union([z.null(), z.literal("").transform(() => null), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")])
  .optional();
const optText = z
  .union([z.null(), z.string().trim().transform((v) => (v ? v : null))])
  .optional();
const rentalFields = {
  is_rental: z.boolean().optional(),
  rental_vendor: optText,
  rental_ref: optText,
  rental_monthly_rate: dayRateField,
  rental_start: optDate,
  rental_end: optDate,
  rental_notes: optText,
};

// Centrifuge slot: 1-4 ("Centrifuge 1" .. "Centrifuge 4"), or null/blank to
// clear. null/"" are checked before coercion so clearing stays null. Any value
// outside 1-4 is rejected.
const centrifugeSlotField = z
  .union([
    z.null(),
    z.literal("").transform(() => null),
    z.coerce.number().int().refine((n) => n >= 1 && n <= 4, {
      message: "Centrifuge slot must be 1, 2, 3, or 4",
    }),
  ])
  .optional();

// Asset status is derived from the job link: on a job = "On Job", otherwise
// "Available". The one exception is a rental unit sent back to its vendor,
// which stays "Returned" so it drops out of the fleet lists.
export const ASSET_STATUSES = ["On Job", "Available"] as const;
export const RETURNED_RENTAL_STATUS = "Returned";
export function assetStatusFor(jobId: string | null | undefined, current?: string | null): string {
  if (jobId) return "On Job";
  if (current === RETURNED_RENTAL_STATUS) return RETURNED_RENTAL_STATUS;
  return "Available";
}
export const assetStatusLabel = (a: { job_id?: string | null; status?: string | null }) =>
  assetStatusFor(a.job_id, a.status);

export const createAssetSchema = z.object({
  tag: z.string().min(1),
  category: z.enum(CATEGORIES),
  area: z.enum(AREAS),
  description: z.string().nullable().optional(),
  maintenance_schedule_id: z.string().uuid().nullable().optional(),
  job_or_well: z.string().nullable().optional(),
  status: z.string().optional(),
  run_hours: z.number().int().nonnegative().nullable().optional(),
  service_hours_interval: z.number().int().positive().optional(),
  day_rate: dayRateField,
  centrifuge_slot: centrifugeSlotField,
  ...rentalFields,
});
export type CreateAssetInput = z.infer<typeof createAssetSchema>;

export const createMaintenanceScheduleSchema = z.object({
  name: z.string().min(1),
  cadence: z.enum(SCHEDULE_CADENCE),
  interval_value: z.number().int().positive(),
  notes: z.string().nullable().optional(),
});
export type CreateMaintenanceScheduleInput = z.infer<
  typeof createMaintenanceScheduleSchema
>;
export const updateMaintenanceScheduleSchema =
  createMaintenanceScheduleSchema.partial();
export type UpdateMaintenanceScheduleInput = z.infer<
  typeof updateMaintenanceScheduleSchema
>;

export const createReportSchema = z.object({
  asset_id: z.string().uuid(),
  work_type: z.enum(WORK_TYPES),
  notes: z.string().nullable().optional(),
  report_date: z.string(),
  run_hours: z.number().int().nonnegative().nullable().optional(), // updates asset meter
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

// ---- Structured centrifuge service report ---------------------------------
// Digital replacement for the Mitti/SafetyCulture centrifuge maintenance
// report. Each checklist item is a Pass/Fail question (mirroring the paper
// form) with an optional note. Items are stored as data on the maintenance
// report so the whole report is queryable (score, flagged items, history)
// instead of living inside an opaque uploaded PDF. Photos are attached
// separately (maintenance_report_files rows linked by report_id).
//
// The `key` is a stable identifier so we can trend a specific item over time
// even if the display label is reworded later.
export interface ServiceChecklistItemDef {
  key: string;
  label: string;
  // When true, a "No" answer means the item is GOOD (the question is phrased
  // negatively, e.g. "No abnormal wear on RA?"). Answering "No" flags it.
  // When false, "Yes" is good and "No" flags it.
}

// The 13-item centrifuge inspection, in the same order as the Mitti report.
// `flagOn` is the answer that indicates a problem (drives flagged-item count
// and auto work-order creation).
//
// `kind` (default "yes_no"):
//   yes_no    → Yes / No / N/A buttons; flagOn is the problem answer.
//   condition → the item's `options` (e.g. Good / OK / Poor); flagOn = "Poor".
//   text      → fill-in answer (e.g. pond depth). Not scored, never flagged.
export type ServiceChecklistKind = "yes_no" | "condition" | "text";
export const CENTRIFUGE_SERVICE_CHECKLIST: {
  key: string;
  label: string;
  flagOn: string | null;
  kind?: ServiceChecklistKind;
  options?: readonly string[];
  placeholder?: string;
}[] = [
  { key: "gearbox_oil", label: "Was gear box oil checked?", flagOn: "No" },
  { key: "back_drive_bearings", label: "Back drive bearings greased", flagOn: "No" },
  { key: "back_drive_coupling", label: "Back drive coupling in good condition and has all screws", flagOn: "No" },
  { key: "inner_outer_bearings", label: "Inner and outer bearings greased?", flagOn: "No" },
  { key: "back_drive_belt", label: "Back drive belt in good condition?", flagOn: "No" },
  { key: "main_drive_belt", label: "Main drive belt in good condition?", flagOn: "No" },
  { key: "feed_tube", label: "Feed tube in good condition?", flagOn: "No" },
  { key: "no_abnormal_wear_ra", label: "No abnormal wear on RA?", flagOn: "No" },
  { key: "thrust_bearing_purged", label: "Thrust bearing purged", flagOn: "No" },
  { key: "electrical_wires", label: "Electrical wires in good condition?", flagOn: "No" },
  { key: "coffin_clamps", label: "Coffin clamps close coffin lid properly?", flagOn: "No" },
  { key: "no_coffin_cracks", label: "No cracks on coffin or abnormal damage?", flagOn: "No" },
  { key: "coffin_gasket", label: "Coffin gasket seals properly?", flagOn: "No" },
  // Added 2026-10-27.
  {
    key: "plow_condition",
    label: "Plow condition",
    kind: "condition",
    options: ["Good", "OK", "Poor"],
    flagOn: "Poor",
  },
  {
    key: "pond_depth",
    label: "Pond depth",
    kind: "text",
    flagOn: null,
    placeholder: "e.g. 2.5 in",
  },
];

export const SERVICE_ANSWERS = ["Yes", "No", "N/A"] as const;
export type ServiceAnswer = (typeof SERVICE_ANSWERS)[number];

// One answered checklist row as stored in the report's `checklist` jsonb.
export interface ServiceChecklistAnswer {
  key: string;
  label: string;
  // Yes / No / N/A, a condition (Good / OK / Poor) or a fill-in value.
  answer: string;
  kind?: ServiceChecklistKind; // missing on older reports = yes_no
  flagged: boolean; // computed server-side from flagOn
  note: string | null;
}

const serviceChecklistAnswerSchema = z.object({
  key: z.string().min(1),
  // Checked against the item's kind on the server.
  answer: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).nullable().optional(),
});

// One inline photo submitted with a structured service report.
const serviceReportPhotoSchema = z.object({
  file_name: z.string().min(1).max(200),
  file_mime: z.string().min(1).max(100),
  file_base64: z.string().min(1),
  caption: z.string().trim().max(200).nullable().optional(),
});

// Payload for filing a structured centrifuge service report in-app.
// The asset is chosen directly (no external asset number). The optional
// run-hours reading resets the service baseline exactly like a maintenance
// report. Photos are optional and stored as linked files.
export const createServiceReportSchema = z.object({
  asset_id: z.string().uuid("Choose an asset"),
  report_date: z.string().min(1, "A service date is required"),
  run_hours: z.number().int().nonnegative().nullable().optional(),
  work_performed: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  checklist: z.array(serviceChecklistAnswerSchema).min(1, "Answer the checklist"),
  photos: z.array(serviceReportPhotoSchema).max(24).optional(),
});
export type CreateServiceReportInput = z.infer<typeof createServiceReportSchema>;

// A filed structured service report joined for detail/list display.
export interface ServiceReportDetail {
  id: string;
  asset_id: string;
  asset_tag: string | null;
  asset_category: Category | null;
  area: Area | null;
  supervisor_id: string;
  supervisor_name: string | null;
  report_date: string;
  filed_at: string;
  status: ReportStatus;
  run_hours: number | null;
  work_performed: string | null;
  notes: string | null;
  score_pass: number;
  score_total: number;
  flagged_count: number;
  checklist: ServiceChecklistAnswer[];
  photo_count: number;
}

// Service report upload payload. The uploader is taken from the session; the
// job must be one in the uploader's area (enforced server-side). File bytes
// arrive base64-encoded (no data: prefix), matching the certification upload.
export const uploadServiceReportSchema = z.object({
  job_id: z.string().uuid(),
  file_name: z.string().min(1, "File name is required"),
  file_mime: z.string().min(1).optional(),
  file_base64: z.string().min(1, "A file is required"),
  notes: z.string().nullable().optional(),
});
export type UploadServiceReportInput = z.infer<
  typeof uploadServiceReportSchema
>;

// Maintenance report file upload payload. Attaches a document (PDF) to a
// specific asset. The uploader is taken from the session; the asset must be in
// the uploader's area (enforced server-side). File bytes arrive base64-encoded
// (no data: prefix), matching the certification + service-report uploads.
export const uploadMaintenanceFileSchema = z.object({
  file_name: z.string().min(1, "File name is required"),
  file_mime: z.string().min(1).optional(),
  file_base64: z.string().min(1, "A file is required"),
  work_performed: z
    .string()
    .trim()
    .min(1, "Describe the work performed"),
  notes: z.string().nullable().optional(),
});
export type UploadMaintenanceFileInput = z.infer<
  typeof uploadMaintenanceFileSchema
>;

export const createCustomerSchema = z.object({
  name: z.string().min(1),
  primary_contact: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  email: z.string().email().nullable().optional().or(z.literal("")),
  notes: z.string().nullable().optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema.partial().extend({
  active: z.boolean().optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const createJobSchema = z.object({
  job_number: z.string().min(1),
  area: z.enum(AREAS),
  customer_id: z.string().uuid(),
  description: z.string().nullable().optional(),
  status: z.enum(JOB_STATUS).optional(),
  crewing: z.enum(CREWING).optional(),
  started_on: z.string().nullable().optional(),
  ended_on: z.string().nullable().optional(),
  day_rate: dayRateField,
  // Well name — used to match emailed Excel daily reports to this job.
  well_name: z.string().nullable().optional(),
  // asset ids to assign to this job on creation
  asset_ids: z.array(z.string().uuid()).optional(),
  // field-tech profile ids assigned to this job on creation. Field techs are
  // scoped to only the jobs they are assigned to (see jobScopeOf on the server).
  field_tech_ids: z.array(z.string().uuid()).optional(),
  // supervisor profile ids assigned to this job on creation. Assigning a
  // supervisor lets them log drive-by / call-out services on unmanned jobs.
  supervisor_ids: z.array(z.string().uuid()).optional(),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const updateJobSchema = z.object({
  // Rename the job (Admin / Area Manager only — enforced on the server).
  job_number: z.string().trim().min(1, "Job name can't be blank").max(100).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(JOB_STATUS).optional(),
  crewing: z.enum(CREWING).optional(),
  started_on: z.string().nullable().optional(),
  ended_on: z.string().nullable().optional(),
  day_rate: dayRateField,
  manual_day_rate: z.boolean().optional(),
  manual_billing_mode: z.enum(["report_days", "spud_to_latest", "calendar"]).optional(),
  well_name: z.string().nullable().optional(),
  // when present, replaces the full set of field-tech assignments for the job
  field_tech_ids: z.array(z.string().uuid()).optional(),
  // when present, replaces the full set of supervisor assignments for the job
  supervisor_ids: z.array(z.string().uuid()).optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

// ==== Job services (drive-by / call-out on unmanned jobs) ==================
// "Service Charge" (any job) is billed to the customer: it counts toward the
// job's revenue and can be pulled onto a field ticket. Drive-by / Call-out are
// the original unmanned-job visit types and bill the same way.
export const SERVICE_TYPES = ["Service Charge", "Drive-by Service", "Call-out Service"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface JobService {
  id: string;
  job_id: string;
  area: Area;
  service_type: ServiceType;
  service_date: string; // yyyy-mm-dd
  cost: number | null;
  well_id: string | null; // the well that was open when service was performed
  well_name: string | null; // snapshot of the well name at time of logging
  notes: string | null; // description: what was done and why
  asset_id?: string | null; // equipment the service was for (optional)
  asset_tag?: string | null; // joined for display
  asset_category?: string | null; // joined for display
  on_ticket?: number | null; // field ticket number it's billed on, if any
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

const serviceCostField = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "string" ? Number(v) : v;
    return Number.isFinite(n) ? n : null;
  })
  .refine((v) => v === null || (v as number) >= 0, {
    message: "Cost must be zero or greater",
  });

export const createJobServiceSchema = z.object({
  service_type: z.enum(SERVICE_TYPES),
  service_date: z.string().min(1, "Service date is required"),
  cost: serviceCostField.refine((v) => v !== null, { message: "Enter the cost to bill" }),
  well_id: z.string().uuid().nullable().optional(),
  asset_id: z.string().uuid().nullable().optional(),
  notes: z
    .string({ required_error: "Describe what was done" })
    .trim()
    .min(1, "Describe what was done")
    .max(2000),
});
export type CreateJobServiceInput = z.infer<typeof createJobServiceSchema>;

export const updateJobServiceSchema = z.object({
  service_type: z.enum(SERVICE_TYPES).optional(),
  service_date: z.string().min(1).optional(),
  cost: serviceCostField,
  well_id: z.string().uuid().nullable().optional(),
  asset_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().min(1, "Describe what was done").max(2000).optional(),
});
export type UpdateJobServiceInput = z.infer<typeof updateJobServiceSchema>;

// A field tech assigned to a job. Only field-role profiles are assignable.
export interface JobAssignment {
  id: string;
  job_id: string;
  profile_id: string;
  assigned_by: string | null;
  created_at: string;
}

// Job assignment joined with the assigned tech's name/role (for job detail).
export interface JobAssignmentWithName extends JobAssignment {
  profile_name: string | null;
  profile_role: Role | null;
}

// ---- Pad / Well schemas ----------------------------------------------------
// Roles allowed to create pads and open/close wells: the whole field workforce
// plus admins. (Area managers, supervisors, field techs, and admins.)
export const WELL_MANAGE_ROLES = ["admin", "area", "super", "field"] as const;

export const createPadSchema = z.object({
  // Pad names are auto-assigned server-side as generic sequential labels
  // ("Pad 1", "Pad 2", ...). The wells grouped inside a pad distinguish it, so
  // a caller-supplied name is optional and ignored.
  name: z.string().trim().optional(),
  // Optional wells to create with the pad (names only). Blank entries ignored.
  well_names: z.array(z.string()).optional(),
});
export type CreatePadInput = z.infer<typeof createPadSchema>;

// Rename a pad. Pads default to auto-numbered labels ("Pad 1", ...) but can be
// given a custom name.
export const renamePadSchema = z.object({
  name: z.string().trim().min(1, "Pad name is required").max(80),
});
export type RenamePadInput = z.infer<typeof renamePadSchema>;

export const createWellSchema = z.object({
  name: z.string().trim().min(1, "Well name is required"),
});
export type CreateWellInput = z.infer<typeof createWellSchema>;

// Open a well. Optional as_of date (yyyy-mm-dd); defaults to today server-side.
// Opening auto-closes whatever well is currently open on the same pad.
export const openWellSchema = z.object({
  as_of: z.string().nullable().optional(),
});
export type OpenWellInput = z.infer<typeof openWellSchema>;

export const closeWellSchema = z.object({
  as_of: z.string().nullable().optional(),
});
export type CloseWellInput = z.infer<typeof closeWellSchema>;

// Close an entire pad (closes any open well on it too).
export const closePadSchema = z.object({
  as_of: z.string().nullable().optional(),
});
export type ClosePadInput = z.infer<typeof closePadSchema>;

// Assign an unmatched (Excel-imported) daily report to a job.
export const assignDailyReportJobSchema = z.object({
  job_id: z.string().uuid(),
});
export type AssignDailyReportJobInput = z.infer<typeof assignDailyReportJobSchema>;

// Assign / unassign an asset to a job (and optionally flip its status)
export const updateAssetSchema = z.object({
  tag: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  job_id: z.string().uuid().nullable().optional(),
  status: z.string().optional(),
  job_or_well: z.string().nullable().optional(),
  service_hours_interval: z.number().int().positive().optional(),
  area: z.enum(AREAS).optional(),
  description: z.string().nullable().optional(),
  maintenance_schedule_id: z.string().uuid().nullable().optional(),
  day_rate: dayRateField,
  centrifuge_slot: centrifugeSlotField,
  ...rentalFields,
});
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;

// ---- Field ticket schema ---------------------------------------------------
// Billable amount: non-negative number, or null/blank to leave unset.
const amountField = z
  .union([
    z.null(),
    z.literal("").transform(() => null),
    z.coerce.number().nonnegative(),
  ])
  .optional();

// One line item as accepted from the client. Total is recomputed server-side
// from quantity × unit_cost, so a client-sent total is advisory only.
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates must be yyyy-mm-dd")
  .nullable()
  .optional();
export const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().nonnegative(),
  unit_cost: z.coerce.number().nonnegative(),
  start_date: ymd,
  end_date: ymd,
  well_name: z.string().nullable().optional(),
  section: z.string().nullable().optional(),
  service_id: z.string().uuid().nullable().optional(),
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

export const createFieldTicketSchema = z.object({
  // Optional hand-entered ticket number; blank = next automatic number.
  ticket_number: z.coerce.number().int().positive().nullable().optional(),
  ticket_type: z.enum(FIELD_TICKET_TYPES).nullable().optional(),
  ordered_by: z.string().nullable().optional(),
  ticket_date: z.string().min(1), // start of work (derived from line dates when they have them)
  ticket_end_date: z.string().nullable().optional(), // end of work (null = one day)
  county: z.string().nullable().optional(),
  well_name: z.string().nullable().optional(),
  po_afe: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  line_items: z.array(lineItemSchema).optional(),
  asset_ids: z.array(z.string().uuid()).optional(),
  amount: amountField,
  comments: z.string().nullable().optional(),
});
export type CreateFieldTicketInput = z.infer<typeof createFieldTicketSchema>;

export const updateFieldTicketSchema = createFieldTicketSchema.partial();
export type UpdateFieldTicketInput = z.infer<typeof updateFieldTicketSchema>;

// ---- Daily report schemas --------------------------------------------------
// Ingest payload written by the scheduled email task. The task's ONLY job is to
// deliver the email metadata plus the raw Excel attachment (base64). The server
// parses the workbook and reads all daily-report values directly from the
// "Report Day N" sheet — no body-text interpretation. This guarantees every
// value in the app comes straight from the emailed spreadsheet.
export const ingestDailyReportSchema = z.object({
  email_message_id: z.string().min(1),
  sender_email: z.string().email(),
  sender_name: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  received_at: z.string().optional(),
  // The .xlsx attachment, base64-encoded, exactly as received on the email.
  attachment_base64: z.string().min(1, "Excel attachment (base64) is required"),
  attachment_name: z.string().min(1),
  // Optional: which "Report Day N" sheet to read. Defaults to the latest
  // populated report-day sheet in the workbook.
  report_day: z.number().int().positive().nullable().optional(),
});
export type IngestDailyReportInput = z.infer<typeof ingestDailyReportSchema>;

// Manual backfill: an admin/area manager uploads a daily-report workbook that
// already has several completed day tabs, and the server loads EVERY completed
// day (day 1 .. latest) in one shot. Used during rollout to seed a job's prior
// days. Backfilled days are imported already signed off (historical) and their
// centrifuge run hours are accrued, evenly split across the job's centrifuges.
export const backfillDailyReportSchema = z.object({
  attachment_base64: z.string().min(1, "Excel workbook (base64) is required"),
  attachment_name: z.string().min(1),
});
export type BackfillDailyReportInput = z.infer<
  typeof backfillDailyReportSchema
>;

// One row per imported day in the backfill response, so the UI can show a
// per-day result summary (matched job, run hours applied, or skipped/duplicate).
export interface BackfillDayResult {
  report_day: number;
  source_sheet: string;
  report_date: string | null;
  well_name: string | null;
  status: "imported" | "duplicate" | "error";
  daily_report_status: DailyReportStatus | null;
  matched_job: boolean;
  run_hours_applied: string | null;
  message: string | null;
}
export interface BackfillDailyReportResult {
  well_name: string | null;
  matched_job: boolean;
  days_found: number;
  days_imported: number;
  days_duplicate: number;
  days_error: number;
  results: BackfillDayResult[];
}

// Reviewer action: sign off OR request changes
export const reviewDailyReportSchema = z
  .object({
    action: z.enum(["sign_off", "request_changes"]),
    change_notes: z.string().nullable().optional(),
    // Fields/cells the reviewer ticked as needing a fix (e.g. "Measured
    // depth (AI9)"). Listed first in the note sent back to the crew.
    change_fields: z.array(z.string().max(120)).max(30).optional(),
    // Optional per-centrifuge split of the day's run hours, supplied only when
    // signing off a report whose job has 2+ centrifuges. When omitted, the
    // server auto-applies the full day's hours to a single centrifuge (or none).
    run_hour_allocations: z
      .array(
        z.object({
          asset_id: z.string().min(1),
          hours: z.number().min(0),
        }),
      )
      .optional(),
  })
  .refine(
    (d) =>
      d.action !== "request_changes" ||
      !!(d.change_notes && d.change_notes.trim()) ||
      !!(d.change_fields && d.change_fields.length),
    { message: "Tick what needs fixing or type a note when requesting changes.", path: ["change_notes"] },
  );
export type ReviewDailyReportInput = z.infer<typeof reviewDailyReportSchema>;

export const updateDailyReportConfigSchema = z.object({
  inbox_email: z.string().email().nullable().optional().or(z.literal("")),
  gmail_query: z.string().min(1).optional(),
  active: z.boolean().optional(),
});
export type UpdateDailyReportConfigInput = z.infer<typeof updateDailyReportConfigSchema>;

// ---- JSA (Job Safety Analysis) intake --------------------------------------
// JSAs are forwarded to the same inbox as daily reports. The scheduled email
// task sorts them by the subject keyword "JSA" and routes them here. A JSA is
// an acknowledgement-only record: we confirm receipt, capture which job it came
// from (parsed from the subject job number) and its date, keep the original
// file as a downloadable attachment, and require ONE supervisor/area manager in
// the job's area to sign it off. We do not extract fields from the document.
export const JSA_STATUS = [
  "Needs job match", // received but its job number matched no job
  "Pending sign-off",
  "Signed off",
] as const;
export type JsaStatus = (typeof JSA_STATUS)[number];

export interface JsaReport {
  id: string;
  email_message_id: string | null;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  received_at: string;
  jsa_date: string | null;
  area: Area | null;
  customer_id: string | null;
  job_id: string | null;
  job_number_raw: string | null; // job number as parsed from the subject
  attachment_name: string;
  attachment_mime: string | null;
  attachment_size: number | null;
  status: JsaStatus;
  signed_off_by: string | null;
  signed_off_by_name: string | null;
  signed_off_at: string | null;
  created_at: string;
}

// JSA joined with customer + job identifiers for lists/detail. The attachment
// bytes are never included here — they are streamed from a dedicated download
// endpoint so list/detail payloads stay small.
export interface JsaReportWithLinks extends JsaReport {
  customer_name: string | null;
  job_number: string | null;
}

export interface JsaReportEvent {
  id: string;
  jsa_id: string;
  actor_id: string | null;
  actor_name: string;
  actor_role: Role;
  action: string;
  detail: string | null;
  occurred_at: string;
}

// Ingest payload written by the scheduled email task for a JSA email. The task
// only delivers email metadata plus the raw attachment (base64). The server
// parses the job number from the subject and matches it to a job.
export const ingestJsaSchema = z.object({
  email_message_id: z.string().min(1),
  sender_email: z.string().email(),
  sender_name: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  received_at: z.string().optional(),
  jsa_date: z.string().nullable().optional(),
  // The original JSA file (usually a PDF), base64-encoded.
  attachment_base64: z.string().min(1, "JSA attachment (base64) is required"),
  attachment_name: z.string().min(1),
  attachment_mime: z.string().nullable().optional(),
  // Optional override; normally the server parses the job number from subject.
  job_number: z.string().nullable().optional(),
});
export type IngestJsaInput = z.infer<typeof ingestJsaSchema>;

// Assign an unmatched JSA to a job.
export const assignJsaJobSchema = z.object({
  job_id: z.string().uuid(),
});
export type AssignJsaJobInput = z.infer<typeof assignJsaJobSchema>;

// ---- Certifications --------------------------------------------------------
// Safety certifications tracked per field employee (area managers, supervisors,
// field techs). Admins and area managers upload certificate files and record
// expiry dates so compliance can be tracked at a glance.

// Roles that appear on the certifications roster (field workforce only).
export const CERT_ROSTER_ROLES: Role[] = ["area", "super", "field"];

// Common oilfield safety certifications, offered in the upload dropdown. Users
// may also type a custom value.
export const CERT_TYPES = [
  "H2S",
  "First Aid / CPR",
  "Heavy Equipment",
  "PEC Safeland",
  "OSHA",
  "Defensive Driving",
  "Forklift",
] as const;

// Derived compliance status; never stored — computed from expiry_date.
export const CERT_STATUS = [
  "Compliant",
  "Expiring soon",
  "Expired",
  "No expiry",
] as const;
export type CertStatus = (typeof CERT_STATUS)[number];

// Certs within this many days of expiring are flagged "Expiring soon".
export const CERT_EXPIRING_SOON_DAYS = 30;

// Derive compliance status from an expiry date (ISO yyyy-mm-dd or null).
// `today` defaults to now; passable for deterministic tests.
export function certStatusOf(
  expiry_date: string | null,
  today: Date = new Date(),
): CertStatus {
  if (!expiry_date) return "No expiry";
  const exp = new Date(expiry_date + "T00:00:00");
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const days = Math.round((exp.getTime() - start.getTime()) / 86400000);
  if (days < 0) return "Expired";
  if (days <= CERT_EXPIRING_SOON_DAYS) return "Expiring soon";
  return "Compliant";
}

export interface Certification {
  id: string;
  profile_id: string;
  cert_type: string;
  issuing_org: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  attachment_size: number | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
}

// Certification joined with employee + uploader names for lists. Attachment
// bytes are never included — they stream from a dedicated download endpoint.
export interface CertificationWithNames extends Certification {
  employee_name: string | null;
  employee_role: Role | null;
  employee_area: Area | null;
  uploaded_by_name: string | null;
}

// A field employee grouped with their certifications for the roster view.
export interface CertRosterEntry {
  profile: Profile;
  certs: CertificationWithNames[];
}

const dateOpt = z
  .union([z.null(), z.literal("").transform(() => null), z.string()])
  .optional();

// Create-certification payload. The certificate file is optional (a cert can be
// recorded before its scan is available) but when present is base64-encoded.
export const createCertificationSchema = z.object({
  profile_id: z.string().uuid(),
  cert_type: z.string().min(1, "Certification type is required"),
  issuing_org: z.string().nullable().optional(),
  issue_date: dateOpt,
  expiry_date: dateOpt,
  notes: z.string().nullable().optional(),
  attachment_base64: z.string().nullable().optional(),
  attachment_name: z.string().nullable().optional(),
  attachment_mime: z.string().nullable().optional(),
});
export type CreateCertificationInput = z.infer<typeof createCertificationSchema>;

// Partial update for a certification (dates, org, notes).
export const updateCertificationSchema = z.object({
  cert_type: z.string().min(1).optional(),
  issuing_org: z.string().nullable().optional(),
  issue_date: dateOpt,
  expiry_date: dateOpt,
  notes: z.string().nullable().optional(),
});
export type UpdateCertificationInput = z.infer<typeof updateCertificationSchema>;

// ---- Rig-up Reports --------------------------------------------------------
// Supervisors and area managers upload rig-up report files for a specific job.
// Each report is tracked to a status and must be signed off by an AREA MANAGER
// whose area matches the job's area (admins may also sign off). We store the
// uploaded file as a downloadable attachment; we do not extract fields from it.
export const RIG_UP_STATUS = ["Pending sign-off", "Signed off"] as const;
export type RigUpStatus = (typeof RIG_UP_STATUS)[number];

// Who may upload a rig-up report (admins, area managers, supervisors).
export const RIG_UP_UPLOAD_ROLES: Role[] = ["admin", "area", "super"];
// Who may sign off a rig-up report: an AREA manager for the job's area (admins
// too). Supervisors can upload but cannot sign off.
export const RIG_UP_SIGNOFF_ROLES: Role[] = ["admin", "area"];

export interface RigUpReport {
  id: string;
  job_id: string;
  area: Area;
  customer_id: string | null;
  report_date: string | null;
  title: string | null;
  notes: string | null;
  attachment_name: string | null; // null for in-app inspections
  attachment_mime: string | null;
  attachment_size: number | null;
  status: RigUpStatus;
  // In-app rig inspection fields (kind = "inspection"); null for uploads.
  kind: RigUpKind;
  site_conducted: string | null;
  rig_number: string | null;
  conducted_on: string | null;
  prepared_by: string | null;
  score_pass: number | null;
  score_total: number | null;
  flagged_count: number | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  signed_off_by: string | null;
  signed_off_by_name: string | null;
  signed_off_at: string | null;
  created_at: string;
}

// Rig-up report joined with customer + job identifiers for lists/detail. The
// attachment bytes are never included here — they stream from a download route.
export interface RigUpReportWithLinks extends RigUpReport {
  customer_name: string | null;
  job_number: string | null;
  photo_count?: number;
}

// Full rig-up report for the inspection detail view.
export interface RigUpReportDetail extends RigUpReportWithLinks {
  well_name: string | null;
  checklist: RigInspectionAnswer[] | null;
  photos: { id: string; file_name: string; file_mime: string; caption: string | null; created_at: string }[];
}

export interface RigUpReportEvent {
  id: string;
  rig_up_id: string;
  actor_id: string | null;
  actor_name: string;
  actor_role: Role;
  action: string;
  detail: string | null;
  occurred_at: string;
}

// Create/upload payload for a rig-up report. The file is required and base64-
// encoded; the job is chosen by the uploader (must be in their area).
export const createRigUpReportSchema = z.object({
  job_id: z.string().uuid(),
  report_date: dateOpt,
  title: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  attachment_base64: z.string().min(1, "A rig-up report file is required"),
  attachment_name: z.string().min(1, "A rig-up report file is required"),
  attachment_mime: z.string().nullable().optional(),
});
export type CreateRigUpReportInput = z.infer<typeof createRigUpReportSchema>;

// ---- In-app rig inspection (rig-up report form) ----------------------------
// Digital version of the "Official Rig Inspection" Mitti template (added
// 2026-10-27). Same questions, same order, same Yes / No / N/A answers. Items
// marked * on the paper form are required; the two without * are optional.
// `flagOn` is the answer that means a problem: "No" for every item except the
// last ("Are there any other findings...?"), where "Yes" is the flag. Sections
// are only visual groupings for the phone form - the paper form has one
// "RIG INSPECTION" section. `key` is stable so items can be trended later.
export const RIG_INSPECTION_CHECKLIST: {
  key: string;
  section: string;
  label: string;
  required: boolean;
  flagOn: "Yes" | "No";
}[] = [
  { key: "inspector_signed_in", section: "Paperwork & safety", label: "Did inspector sign in on location?", required: true, flagOn: "No" },
  { key: "jsas_daily", section: "Paperwork & safety", label: "Are JSA,s being performed and documented daily?", required: true, flagOn: "No" },
  { key: "h2s_monitor", section: "Paperwork & safety", label: "Is employee wearing H2S monitor?", required: true, flagOn: "No" },
  { key: "covid_supplies", section: "Paperwork & safety", label: "Does the rig have all of the needed COVID Supplies?", required: true, flagOn: "No" },
  { key: "msds_book", section: "Paperwork & safety", label: "MSDS book on location?", required: true, flagOn: "No" },
  { key: "emergency_plan_posted", section: "Paperwork & safety", label: "Emergency contact information/evacuation plan with muster area marked and posted in trailer?", required: false, flagOn: "No" },
  { key: "lanyard_fits", section: "Paperwork & safety", label: "Is there a lanyard on location? Does lanyard fit all employees on location?", required: true, flagOn: "No" },
  { key: "first_aid_kit", section: "Paperwork & safety", label: "First Aid kit on location?", required: true, flagOn: "No" },
  { key: "safety_meetings", section: "Paperwork & safety", label: "All employees are attending safety meetings?", required: true, flagOn: "No" },
  { key: "boss_cards", section: "Paperwork & safety", label: "Are BOSS cards being completed and turned in?", required: true, flagOn: "No" },
  { key: "excavator_checklist", section: "Paperwork & safety", label: "Excavator inspection checklist are being done daily?", required: true, flagOn: "No" },
  { key: "loto_followed", section: "Paperwork & safety", label: "Are lock out tag out procedures being followed and documented?", required: true, flagOn: "No" },
  { key: "ppe_stored", section: "Paperwork & safety", label: "Job specific PPE are properly stored and readily available?", required: true, flagOn: "No" },
  { key: "equipment_grounded", section: "Grounding & SALA block", label: "All equipment is properly grounded, with tight connections and impalement caps on ground rods?", required: true, flagOn: "No" },
  { key: "sala_tested", section: "Grounding & SALA block", label: "Has the SALA block been tested and made sure it is in good working order?", required: true, flagOn: "No" },
  { key: "sala_in_place", section: "Grounding & SALA block", label: "Is the SALA block in place?", required: true, flagOn: "No" },
  { key: "stand_pins_keepers", section: "Centrifuge stands", label: "Centrifuge stands/handrails have all pins and keepers properly installed?", required: true, flagOn: "No" },
  { key: "stand_grounded", section: "Centrifuge stands", label: "Centrifuge stand are properly grounded?", required: true, flagOn: "No" },
  { key: "stand_no_trip_hazards", section: "Centrifuge stands", label: "Is the Centrifuge stand free of any trip hazards?", required: true, flagOn: "No" },
  { key: "stand_opening_closes", section: "Centrifuge stands", label: "Can the opening on the Centrifuge stands be closed?", required: true, flagOn: "No" },
  { key: "cuttings_slides_secured", section: "Centrifuge stands", label: "Cuttings slides/Barite boxes are properly secured?", required: true, flagOn: "No" },
  { key: "effluent_piping_secured", section: "Centrifuge stands", label: "Effluent piping secured?", required: true, flagOn: "No" },
  { key: "effluent_no_leaks", section: "Centrifuge stands", label: "Effluent pipe is free from leaks?", required: true, flagOn: "No" },
  { key: "handrails_kickplates", section: "Centrifuge stands", label: "Handrails and kickplates on stands are properly secured with no damage?", required: true, flagOn: "No" },
  { key: "stand_grating_secure", section: "Centrifuge stands", label: "Grating on centrifuge stand secure?", required: true, flagOn: "No" },
  { key: "machine_guards", section: "Centrifuge stands", label: "All machine gaurds are in place and properly secured?", required: true, flagOn: "No" },
  { key: "vfd_placement", section: "VFDs & electrical", label: "VFD is set in correct place to minimize exposure to dust, fluids, and chemicals?", required: true, flagOn: "No" },
  { key: "vfd_doors", section: "VFDs & electrical", label: "VFD doors in working order, properly closed, and sealed?", required: true, flagOn: "No" },
  { key: "high_voltage_marked", section: "VFDs & electrical", label: "All electrical panels and VFDs marked \"HIGH VOLTAGE\"", required: true, flagOn: "No" },
  { key: "plugs_connected_clean", section: "VFDs & electrical", label: "Electrical plugs are connected securely and free of excess dirt and debris?", required: true, flagOn: "No" },
  { key: "plug_strain_relief", section: "VFDs & electrical", label: "Electrical plugs strain relief properly tightened with no exposed wiring?", required: true, flagOn: "No" },
  { key: "cables_routed", section: "VFDs & electrical", label: "Electrical cables and hoses are routed correctly to eliminate trip hazards and damage?", required: true, flagOn: "No" },
  { key: "electrical_boxes_secure", section: "VFDs & electrical", label: "All electrical boxes secure with no missing bolts, hardware, and are all buttons in good condition?", required: true, flagOn: "No" },
  { key: "no_exposed_gland_wires", section: "VFDs & electrical", label: "No exposed wires from glands", required: false, flagOn: "No" },
  { key: "cables_no_damage", section: "VFDs & electrical", label: "Electrical cables are free of nicks, cuts, and damage?", required: true, flagOn: "No" },
  { key: "whip_checks", section: "Hoses & valves", label: "All hoses with pressure have whip checks correctly installed?", required: true, flagOn: "No" },
  { key: "valve_handles", section: "Hoses & valves", label: "All valves have handles and work correctly?", required: true, flagOn: "No" },
  { key: "open_valves_capped", section: "Hoses & valves", label: "Are all open ended valves capped off?", required: true, flagOn: "No" },
  { key: "shakers_mounted", section: "Shakers", label: "Are shakers properly mounted to tanks?", required: true, flagOn: "No" },
  { key: "shaker_tank_grating", section: "Shakers", label: "Grating on shaker tank is secure and free from damage?", required: true, flagOn: "No" },
  { key: "shakers_conveying", section: "Shakers", label: "Are shakers conveying properly?", required: true, flagOn: "No" },
  { key: "shaker_motor_wires", section: "Shakers", label: "Are wires to shakers motors secured to prevent rubbing against shaker?", required: true, flagOn: "No" },
  { key: "shaker_motor_noise", section: "Shakers", label: "Are shaker motors free of excess noise?", required: true, flagOn: "No" },
  { key: "shaker_skirts", section: "Shakers", label: "Shaker skirts in good condition?", required: true, flagOn: "No" },
  { key: "shaker_screens", section: "Shakers", label: "Are shaker screens in good condition?", required: true, flagOn: "No" },
  { key: "hoses_condition", section: "Shakers", label: "Are all hoses in good condition?", required: true, flagOn: "No" },
  { key: "shaker_basket_grounded", section: "Shakers", label: "Shaker basket grounded to frame?", required: true, flagOn: "No" },
  { key: "shaker_tank_grounded", section: "Shakers", label: "Shaker tank properly grounded?", required: true, flagOn: "No" },
  { key: "shaker_slides_hung", section: "Shakers", label: "Shaker slide/chutes hung correctly, lined up, and not touching baskets?", required: true, flagOn: "No" },
  { key: "dewatering_grounded", section: "Dewatering & mixing", label: "Dewatering unit grounded?", required: true, flagOn: "No" },
  { key: "dewatering_hoses", section: "Dewatering & mixing", label: "All hoses attached to dewatering unit properly with whip checks?", required: true, flagOn: "No" },
  { key: "mixing_tanks_no_leaks", section: "Dewatering & mixing", label: "Mixing tanks/plumbing inspected and no leaks", required: true, flagOn: "No" },
  { key: "fire_extinguishers", section: "Housekeeping", label: "Fire extinguishers charged, in date, and properly located?", required: true, flagOn: "No" },
  { key: "jobsite_clean", section: "Housekeeping", label: "Jobsite clean and organized?", required: true, flagOn: "No" },
  { key: "jobsite_no_trash", section: "Housekeeping", label: "Jobsite free from trash?", required: true, flagOn: "No" },
  { key: "tools_put_away", section: "Housekeeping", label: "Tools are clean and put away?", required: true, flagOn: "No" },
  { key: "bunkhouse_clean", section: "Housekeeping", label: "Bunkhouse clean and presentable?", required: true, flagOn: "No" },
  { key: "other_findings", section: "Other findings", label: "Are there any other findings that was not listed on this inspection?", required: true, flagOn: "Yes" },
];

// One answered row as stored in rig_up_reports.checklist (jsonb).
export interface RigInspectionAnswer {
  key: string;
  section: string;
  label: string;
  answer: ServiceAnswer | null; // null = optional item left blank
  flagged: boolean;
  note: string | null;
}

export const RIG_UP_KINDS = ["upload", "inspection"] as const;
export type RigUpKind = (typeof RIG_UP_KINDS)[number];

// Payload for filing an in-app rig inspection. Photos are uploaded one at a
// time afterwards (POST /api/rig-up-reports/:id/photos) to stay under the
// hosting request-size limit.
export const createRigInspectionSchema = z.object({
  job_id: z.string().uuid("Choose a job"),
  site_conducted: z.string().trim().min(1, "Site conducted is required").max(300),
  rig_number: z.string().trim().max(100).nullable().optional(),
  // Local date + time as typed on the form, e.g. "2026-10-27T14:30".
  conducted_on: z.string().min(10, "Conducted on is required"),
  prepared_by: z.string().trim().min(1, "Prepared by is required").max(200),
  notes: z.string().trim().max(4000).nullable().optional(),
  checklist: z
    .array(
      z.object({
        key: z.string().min(1),
        answer: z.enum(SERVICE_ANSWERS).nullable().optional(),
        note: z.string().trim().max(2000).nullable().optional(),
      }),
    )
    .min(1, "Answer the inspection"),
});
export type CreateRigInspectionInput = z.infer<typeof createRigInspectionSchema>;

export const rigInspectionPhotoSchema = z.object({
  file_name: z.string().min(1).max(200),
  file_mime: z.string().min(1).max(100),
  file_base64: z.string().min(1),
  caption: z.string().trim().max(200).nullable().optional(),
});

// ---- Field daily report + JSA schemas --------------------------------------
// Numeric KPI field: accepts number, blank, or null -> null when empty.
const numOpt = z
  .union([z.null(), z.literal("").transform(() => null), z.coerce.number()])
  .optional();

const crewSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      role: z.string().nullable().optional(),
    }),
  )
  .optional();

const kpisSchema = z
  .object({
    mud_type: z.string().nullable().optional(),
    mud_weight_ppg: numOpt,
    lgs_pct: numOpt,
    retort_roc_pct: numOpt,
    daily_fluid_recovery_bbl: numOpt,
    total_fluid_recovery_bbl: numOpt,
    daily_run_hours: numOpt,
    total_run_hours: numOpt,
    maintenance_hours: numOpt,
    add_base_diesel_bbl: numOpt,
    add_water_bbl: numOpt,
    add_barite_bbl: numOpt,
    add_chemicals_bbl: numOpt,
    end_dumps_loaded: numOpt,
    cuttings_volume_bbl: numOpt,
    vac_trucks: numOpt,
    liquids_to_disposal_bbl: numOpt,
  })
  .partial()
  .optional();

// Field reports never carry KPIs — KPIs only ever come from the emailed Excel
// workbook — so `kpis` is intentionally absent from this schema.
export const createFieldDailyReportSchema = z.object({
  report_date: z.string().min(1),
  well_name: z.string().nullable().optional(),
  work_summary: z.string().nullable().optional(),
  crew_hours: numOpt,
  crew: crewSchema,
  asset_ids: z.array(z.string().uuid()).optional(),
  comments: z.string().nullable().optional(),
});
export type CreateFieldDailyReportInput = z.infer<typeof createFieldDailyReportSchema>;

export const updateFieldDailyReportSchema = createFieldDailyReportSchema.partial();
export type UpdateFieldDailyReportInput = z.infer<typeof updateFieldDailyReportSchema>;

const jsaStepSchema = z.object({
  step_description: z.string().min(1),
  hazards: z.string().nullable().optional(),
  controls: z.string().nullable().optional(),
});

export const createJsaSchema = z.object({
  jsa_date: z.string().min(1),
  well_name: z.string().nullable().optional(),
  task_description: z.string().nullable().optional(),
  ppe: z.string().nullable().optional(),
  crew: crewSchema,
  steps: z.array(jsaStepSchema).min(1, "Add at least one job step."),
});
export type CreateJsaInput = z.infer<typeof createJsaSchema>;

export const updateJsaSchema = z.object({
  jsa_date: z.string().min(1).optional(),
  well_name: z.string().nullable().optional(),
  task_description: z.string().nullable().optional(),
  ppe: z.string().nullable().optional(),
  crew: crewSchema,
  steps: z.array(jsaStepSchema).min(1).optional(),
});
export type UpdateJsaInput = z.infer<typeof updateJsaSchema>;

// Reviewer action for both field reports and JSAs: sign off OR request changes.
export const signoffSchema = z
  .object({
    action: z.enum(["sign_off", "request_changes"]),
    change_notes: z.string().nullable().optional(),
  })
  .refine(
    (d) => d.action !== "request_changes" || !!(d.change_notes && d.change_notes.trim()),
    { message: "Suggested changes are required when requesting changes.", path: ["change_notes"] },
  );
export type SignoffInput = z.infer<typeof signoffSchema>;

export const notifPrefsSchema = z.object({
  on_signed: z.boolean(),
  on_needs_signoff: z.boolean(),
  on_filed: z.boolean(),
});
export type NotifPrefsInput = z.infer<typeof notifPrefsSchema>;

// ---------------------------------------------------------------------------
// Work Orders (Service module) — third-party refurbishment
// A work order tracks a machine (usually a centrifuge) sent out to a third
// party for refurbishment: where it went, when it was sent, and — when it is
// closed out — the vendor's invoice, its total, and what was done to the
// machine. Closed work orders form each asset's refurbishment history and
// cost. Admins, area managers, and supervisors create/close them.
// ---------------------------------------------------------------------------
export const WORK_ORDER_TYPES = [
  "Refurbishment",
  "Repair",
  "Inspection",
  "Preventive",
  "Corrective",
] as const;
export type WorkOrderType = (typeof WORK_ORDER_TYPES)[number];

export const WORK_ORDER_PRIORITIES = ["High", "Medium", "Low"] as const;
export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

export const WORK_ORDER_STATUSES = [
  "Scheduled",
  "In Progress",
  "Awaiting Parts",
  "Overdue",
  "Completed",
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
// Statuses you can pick while the machine is out (Completed only via close-out).
export const WORK_ORDER_OPEN_STATUSES = WORK_ORDER_STATUSES.filter(
  (s) => s !== "Completed",
) as Exclude<WorkOrderStatus, "Completed">[];

// Who may create, edit, and close work orders.
export const WORK_ORDER_MANAGE_ROLES: Role[] = ["admin", "area", "super"];

// Largest invoice file accepted at close-out (bytes).
export const WORK_ORDER_INVOICE_MAX_BYTES = 3 * 1024 * 1024;

export interface WorkOrder {
  id: string;
  wo_number: string;
  asset_id: string;
  area: Area;
  title: string;
  wo_type: WorkOrderType;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  vendor: string | null; // where the machine was sent
  sent_on: string | null; // date the machine was sent
  due_date: string | null; // expected back
  est_hours: number | null;
  notes: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  // Close-out
  returned_on: string | null;
  work_performed: string | null;
  invoice_number: string | null;
  invoice_total: number | null;
  invoice_file_name: string | null;
  invoice_mime: string | null;
  invoice_size: number | null;
}

// Work order joined with asset + creator names for list/table display.
export interface WorkOrderWithLinks extends WorkOrder {
  asset_tag: string | null;
  asset_category: Category | null;
  created_by_name: string | null;
  closed_by_name: string | null;
}

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date");

export const createWorkOrderSchema = z.object({
  asset_id: z.string().uuid("Choose an asset"),
  title: z.string().trim().min(1, "Describe what the machine is going in for"),
  vendor: z.string({ required_error: "Enter where the machine was sent" }).trim().min(1, "Enter where the machine was sent"),
  sent_on: z.string({ required_error: "Enter the date the machine was sent" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date"),
  wo_type: z.enum(WORK_ORDER_TYPES).default("Refurbishment"),
  priority: z.enum(WORK_ORDER_PRIORITIES).default("Medium"),
  status: z.enum(WORK_ORDER_OPEN_STATUSES as [string, ...string[]]).default("In Progress"),
  due_date: dateStr.nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;

// All fields optional on update; the route applies only what is provided.
// Completing a work order goes through the close-out endpoint instead.
export const updateWorkOrderSchema = z.object({
  title: z.string().trim().min(1).optional(),
  vendor: z.string().trim().min(1, "Enter where the machine was sent").optional(),
  sent_on: dateStr.optional(),
  wo_type: z.enum(WORK_ORDER_TYPES).optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  status: z.enum(WORK_ORDER_OPEN_STATUSES as [string, ...string[]]).optional(),
  due_date: dateStr.nullable().optional(),
  notes: z.string().nullable().optional(),
  // Editable after close-out too (fix a typo on the invoice # or total).
  returned_on: dateStr.optional(),
  work_performed: z.string().trim().min(1).optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_total: z.number().nonnegative().optional(),
});
export type UpdateWorkOrderInput = z.infer<typeof updateWorkOrderSchema>;

// Close out: the machine is back. Invoice file is optional only so a lost
// invoice doesn't block closing; the total and work performed are required.
export const closeWorkOrderSchema = z.object({
  returned_on: z.string({ required_error: "Enter the date the machine came back" }).regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date"),
  work_performed: z.string().trim().min(1, "Describe what was done to the machine"),
  invoice_number: z.string().trim().nullable().optional(),
  invoice_total: z.number({ required_error: "Enter the invoice total", invalid_type_error: "Enter the invoice total" }).nonnegative("Invoice total can't be negative"),
  invoice_file: z
    .object({
      name: z.string().min(1),
      mime: z.string().min(1),
      base64: z.string().min(1),
    })
    .nullable()
    .optional(),
});
export type CloseWorkOrderInput = z.infer<typeof closeWorkOrderSchema>;

// One completed refurbishment in an asset's history.
export interface RefurbishmentEntry {
  id: string;
  wo_number: string;
  title: string;
  wo_type: WorkOrderType;
  vendor: string | null;
  sent_on: string | null;
  returned_on: string | null;
  work_performed: string | null;
  invoice_number: string | null;
  invoice_total: number | null;
  has_invoice: boolean;
  invoice_file_name: string | null;
  days_out: number | null;
}
export interface AssetRefurbishments {
  total_cost: number;
  count: number;
  open: { id: string; wo_number: string; vendor: string | null; sent_on: string | null; due_date: string | null; status: WorkOrderStatus }[];
  history: RefurbishmentEntry[];
}

// ---- Forecast (upcoming work + centrifuge planning) -----------------------
// Admins and Area Managers plan upcoming jobs month by month. Each forecast
// job has a stage (with default odds), a start date and either an end date or
// none (= indefinite), and the number of centrifuges it needs. Specific units
// can be placed on it; converting an awarded forecast creates the real job.
export const FORECAST_STAGES = ["Bid", "Likely", "Awarded", "Converted", "Lost"] as const;
export type ForecastStage = (typeof FORECAST_STAGES)[number];
export const FORECAST_OPEN_STAGES: ForecastStage[] = ["Bid", "Likely", "Awarded"];
export const FORECAST_DEFAULT_ODDS: Record<ForecastStage, number> = {
  Bid: 25,
  Likely: 70,
  Awarded: 100,
  Converted: 100,
  Lost: 0,
};
export const FORECAST_CATEGORIES = ["Big Bowl Centrifuge", "Small Bowl Centrifuge"] as const;

export interface ForecastJob {
  id: string;
  rig: string;
  customer_id: string | null;
  customer_name: string | null;
  area: Area;
  stage: ForecastStage;
  odds: number;
  start_on: string;
  end_on: string | null; // null = indefinite
  day_rate: number | null;
  big_bowl_needed: number;
  small_bowl_needed: number;
  notes: string | null;
  converted_job_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  asset_ids?: string[];
  bid_doc_count?: number;
}

// A bid PDF attached to an upcoming job (and carried to the real job on convert).
export interface BidDocument {
  id: string;
  forecast_job_id: string | null;
  job_id: string | null;
  area: Area;
  file_name: string;
  file_mime: string;
  file_size: number;
  uploaded_by_name: string | null;
  created_at: string;
}

export const uploadBidDocumentSchema = z.object({
  file_name: z.string().trim().min(1, "Missing file name").max(200),
  file_base64: z.string().min(1, "Missing file"),
});

const forecastBase = {
  rig: z.string().trim().min(1, "Enter the rig / job name"),
  customer_id: z.string().uuid().nullable().optional(),
  customer_name: z.string().trim().nullable().optional(),
  area: z.enum(AREAS),
  stage: z.enum(["Bid", "Likely", "Awarded"]),
  odds: z.number().int().min(0).max(100).optional(),
  start_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
  end_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  day_rate: z.number().nonnegative().nullable().optional(),
  big_bowl_needed: z.number().int().min(0).max(20),
  small_bowl_needed: z.number().int().min(0).max(20),
  notes: z.string().nullable().optional(),
};
export const createForecastJobSchema = z
  .object(forecastBase)
  .refine((v) => !v.end_on || v.end_on >= v.start_on, {
    message: "End date must be on or after the start date",
  });
export type CreateForecastJobInput = z.infer<typeof createForecastJobSchema>;
export const updateForecastJobSchema = z
  .object({
    ...forecastBase,
    stage: z.enum(["Bid", "Likely", "Awarded", "Lost"]),
  })
  .partial();
export type UpdateForecastJobInput = z.infer<typeof updateForecastJobSchema>;
export const setForecastUnitsSchema = z.object({
  asset_ids: z.array(z.string().uuid()).max(40),
});
export const convertForecastSchema = z.object({
  job_number: z.string().trim().min(1),
  customer_id: z.string().uuid(),
  well_name: z.string().trim().nullable().optional(),
  // units to move onto the new job now (must be free); others stay planned
  asset_ids: z.array(z.string().uuid()).optional(),
});
export const setJobReleaseSchema = z.object({
  est_release_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export interface ForecastBoard {
  months: string[]; // "YYYY-MM" x6 starting with the current month
  window_start: string;
  window_end: string;
  assets: {
    id: string;
    tag: string;
    category: string;
    area: Area;
    status: string;
    job_id: string | null;
    is_rental?: boolean;
    rental_vendor?: string | null;
  }[];
  jobs: {
    id: string;
    job_number: string;
    area: Area;
    customer_name: string;
    started_on: string | null;
    est_release_on: string | null; // null = indefinite
    day_rate: number | null;
  }[];
  forecasts: ForecastJob[];
}

// ---- Revenue projection ----------------------------------------------------
// Six-month projected revenue: each live job and each open Upcoming work job
// on its own row, grouped by area. Revenue = manually entered day rate x the
// days the job runs in that month. Active jobs keep their projected rate in
// jobs.projected_day_rate (separate from the billing rate); Upcoming work jobs
// use forecast_jobs.day_rate, so editing it in either place keeps them in sync.
export interface ProjectionRow {
  kind: "job" | "forecast";
  id: string;
  name: string;
  customer_name: string | null;
  area: Area;
  stage: "Active" | "Rig Move" | "Bid" | "Likely" | "Awarded";
  odds: number | null;
  start_on: string | null; // null = already running before the window
  end_on: string | null; // null = indefinite
  day_rate: number | null; // the projection rate (manual)
  latest_report_rate: number | null; // newest AL57 rate on a daily report (hint only)
}
export interface RevenueProjection {
  months: string[];
  window_start: string;
  window_end: string;
  rows: ProjectionRow[];
}
export const setProjectedRateSchema = z.object({
  projected_day_rate: z.number().nonnegative().max(1000000).nullable(),
});
