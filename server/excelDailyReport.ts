// Server-side parser for the DFS "daily report" Excel workbook emailed to
// dfsdailyreports@gmail.com. Every value the app stores for an email-sourced
// daily report is read DIRECTLY from a fixed cell in the workbook's
// "Report Day N" sheet — there is no body-text interpretation anywhere. This
// keeps the app's numbers provably identical to the spreadsheet.
import * as XLSX from "xlsx";
import type {
  DailyFieldKpis,
  KpiCellRef,
  DailyReportWellContext,
} from "@shared/schema";

// Two report-day layouts exist in the field:
//   v1 — original workbook: 2 centrifuge columns (AA, AM), run hours row 37.
//   v2 — updated workbook (Oct 2026): 4 centrifuge columns (AA, AG, AM, AS),
//        an "Asset Number" row, and everything from row 17 down shifted
//        (rows 17-27 by +1, rows 28+ by +2).
// The layout is detected PER DAY TAB (some updated workbooks still carry an
// old-layout tab), from where the "Daily Run Hours" label sits in column Q.
type SheetLayout = "v1" | "v2";
type KpiCell = { field: keyof DailyFieldKpis; cell: string; numeric: boolean };

// key = app KPI field, value = cell address on the report-day sheet.
const KPI_CELLS_V1: KpiCell[] = [
  // Mud properties: label in col B, value in col G.
  { field: "mud_type", cell: "G13", numeric: false },
  { field: "mud_weight_ppg", cell: "G14", numeric: true },
  { field: "lgs_pct", cell: "G15", numeric: true },
  // Retort R.O.C %: labeled row 26 (value cell blank when not run that day).
  { field: "retort_roc_pct", cell: "I26", numeric: true },
  // Fluid recovery: value in merged cell M (M:P).
  { field: "daily_fluid_recovery_bbl", cell: "M31", numeric: true },
  { field: "total_fluid_recovery_bbl", cell: "M32", numeric: true },
  // Centrifuge run/maintenance hours: value in the merged AA block (AA:AF),
  // labeled in col Q. `daily_run_hours` equals Centrifuge 1's daily hours.
  { field: "daily_run_hours", cell: "AA37", numeric: true },
  { field: "total_run_hours", cell: "AA38", numeric: true },
  { field: "maintenance_hours", cell: "AA39", numeric: true },
  // Per-centrifuge run hours (v1 has two centrifuge columns):
  //   Centrifuge 1 -> AA37 (daily) / AA38 (total)
  //   Centrifuge 2 -> AM37 (daily) / AM38 (total)
  { field: "daily_run_hours_cent1", cell: "AA37", numeric: true },
  { field: "total_run_hours_cent1", cell: "AA38", numeric: true },
  { field: "daily_run_hours_cent2", cell: "AM37", numeric: true },
  { field: "total_run_hours_cent2", cell: "AM38", numeric: true },
  // Volume processed by Centrifuge 1 / 2 (bbls): AR60 / AR61, labeled in Y60/Y61.
  { field: "volume_processed_bbl", cell: "AR60", numeric: true },
  { field: "volume_processed_cent2_bbl", cell: "AR61", numeric: true },
  // Centrifuge operating parameters (Centrifuge 1 column, rows 31-36).
  { field: "centrifuge_feed_rate_gpm", cell: "AA31", numeric: true },
  { field: "centrifuge_feed_pump_speed_rpm", cell: "AA32", numeric: true },
  { field: "centrifuge_bowl_speed_rpm", cell: "AA33", numeric: true },
  { field: "centrifuge_backdrive_rpm", cell: "AA34", numeric: true },
  { field: "centrifuge_feed_weight_ppg", cell: "AA35", numeric: true },
  { field: "centrifuge_effluent_weight_ppg", cell: "AA36", numeric: true },
  // Additions: value in merged cell H (H:J), Daily column.
  { field: "add_base_diesel_bbl", cell: "H45", numeric: true },
  { field: "add_water_bbl", cell: "H46", numeric: true },
  { field: "add_barite_bbl", cell: "H48", numeric: true },
  { field: "add_chemicals_bbl", cell: "H49", numeric: true },
  // Waste disposal: value in merged cell Q (Q:T).
  { field: "end_dumps_loaded", cell: "Q52", numeric: true },
  { field: "cuttings_volume_bbl", cell: "Q53", numeric: true },
  { field: "vac_trucks", cell: "Q54", numeric: true },
  { field: "liquids_to_disposal_bbl", cell: "Q55", numeric: true },
  // Accrued total for the current well (running cumulative) and the billable
  // day rate for this report day.
  { field: "accrued_current_well", cell: "AS57", numeric: true },
  { field: "day_rate", cell: "AL57", numeric: true },
];

