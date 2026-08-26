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

export const JOB_STATUS = ["Active", "On Hold", "Completed"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

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
  created_at: string;
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
  revenue: number | null; // day_rate x report_days, or null when no day rate
  is_current: boolean; // true for the well on the job's most recent report
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
  created_at: string;
}

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
// Falls back to job_or_well text, else "Yard / unassigned".
export function assetLocation(a: AssetWithSchedule): string {
  if (a.job) {
    const where = a.job.well_name || a.job.job_number;
    return `${where} \u00b7 ${a.job.area}`;
  }
  if (a.job_or_well) return a.job_or_well;
  return "Yard / unassigned";
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

export type ServiceState = "OK" | "Soon" | "Overdue" | "No baseline";

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

// One centrifuge row on the Service dashboard's active-asset list.
export interface ServiceAssetRow {
  id: string;
  tag: string;
  category: Category;
  area: Area;
  status: string; // deployment status (e.g. On Job / Available)
  job_id: string | null;
  job_number: string | null;
  job_or_well: string | null;
  technician: string | null; // supervisor who last filed a service report
  run_hours: number | null;
  run_hours_since_service: number | null;
  service_hours_interval: number;
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
  centrifuges: ServiceAssetRow[]; // active (deployed) centrifuges only
}

// A single billable line on a field ticket. Total is Qty × Unit cost, computed
// and stored so the PDF and totals stay stable even if pricing logic changes.
export interface LineItem {
  description: string;
  quantity: number;
  unit_cost: number;
  total: number; // quantity * unit_cost
}

// A field ticket records billable field work performed on a job.
export interface FieldTicket {
  id: string;
  job_id: string;
  ticket_number: number; // human-friendly sequential number
  ticket_date: string; // date work was performed (yyyy-mm-dd)
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
  category: Category;
  run_hours: number | null;
}

// What GET /api/daily-reports/:id/centrifuges returns so the sign-off UI can
// decide whether to auto-apply (0 or 1 centrifuge) or prompt for a per-asset
// split (2+ centrifuges).
export interface ReportRunHoursContext {
  daily_run_hours: number | null; // the day's hours from cell M33
  already_applied: boolean;
  centrifuges: CentrifugeOnJob[];
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
// Password rule shared by manual create and password reset: at least 10 chars
// with letters and numbers (these mint real login accounts).
const strongPassword = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .regex(/[A-Za-z]/, "Password must include a letter")
  .regex(/[0-9]/, "Password must include a number");

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
  description: z.string().nullable().optional(),
  status: z.enum(JOB_STATUS).optional(),
  crewing: z.enum(CREWING).optional(),
  started_on: z.string().nullable().optional(),
  ended_on: z.string().nullable().optional(),
  day_rate: dayRateField,
  well_name: z.string().nullable().optional(),
  // when present, replaces the full set of field-tech assignments for the job
  field_tech_ids: z.array(z.string().uuid()).optional(),
  // when present, replaces the full set of supervisor assignments for the job
  supervisor_ids: z.array(z.string().uuid()).optional(),
});
export type UpdateJobInput = z.infer<typeof updateJobSchema>;

// ==== Job services (drive-by / call-out on unmanned jobs) ==================
export const SERVICE_TYPES = ["Drive-by Service", "Call-out Service"] as const;
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
  notes: string | null;
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
  cost: serviceCostField,
  well_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type CreateJobServiceInput = z.infer<typeof createJobServiceSchema>;

export const updateJobServiceSchema = z.object({
  service_type: z.enum(SERVICE_TYPES).optional(),
  service_date: z.string().min(1).optional(),
  cost: serviceCostField,
  well_id: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
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
export const lineItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.coerce.number().nonnegative(),
  unit_cost: z.coerce.number().nonnegative(),
});
export type LineItemInput = z.infer<typeof lineItemSchema>;

export const createFieldTicketSchema = z.object({
  ticket_date: z.string().min(1),
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
    (d) => d.action !== "request_changes" || !!(d.change_notes && d.change_notes.trim()),
    { message: "Suggested changes are required when requesting changes.", path: ["change_notes"] },
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
  attachment_name: string;
  attachment_mime: string | null;
  attachment_size: number | null;
  status: RigUpStatus;
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
// Work Orders (Maintenance module)
// A work order is a tracked maintenance task against a specific asset:
// preventive service, a repair, an inspection, or corrective work. Admins,
// area managers, and supervisors create/assign/close them; field users view
// only. Viewing is area-scoped like the rest of the app.
// ---------------------------------------------------------------------------
export const WORK_ORDER_TYPES = [
  "Preventive",
  "Repair",
  "Inspection",
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

// Who may create, edit, assign, and close work orders.
export const WORK_ORDER_MANAGE_ROLES: Role[] = ["admin", "area", "super"];

export interface WorkOrder {
  id: string;
  wo_number: string;
  asset_id: string;
  area: Area;
  title: string;
  wo_type: WorkOrderType;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  assigned_to: string | null;
  due_date: string | null;
  est_hours: number | null;
  notes: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
}

// Work order joined with asset + person names for list/table display.
export interface WorkOrderWithLinks extends WorkOrder {
  asset_tag: string | null;
  asset_category: Category | null;
  assigned_to_name: string | null;
  created_by_name: string | null;
}

export const createWorkOrderSchema = z.object({
  asset_id: z.string().uuid("Choose an asset"),
  title: z.string().trim().min(1, "A task title is required"),
  wo_type: z.enum(WORK_ORDER_TYPES),
  priority: z.enum(WORK_ORDER_PRIORITIES).default("Medium"),
  status: z.enum(WORK_ORDER_STATUSES).default("Scheduled"),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  est_hours: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;

// All fields optional on update; the route applies only what is provided.
export const updateWorkOrderSchema = z.object({
  title: z.string().trim().min(1).optional(),
  wo_type: z.enum(WORK_ORDER_TYPES).optional(),
  priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().nullable().optional(),
  est_hours: z.number().nonnegative().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type UpdateWorkOrderInput = z.infer<typeof updateWorkOrderSchema>;
