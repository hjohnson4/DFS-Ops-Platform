// Well-stint timeline — INFERRED-FROM-REPORTS prototype.
//
// The app has no explicit "which well is the crew on today" switch. Instead we
// reconstruct the timeline from the sequence of daily reports for a job: each
// report has a `report_date` and a `well_name`, so ordering reports by date and
// grouping consecutive same-well days yields a series of "stints" on each well.
//
// From that timeline we derive:
//   - days on each well (and per stint),
//   - accrued revenue per well  = day_rate ($/day) × days,
//   - the job's current well    = the well on the most recently SUBMITTED report.
//
// This is a DERIVATION ONLY. It writes nothing and needs no schema change; it
// runs entirely on data already returned by /api/daily-reports. Because it is
// inferred, it is only as complete as the reports themselves — see the
// `caveats` returned by buildWellTimeline() for the honest gaps (no-report
// days, unknown-well days, single-day stints, etc.).

import type { DailyReportWithLinks } from "@shared/schema";

// A contiguous run of report-days on one well.
export interface WellStint {
  well: string; // resolved well label ("Unknown well" when the report had none)
  wellKnown: boolean; // false when the report carried no well name
  startDate: string; // yyyy-mm-dd of the first report in the stint
  endDate: string; // yyyy-mm-dd of the last report in the stint
  reportDays: number; // number of daily reports in this stint
  spanDays: number; // calendar days from start→end inclusive (>= reportDays)
  reportIds: string[];
}

// Rolled-up totals for one well across all its stints.
export interface WellTotal {
  well: string;
  wellKnown: boolean;
  reportDays: number; // total reports naming this well
  spanDays: number; // total calendar span across its stints (inclusive)
  stints: number; // how many separate times the crew was on this well
  revenue: number | null; // day_rate × reportDays, or null when no day rate
  firstDate: string;
  lastDate: string;
}

export interface WellTimeline {
  stints: WellStint[]; // chronological
  wells: WellTotal[]; // one row per distinct well, sorted by reportDays desc
  currentWell: string | null; // well on the most recently submitted report
  currentWellKnown: boolean;
  totalReportDays: number; // reports that had a usable date
  distinctWells: number; // known wells only
  dayRate: number | null;
  totalRevenue: number | null; // day_rate × totalReportDays
  caveats: string[]; // honesty notes about inference gaps
}

const UNKNOWN = "Unknown well";