// Per-centrifuge operating parameters for Centrifuge 2+ (Centrifuge 1 uses the
// unsuffixed centrifuge_* fields above, so older reports keep working).
// Field names: <param>_cent2, <param>_cent3, <param>_cent4.
export const CENTRIFUGE_PARAM_FIELDS = [
  "centrifuge_feed_rate_gpm",
  "centrifuge_feed_pump_speed_rpm",
  "centrifuge_bowl_speed_rpm",
  "centrifuge_backdrive_rpm",
  "centrifuge_feed_weight_ppg",
  "centrifuge_effluent_weight_ppg",
] as const;
function centParamCells(
  firstRow: number,
  cols: { slot: number; col: string }[],
): KpiCell[] {
  const out: KpiCell[] = [];
  for (const { slot, col } of cols)
    CENTRIFUGE_PARAM_FIELDS.forEach((f, i) =>
      out.push({ field: `${f}_cent${slot}` as any, cell: `${col}${firstRow + i}`, numeric: true }),
    );
  return out;
}
// Original workbook: Centrifuge 2 parameters are in column AM, rows 31-36
// (AG and AS are spare columns under the same Centrifuge 1 / 2 headings).
KPI_CELLS_V1.push(...centParamCells(31, [{ slot: 2, col: "AM" }]));

// v2 (updated workbook). Same fields, new positions, plus Centrifuge 3 and 4.
// Centrifuge columns: 1 = AA, 2 = AG, 3 = AM, 4 = AS. Run hours in row 39
// (daily) / 40 (total); maintenance in row 41.
const KPI_CELLS_V2: KpiCell[] = [
  { field: "mud_type", cell: "G13", numeric: false },
  { field: "mud_weight_ppg", cell: "G14", numeric: true },
  { field: "lgs_pct", cell: "G15", numeric: true },
  { field: "retort_roc_pct", cell: "I27", numeric: true },
  { field: "daily_fluid_recovery_bbl", cell: "M33", numeric: true },
  { field: "total_fluid_recovery_bbl", cell: "M34", numeric: true },
  { field: "daily_run_hours", cell: "AA39", numeric: true },
  { field: "total_run_hours", cell: "AA40", numeric: true },
  { field: "maintenance_hours", cell: "AA41", numeric: true },
  { field: "daily_run_hours_cent1", cell: "AA39", numeric: true },
  { field: "total_run_hours_cent1", cell: "AA40", numeric: true },
  { field: "daily_run_hours_cent2", cell: "AG39", numeric: true },
  { field: "total_run_hours_cent2", cell: "AG40", numeric: true },
  { field: "daily_run_hours_cent3", cell: "AM39", numeric: true },
  { field: "total_run_hours_cent3", cell: "AM40", numeric: true },
  { field: "daily_run_hours_cent4", cell: "AS39", numeric: true },
  { field: "total_run_hours_cent4", cell: "AS40", numeric: true },
  { field: "volume_processed_bbl", cell: "AR62", numeric: true },
  { field: "volume_processed_cent2_bbl", cell: "AR63", numeric: true },
  { field: "centrifuge_feed_rate_gpm", cell: "AA33", numeric: true },
  { field: "centrifuge_feed_pump_speed_rpm", cell: "AA34", numeric: true },
  { field: "centrifuge_bowl_speed_rpm", cell: "AA35", numeric: true },
  { field: "centrifuge_backdrive_rpm", cell: "AA36", numeric: true },
  { field: "centrifuge_feed_weight_ppg", cell: "AA37", numeric: true },
  { field: "centrifuge_effluent_weight_ppg", cell: "AA38", numeric: true },
  { field: "add_base_diesel_bbl", cell: "H47", numeric: true },
  { field: "add_water_bbl", cell: "H48", numeric: true },
  { field: "add_barite_bbl", cell: "H50", numeric: true },
  { field: "add_chemicals_bbl", cell: "H51", numeric: true },
  { field: "end_dumps_loaded", cell: "Q54", numeric: true },
  { field: "cuttings_volume_bbl", cell: "Q55", numeric: true },
  { field: "vac_trucks", cell: "Q56", numeric: true },
  { field: "liquids_to_disposal_bbl", cell: "Q57", numeric: true },
  { field: "accrued_current_well", cell: "AS59", numeric: true },
  { field: "day_rate", cell: "AL59", numeric: true },
];
// Updated workbook: Centrifuge 2/3/4 parameters in AG/AM/AS, rows 33-38.
KPI_CELLS_V2.push(
  ...centParamCells(33, [
    { slot: 2, col: "AG" },
    { slot: 3, col: "AM" },
    { slot: 4, col: "AS" },
  ]),
);

