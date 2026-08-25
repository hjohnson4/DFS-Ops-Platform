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

// Fixed cell map for a "Report Day N" sheet (same layout on every day tab).
// key = app KPI field, value = cell address on the report-day sheet.
const KPI_CELLS: { field: keyof DailyFieldKpis; cell: string; numeric: boolean }[] = [
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
  // labeled in col R. This is the block the crews actually fill in — the old
  // col-M rows 33-35 are a legacy summary area that stays zero.
  { field: "daily_run_hours", cell: "AA37", numeric: true },
  { field: "total_run_hours", cell: "AA38", numeric: true },
  { field: "maintenance_hours", cell: "AA39", numeric: true },
  // Volume processed by Centrifuge 1 (bbls): value in AR60, labeled in Y60.
  { field: "volume_processed_bbl", cell: "AR60", numeric: true },
  // Centrifuge operating parameters: values in the AA column (rows 31-36),
  // labeled in col Q. Feed/effluent weight (AA35/AA36) are often blank.
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
];

// Well-header context cells on the "Report Day N" sheet.
const CONTEXT_CELLS: { field: keyof DailyReportWellContext; cell: string }[] = [
  { field: "operator", cell: "H8" },
  { field: "company_man", cell: "H9" },
  { field: "mud_company", cell: "H10" },
  { field: "mud_engineer", cell: "H11" },
];

const DATE_CELL = "D3";
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
function sheetIsCompleted(ws: XLSX.WorkSheet | undefined): boolean {
  if (!ws) return false;
  return toNumber(rawCell(ws, DEPTH_CELL)) != null;
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
  for (const name of wb.SheetNames) {
    const t = name.trim();
    const isFirst = /^Report Day 1$/i.test(t);
    const isNumbered = /^\d+$/.test(t) && Number(t) >= 2;
    if (!isFirst && !isNumbered) continue;
    day += 1;
    const ws = wb.Sheets[name];
    out.push({ day, name, completed: sheetIsCompleted(ws) });
  }
  return out;
}

export interface ParsedDailyReport {
  report_date: string | null;
  well_name: string | null;
  source_sheet: string;
  report_day: number;
  // True when NO day tab had hand-entered activity, so we fell back to the
  // first day tab. The caller flags these for supervisor / area-manager review.
  incomplete: boolean;
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

  return parseDaySheet(wb, chosen, incomplete);
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
  for (const { field, cell, numeric } of KPI_CELLS) {
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

  const report_date = toDateStr(rawCell(ws, DATE_CELL));

  // Well name: prefer the dedicated Well Recap / ROC cells.
  let well_name: string | null = null;
  for (const { sheet, cell } of WELL_NAME_CELLS) {
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
  if (kpis.daily_run_hours != null)
    summaryBits.push(`Run hours ${kpis.daily_run_hours}`);
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
    source_sheet: dayLabel,
    report_day: chosen.day,
    incomplete,
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