function toDay(d: string | null | undefined): string | null {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  // basic sanity: yyyy-mm-dd
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// inclusive calendar-day distance between two yyyy-mm-dd strings
function inclusiveSpan(start: string, end: string): number {
  const a = new Date(start + "T00:00:00");
  const b = new Date(end + "T00:00:00");
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  return days >= 0 ? days + 1 : 1;
}

function normWell(w: string | null | undefined): { label: string; known: boolean } {
  const t = (w ?? "").trim();
  return t ? { label: t, known: true } : { label: UNKNOWN, known: false };
}

/**
 * Reconstruct a well-stint timeline for a single job from its daily reports.
 *
 * @param reports  daily reports (any source) — only those for this job should
 *                 be passed in, but we defensively ignore ones with no date.
 * @param dayRate  the job's billable day rate ($/day), or null.
 */
export function buildWellTimeline(
  reports: DailyReportWithLinks[],
  dayRate: number | null,
): WellTimeline {
  // Keep only dated reports; sort chronologically. Ties broken by report_day
  // then id so the ordering is stable.
  const dated = reports
    .map((r) => ({ r, day: toDay(r.report_date) ?? toDay(r.received_at) }))
    .filter((x): x is { r: DailyReportWithLinks; day: string } => !!x.day)
    .sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      const an = a.r.report_day ?? 0;
      const bn = b.r.report_day ?? 0;
      if (an !== bn) return an - bn;
      return a.r.id < b.r.id ? -1 : 1;
    });

  const caveats: string[] = [];
  const stints: WellStint[] = [];

  // Walk the sorted reports, opening a new stint whenever the well changes.
  for (const { r, day } of dated) {
    const { label, known } = normWell(r.well_name);
    const last = stints[stints.length - 1];
    if (last && last.well === label) {
      last.endDate = day;
      last.reportDays += 1;
      last.spanDays = inclusiveSpan(last.startDate, last.endDate);
      last.reportIds.push(r.id);
    } else {
      stints.push({
        well: label,
        wellKnown: known,
        startDate: day,
        endDate: day,
        reportDays: 1,
        spanDays: 1,
        reportIds: [r.id],
      });
    }
  }

  // Roll stints up per well.
  const totalsMap = new Map<string, WellTotal>();
  for (const s of stints) {
    const cur = totalsMap.get(s.well);
    if (cur) {
      cur.reportDays += s.reportDays;
      cur.spanDays += s.spanDays;
      cur.stints += 1;
      if (s.startDate < cur.firstDate) cur.firstDate = s.startDate;
      if (s.endDate > cur.lastDate) cur.lastDate = s.endDate;
    } else {
      totalsMap.set(s.well, {
        well: s.well,
        wellKnown: s.wellKnown,
        reportDays: s.reportDays,
        spanDays: s.spanDays,
        stints: 1,
        revenue: dayRate != null ? dayRate * s.reportDays : null,
        firstDate: s.startDate,
        lastDate: s.endDate,
      });
    }
  }
  // Recompute revenue after totals are aggregated.
  Array.from(totalsMap.values()).forEach((t) => {
    t.revenue = dayRate != null ? dayRate * t.reportDays : null;
  });

  const wells = Array.from(totalsMap.values()).sort(
    (a, b) => b.reportDays - a.reportDays || (a.well < b.well ? -1 : 1),
  );

  const totalReportDays = dated.length;
  const distinctWells = wells.filter((w) => w.wellKnown).length;
  // Current well = the well on the MOST RECENTLY SUBMITTED report, ordered by
  // submission time (created_at, falling back to received_at) — NOT by the
  // report's own calendar date. A crew can submit an older-dated report after a
  // newer one, and a report can arrive with a missing/late report_date; in both
  // cases the latest-dated report is the wrong signal for "where the crew is
  // now." Submission time answers "what did we most recently hear," which is the
  // job's current well. The chronological stints above still use report_date.
  const submittedSort = (r: DailyReportWithLinks): string =>
    String(r.created_at || r.received_at || "");
  const bySubmission = [...reports].sort((a, b) => {
    const sa = submittedSort(a);
    const sb = submittedSort(b);
    if (sa !== sb) return sa < sb ? 1 : -1; // newest submission first
    // Stable tiebreak: higher report_day, then id, so the ordering is deterministic.
    const an = a.report_day ?? 0;
    const bn = b.report_day ?? 0;
    if (an !== bn) return bn - an;
    return a.id < b.id ? 1 : -1;
  });
  const lastReport = bySubmission[0];
  const cur = lastReport ? normWell(lastReport.well_name) : { label: null, known: false };

  // ---- Honesty caveats -----------------------------------------------------
  if (totalReportDays === 0) {
    caveats.push("No dated daily reports for this job yet, so no timeline can be inferred.");
  }
  const unknownDays = wells.find((w) => !w.wellKnown)?.reportDays ?? 0;
  if (unknownDays > 0) {
    caveats.push(
      `${unknownDays} report day${unknownDays === 1 ? "" : "s"} had no well name and are grouped under "Unknown well."`,
    );
  }
  // Gaps: any calendar day with no report is invisible to the inference.
  if (totalReportDays >= 2) {
    const first = dated[0].day;
    const last = dated[dated.length - 1].day;
    const calendarSpan = inclusiveSpan(first, last);
    const gap = calendarSpan - totalReportDays;
    if (gap > 0) {
      caveats.push(
        `${gap} calendar day${gap === 1 ? "" : "s"} between ${first} and ${last} have no report; days-on-well counts report days, not calendar days.`,
      );
    }
  }
  if (dayRate == null) {
    caveats.push("No day rate set on this job, so per-well revenue can't be computed.");
  }
  // Same well appearing in multiple stints => crew moved away and came back.
  const revisited = wells.filter((w) => w.stints > 1 && w.wellKnown);
  if (revisited.length > 0) {
    caveats.push(
      `Crew returned to ${revisited.length} well${revisited.length === 1 ? "" : "s"} after moving away; each visit is a separate stint but days are summed.`,
    );
  }

  return {
    stints,
    wells,
    currentWell: cur.label,
    currentWellKnown: cur.known,
    totalReportDays,
    distinctWells,
    dayRate,
    totalRevenue: dayRate != null ? dayRate * totalReportDays : null,
    caveats,
  };
}

// Small formatting helpers reused by the UI.
export function fmtWellMoney(n: number | null): string {
  return n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
}

export function fmtWellDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d + "T00:00:00");
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString();
}