const LAYOUTS: Record<
  SheetLayout,
  { kpis: KpiCell[]; remarks: string; dayRate: string }
> = {
  v1: { kpis: KPI_CELLS_V1, remarks: "B57", dayRate: "AL57" },
  v2: { kpis: KPI_CELLS_V2, remarks: "B59", dayRate: "AL59" },
};

function sheetLayout(ws: XLSX.WorkSheet | undefined): SheetLayout {
  const q39 = ws?.["Q39"]?.v;
  if (typeof q39 === "string" && /daily\s*run\s*hours/i.test(q39)) return "v2";
  return "v1";
}

// Well-header context cells on the "Report Day N" sheet.
const CONTEXT_CELLS: { field: keyof DailyReportWellContext; cell: string }[] = [
  { field: "operator", cell: "H8" },
  { field: "company_man", cell: "H9" },
  { field: "mud_company", cell: "H10" },
  { field: "mud_engineer", cell: "H11" },
];

const DATE_CELL = "D3";
const SPUD_DATE_CELL = "AU6";
// Well name lives on the "Well Recap" sheet (C4) and/or the ROC sheet (C2).
const WELL_RECAP_SHEET = "Well Recap";
const WELL_NAME_CELLS: { sheet: string; cell: string }[] = [
  { sheet: "Well Recap", cell: "C4" },
  { sheet: "ROC", cell: "C2" },
];
const RIG_CELL = { sheet: "Well Recap", cell: "C3" };

function rawCell(ws: XLSX.WorkSheet | undefined, addr: string): any {
  if (!ws) return undefined;
  const c = ws[addr];
  if (!c) return undefined;
  // .v is the raw value; for formula cells SheetJS still computes .v when the
  // workbook was saved with cached results (these workbooks are).
  return c.v;
}

function toNumber(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toText(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Excel serial date -> yyyy-mm-dd. Handles both real dates and serial numbers.
//
// IMPORTANT: never use Date.toISOString() here. SheetJS (cellDates:true) builds
// the Date at LOCAL midnight for the workbook's calendar day, so converting to
// UTC with toISOString() shifts the day by one whenever the server runs in a
// timezone offset from UTC (this is exactly what put backfilled report dates a
// day late on Vercel). Read the LOCAL Y/M/D components instead, which give back
// the calendar day SheetJS intended, on any runtime.
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function toDateStr(v: any): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) {
    return ymdLocal(v);
  }
  if (typeof v === "number") {
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) {
      const mm = String(d.m).padStart(2, "0");
      const dd = String(d.d).padStart(2, "0");
      return `${d.y}-${mm}-${dd}`;
    }
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return ymdLocal(parsed);
  return null;
}

// Add a whole number of days to a yyyy-mm-dd string, returning yyyy-mm-dd.
// Uses UTC so it never shifts across a day boundary due to local time zones.
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Measured depth (AI9) is the reliable "this day was actually worked" signal.
// The workbook back-fills header fields (operator, company man, supervisor) and
// even D3's date via formulas into every template tab, so a date alone does NOT
// mean the day was worked. Rig Activity (AI8) is also unreliable: on the blank
// master template some day tabs carry a default dropdown value ("Drilling")
// with no other data. Measured depth is typed in per worked day and stays blank
// on untouched template tabs, giving clean separation between completed and
// blank days in the real files.
const DEPTH_CELL = "AI9"; // Measured depth (ft) — hand-entered per worked day

// True when a day sheet has real, hand-entered work on it (not just a
// formula-inherited date/header from the blank template).
// Remarks / operations summary (B57) is also typed in by hand each worked day
// and is blank on every untouched template tab. Crews sometimes send a day tab
// with remarks, waste and equipment filled in but forget the measured depth —
// that day is still a real worked day and must be picked up (not skipped back
// to the prior day, which would re-import yesterday's report).
// (B57 on v1 tabs, B59 on v2 tabs — see LAYOUTS.)
function remarksCell(ws: XLSX.WorkSheet | undefined): string {
  return LAYOUTS[sheetLayout(ws)].remarks;
}

function sheetIsCompleted(ws: XLSX.WorkSheet | undefined): boolean {
  if (!ws) return false;
  if (toNumber(rawCell(ws, DEPTH_CELL)) != null) return true;
  const remarks = toText(rawCell(ws, remarksCell(ws)));
  return !!(remarks && remarks.trim().length > 0);
}

// True when the worked day is missing the hand-entered depth (AI9) or date
// (D3). Such a day is still imported but flagged for supervisor review.
function sheetMissingKeyFields(ws: XLSX.WorkSheet | undefined): boolean {
  if (!ws) return true;
  return (
    toNumber(rawCell(ws, DEPTH_CELL)) == null ||
    toDateStr(rawCell(ws, DATE_CELL)) == null
  );
}

// Enumerate the daily-report tabs in the order they appear in the workbook.
// The first day tab is named "Report Day 1"; subsequent days are bare-number
// tabs ("2", "3", ... "50") that share the identical Report-Day cell layout.
// `day` is the 1-based position in workbook order, and `completed` marks tabs
// with real hand-entered activity (see sheetIsCompleted).
function reportDaySheets(
  wb: XLSX.WorkBook,
): { day: number; name: string; completed: boolean }[] {
  const out: { day: number; name: string; completed: boolean }[] = [];
  let day = 0;
  // Latest real date seen on an earlier completed tab. Unused template tabs
  // inherit Day 1's date via formula, so a later tab whose date goes BACKWARD
  // from an earlier completed day is template junk (e.g. a stray depth typed
  // into tab 8 while the real latest day is tab 7) — never a worked day.
  let latestDate: string | null = null;
  // Report Day 1's date (D3). Unused template tabs fall back to this exact
  // date via formula, so a later tab whose D3 is AFTER it was really worked,
  // even when the crew left measured depth (AI9) and remarks blank.
  const day1Name = wb.SheetNames.find((n) => /^Report Day 1$/i.test(n.trim()));
  const day1Date = day1Name ? toDateStr(rawCell(wb.Sheets[day1Name], DATE_CELL)) : null;
  for (const name of wb.SheetNames) {
    const t = name.trim();
    const isFirst = /^Report Day 1$/i.test(t);
    const isNumbered = /^\d+$/.test(t) && Number(t) >= 2;
    if (!isFirst && !isNumbered) continue;
    day += 1;
    const ws = wb.Sheets[name];
    let completed = sheetIsCompleted(ws);
    if (!completed && !isFirst && ws && day1Date) {
      const d = toDateStr(rawCell(ws, DATE_CELL));
      if (d && d > day1Date) completed = true;
    }
    if (completed) {
      const d = ws ? toDateStr(rawCell(ws, DATE_CELL)) : null;
      if (d && latestDate && d < latestDate) completed = false;
      else if (d && (!latestDate || d > latestDate)) latestDate = d;
    }
    out.push({ day, name, completed });
  }
  return out;
}

// Critical hand-entered cells a reviewer needs before signing off. Any that are
// blank on the imported day tab are listed so the report is flagged (still
// imported — never dropped — but the sign-off reviewer is alerted).
export function missingCriticalFields(ws: XLSX.WorkSheet | undefined): string[] {
  const out: string[] = [];
  if (!ws) return ["Day tab not found"];
  if (toDateStr(rawCell(ws, DATE_CELL)) == null) out.push("Report date (D3)");
  if (toNumber(rawCell(ws, DEPTH_CELL)) == null) out.push("Measured depth (AI9)");
  const rateCell = LAYOUTS[sheetLayout(ws)].dayRate;
  const rate = toNumber(rawCell(ws, rateCell));
  if (rate == null || rate === 0) out.push(`Day rate (${rateCell})`);
  if (!toText(rawCell(ws, "V9"))) out.push("Well name (V9)");
  const v8 = toText(rawCell(ws, "V8"));
  if (!v8 || /^\d+(\.\d+)?$/.test(v8.trim())) out.push("Rig / job (V8)");
  return out;
}

export interface ParsedDailyReport {
  report_date: string | null;
  well_name: string | null;
  // Job number / rig name read straight from cell V8 of the chosen Report Day
  // sheet (labeled "Rig Name" in R8). Used to auto-match the report to a job.
  // null when the cell is blank or non-text.
  job_number: string | null;
  source_sheet: string;
  report_day: number;
  // True when NO day tab had hand-entered activity, so we fell back to the
  // first day tab. The caller flags these for supervisor / area-manager review.
  incomplete: boolean;
  // Critical hand-entered fields that are blank on the chosen day tab.
  missing_fields: string[];
  kpis: DailyFieldKpis;
  kpi_cell_map: Record<string, KpiCellRef>;
  well_context: DailyReportWellContext;
  summary: string | null;
}

export class ExcelParseError extends Error {}

// Parse the workbook and return the daily-report values read straight from the
// requested (or latest populated) "Report Day N" sheet.
export function parseDailyReportWorkbook(
  buf: Buffer,
  requestedDay?: number | null,
): ParsedDailyReport {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch (e: any) {
    throw new ExcelParseError(`Could not read Excel file: ${e?.message ?? e}`);
  }

  const days = reportDaySheets(wb);
  if (days.length === 0)
    throw new ExcelParseError(
      'No daily-report day sheet found in the workbook.',
    );

  // Default target = the MOST RECENTLY COMPLETED day: the last day tab (in
  // workbook order) that has real hand-entered activity. Blank template tabs
  // that only carry a formula-inherited date are skipped. When an explicit
  // report_day is requested, honor it. When no tab is completed yet, fall back
  // to the first day tab and mark the result incomplete so the caller can raise
  // a sign-off alert instead of silently dropping the email.
  const completed = days.filter((d) => d.completed);
  let incomplete = false;
  let chosen;
  if (requestedDay) {
    chosen = days.find((d) => d.day === requestedDay);
    if (!chosen)
      throw new ExcelParseError(
        `Report Day ${requestedDay} not found in the workbook.`,
      );
    incomplete = !chosen.completed;
  } else if (completed.length > 0) {
    chosen = completed[completed.length - 1]; // latest COMPLETED day
  } else {
    chosen = days[0]; // nothing filled in yet — take day 1, flag for review
    incomplete = true;
  }

  if (!incomplete && sheetMissingKeyFields(wb.Sheets[chosen.name]))
    incomplete = true;

  const result = parseDaySheet(wb, chosen, incomplete);

  // Blank date (D3) on the chosen day: infer it from the nearest EARLIER day
  // tab that has a real date — one calendar day per report day. Later template
  // tabs are ignored because they can carry stale formula-inherited dates.
  if (!result.report_date) {
    for (let i = days.indexOf(chosen) - 1; i >= 0; i--) {
      const prev = toDateStr(rawCell(wb.Sheets[days[i].name], DATE_CELL));
      if (prev) {
        result.report_date = addDaysToDateStr(prev, chosen.day - days[i].day);
        break;
      }
    }
  }
  return result;
}

// Parse a single already-chosen day tab into a ParsedDailyReport. Shared by the
// single-day email path (parseDailyReportWorkbook) and the multi-day backfill
// path (parseAllCompletedDays) so both read cells identically.
function parseDaySheet(
  wb: XLSX.WorkBook,
  chosen: { day: number; name: string; completed: boolean },
  incomplete: boolean,
): ParsedDailyReport {
  const ws = wb.Sheets[chosen.name];

  // Read every KPI straight from its fixed cell, recording provenance.
  const kpis: DailyFieldKpis = {};
  const cellMap: Record<string, KpiCellRef> = {};
  const layout = LAYOUTS[sheetLayout(ws)];
  for (const { field, cell, numeric } of layout.kpis) {
    const raw = rawCell(ws, cell);
    const value = numeric ? toNumber(raw) : toText(raw);
    (kpis as any)[field] = value;
    cellMap[field] = { sheet: chosen.name, cell, value: value ?? null };
  }

  const well_context: DailyReportWellContext = {};
  for (const { field, cell } of CONTEXT_CELLS) {
    (well_context as any)[field] = toText(rawCell(ws, cell));
  }
  const rigWs = wb.Sheets[RIG_CELL.sheet];
  const rig = toText(rawCell(rigWs, RIG_CELL.cell));
  if (rig) well_context.rig = rig;

  // "Rig Activity" section on the Report Day sheet. Header sits at AE8; the
  // activity value is in AI8 (from a fixed dropdown), measured depth in AI9,
  // and the day-tour supervisor in AI11. Read verbatim — no interpretation.
  well_context.rig_activity = toText(rawCell(ws, "AI8"));
  well_context.meas_depth_ft = toNumber(rawCell(ws, "AI9"));
  well_context.supervisor = toText(rawCell(ws, "AI11"));
  // Notes / comments typed by the crew in B57 (operations summary). Stored
  // verbatim (line breaks kept) so the report detail page can show it.
  well_context.remarks = toText(rawCell(ws, layout.remarks));
  // Spud date in AU6 (labeled "Spud Date:" in AQ6). Set day rate billing
  // (e.g. Verdun) starts on this date.
  // A blank template cell (0) reads as 1899-12-30 — treat anything before
  // 2000 as no spud date.
  const spud = toDateStr(rawCell(ws, SPUD_DATE_CELL));
  well_context.spud_date = spud && spud >= "2000-01-01" ? spud : null;

  const report_date = toDateStr(rawCell(ws, DATE_CELL));

  // Job number / rig name: read verbatim from V8 on this report-day sheet
  // (labeled "Rig Name" in R8). This is the value crews type as the job/rig,
  // e.g. "H&P 266". Blank templates leave V8 as 0 / a bare number, which is not
  // a real job number, so drop purely-numeric values.
  const v8raw = toText(rawCell(ws, "V8"));
  const job_number =
    v8raw && !/^\d+(\.\d+)?$/.test(v8raw) ? v8raw : null;

  // Well name: read verbatim from V9 on this report-day sheet (labeled
  // "Well Name" in R9). Crews update it per day tab, so it is the most
  // reliable source when a workbook is reused for a new well. Blank templates
  // leave V9 empty or 0, so drop purely-numeric values. Only when V9 is blank
  // fall back to the Well Recap / ROC cells.
  const v9raw = toText(rawCell(ws, "V9"));
  let well_name: string | null =
    v9raw && !/^\d+(\.\d+)?$/.test(v9raw) ? v9raw : null;
  if (!well_name) for (const { sheet, cell } of WELL_NAME_CELLS) {
    const v = toText(rawCell(wb.Sheets[sheet], cell));
    if (v) {
      well_name = v;
      break;
    }
  }

  // Friendly, stable label for the chosen day, independent of the raw tab name
  // (which may be a bare number like "13"). Provenance in kpi_cell_map keeps the
  // exact raw tab name for auditing.
  const dayLabel = `Report Day ${chosen.day}`;

  // A short, honest summary built ONLY from cell values (no interpretation).
  const summaryBits: string[] = [];
  {
    // Run hours per centrifuge column that has a value (Centrifuge 1-4).
    const kv = kpis as any;
    const per = [1, 2, 3, 4]
      .map((n) => ({ n, v: n === 1 ? kv.daily_run_hours_cent1 ?? kv.daily_run_hours : kv[`daily_run_hours_cent${n}`] }))
      .filter((x) => x.v != null);
    if (per.length === 1 && per[0].n === 1) summaryBits.push(`Run hours ${per[0].v}`);
    else if (per.length) summaryBits.push(`Run hours ${per.map((x) => `C${x.n} ${x.v}`).join(", ")}`);
  }
  if (kpis.daily_fluid_recovery_bbl != null)
    summaryBits.push(`Daily fluid recovery ${kpis.daily_fluid_recovery_bbl} bbl`);
  if (kpis.mud_weight_ppg != null)
    summaryBits.push(`Mud wt ${kpis.mud_weight_ppg} ppg`);
  const summary =
    summaryBits.length > 0
      ? `${dayLabel} — ${summaryBits.join(" · ")}`
      : dayLabel;

  return {
    report_date,
    well_name,
    job_number,
    source_sheet: dayLabel,
    report_day: chosen.day,
    incomplete,
    missing_fields: missingCriticalFields(ws),
    kpis,
    kpi_cell_map: cellMap,
    well_context,
    summary,
  };
}

// Backfill support: parse EVERY completed day tab in the workbook, in workbook
// order (day 1 .. latest completed). Returns one ParsedDailyReport per
// hand-entered day. Blank template tabs are skipped. Used by the manual
// "Import workbook" backfill endpoint to load a job's prior days in one upload.
export function parseAllCompletedDays(buf: Buffer): ParsedDailyReport[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  } catch (e: any) {
    throw new ExcelParseError(`Could not read Excel file: ${e?.message ?? e}`);
  }
  const days = reportDaySheets(wb);
  if (days.length === 0)
    throw new ExcelParseError(
      "No daily-report day sheet found in the workbook.",
    );
  const completed = days.filter((d) => d.completed);
  if (completed.length === 0)
    throw new ExcelParseError(
      "No completed day tabs found in the workbook. Fill in at least one Report Day before importing.",
    );
  const parsed = completed.map((d) => parseDaySheet(wb, d, false));

  // Fill in any missing per-day dates. A completed day whose D3 date cell is
  // blank or unparseable (seen in real workbooks where the last worked day was
  // saved before its date recalculated) would otherwise fall back to "today".
  // Instead, infer it from a neighboring day that DID parse: dates run one per
  // consecutive day, so day N's date = anchor date + (N - anchor's day index).
  // Walk forward from the first parsed date, then backward, so a gap anywhere
  // in the sequence is filled deterministically from real data — never today.
  for (let i = 1; i < parsed.length; i++) {
    if (!parsed[i].report_date && parsed[i - 1].report_date) {
      const gap = parsed[i].report_day - parsed[i - 1].report_day;
      parsed[i].report_date = addDaysToDateStr(
        parsed[i - 1].report_date as string,
        gap,
      );
    }
  }
  for (let i = parsed.length - 2; i >= 0; i--) {
    if (!parsed[i].report_date && parsed[i + 1].report_date) {
      const gap = parsed[i + 1].report_day - parsed[i].report_day;
      parsed[i].report_date = addDaysToDateStr(
        parsed[i + 1].report_date as string,
        -gap,
      );
    }
  }
  return parsed;
}


// Read just the crew notes (B57) for a given report day from a stored
// workbook. Used to fill in notes on reports imported before notes were saved.
export function readDayRemarks(buf: Buffer, reportDay: number): string | null {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });
  const day = reportDaySheets(wb).find((d) => d.day === reportDay);
  if (!day) return null;
  const ws = wb.Sheets[day.name];
  return toText(rawCell(ws, remarksCell(ws)));
}
