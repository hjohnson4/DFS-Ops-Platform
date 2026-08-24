import { DFS_LOGO_DATA_URI } from "./brandAssets";
import { showPdfPreview } from "./pdfPreview";

// Client-side PDF export for the asset utilization report. Mirrors the
// Customers / Field Ticket exports: build a fully styled, self-contained HTML
// document and hand it to the browser's native print-to-PDF via a new tab +
// window.print(). No PDF dependency, works inside the sandboxed iframe.

export interface UtilizationRow {
  tag: string;
  category: string | null;
  area: string | null;
  status: string | null;
  location: string;
  day_rate: number | null;
  run_hours: number | null;
  days_deployed: number | null;
  utilization_pct: number | null;
  est_revenue: number | null;
  maintenance_events: number;
}

export interface UtilizationReport {
  start: string;
  end: string;
  window_days: number;
  area_scope: string;
  summary: {
    asset_count: number;
    deployed_count: number;
    avg_utilization_pct: number | null;
    total_est_revenue: number;
  };
  rows: UtilizationRow[];
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d));
  const dt = m
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const fmtMoney = (n: number | null | undefined): string =>
  n == null || isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });

const fmtRate = (n: number | null | undefined): string =>
  n == null || isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }) + "/day";

const fmtNum = (n: number | null | undefined): string =>
  n == null || isNaN(Number(n))
    ? "—"
    : Number(n).toLocaleString("en-US", { maximumFractionDigits: 1 });

const fmtPct = (n: number | null | undefined): string =>
  n == null || isNaN(Number(n)) ? "—" : `${fmtNum(n)}%`;

function utilBar(pct: number | null): string {
  if (pct == null) return `<span class="muted">—</span>`;
  const w = Math.max(0, Math.min(100, pct));
  // Label sits to the RIGHT of the track (never overlapping the fill), so it
  // stays legible at low utilization values.
  return `<div class="bar-row"><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><span class="bar-lbl">${fmtNum(pct)}%</span></div>`;
}

function summaryStrip(r: UtilizationReport): string {
  const s = r.summary;
  return `
  <div class="kpis">
    <div class="kpi"><div class="kpi-value">${s.asset_count}</div><div class="kpi-label">Assets</div></div>
    <div class="kpi"><div class="kpi-value">${s.deployed_count}</div><div class="kpi-label">Deployed in window</div></div>
    <div class="kpi"><div class="kpi-value">${fmtPct(s.avg_utilization_pct)}</div><div class="kpi-label">Avg utilization</div></div>
    <div class="kpi"><div class="kpi-value">${fmtMoney(s.total_est_revenue)}</div><div class="kpi-label">Est. revenue</div></div>
  </div>`;
}

function rowsTable(r: UtilizationReport): string {
  const body =
    r.rows.length === 0
      ? `<tr><td colspan="9" class="empty">No assets in scope for this window.</td></tr>`
      : r.rows
          .map(
            (a) => `<tr>
      <td><span class="tag">${esc(a.tag)}</span><div class="sub">${esc(a.category ?? "")}</div></td>
      <td>${esc(a.area ?? "—")}</td>
      <td>${esc(a.status ?? "—")}</td>
      <td>${esc(a.location)}</td>
      <td class="num">${fmtRate(a.day_rate)}</td>
      <td class="num">${a.days_deployed == null ? '<span class="muted">—</span>' : a.days_deployed}</td>
      <td class="util">${utilBar(a.utilization_pct)}</td>
      <td class="num">${fmtMoney(a.est_revenue)}</td>
      <td class="num">${a.maintenance_events}</td>
    </tr>`,
          )
          .join("");
  return `
  <table class="tbl">
    <thead>
      <tr>
        <th>Asset</th><th>Area</th><th>Status</th><th>Location</th>
        <th class="num">Day rate</th><th class="num">Days</th>
        <th>Utilization</th><th class="num">Est. revenue</th><th class="num">Maint.</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`;
}

export function exportUtilizationPdf(
  report: UtilizationReport,
  opts: { generatedBy?: string } = {},
): void {
  const now = new Date();
  const title = "Asset Utilization Report";
  const range = `${fmtDate(report.start)} – ${fmtDate(report.end)} (${report.window_days} days)`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} · ${esc(range)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", Arial, Helvetica, sans-serif;
    color: #1a1a1a; font-size: 12px; line-height: 1.45;
    padding: 32px 36px;
  }
  .report-head { border-bottom: 2px solid #01563E; padding-bottom: 12px; margin-bottom: 18px;
    display: flex; align-items: center; gap: 12px; }
  .logo { width: 46px; height: 46px; object-fit: contain; flex: none; }
  .brand { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #01563E; font-weight: 700; }
  h1 { font-size: 20px; margin: 4px 0 2px; }
  .meta { font-size: 11px; color: #666; }
  .kpis { display: flex; gap: 10px; margin: 14px 0 8px; }
  .kpi { flex: 1; border: 1px solid #d8dee8; border-radius: 8px; padding: 10px 12px; background: #f4f8f6; }
  .kpi-value { font-size: 20px; font-weight: 700; color: #01563E; }
  .kpi-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
  table.tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em;
    color: #555; background: #eaf1ee; padding: 7px 8px; border-bottom: 1px solid #d8dee8; }
  table.tbl td { padding: 7px 8px; border-bottom: 1px solid #eceff4; vertical-align: top; }
  .tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tbl .util { width: 120px; }
  .tbl .empty { color: #888; font-style: italic; text-align: center; padding: 16px 0; }
  .tag { font-weight: 700; }
  .sub { font-size: 10px; color: #888; }
  .muted { color: #aaa; }
  .bar-row { display: flex; align-items: center; gap: 6px; }
  .bar-track { flex: 1; height: 10px; background: #eceff4; border-radius: 6px; overflow: hidden; min-width: 48px; }
  .bar-fill { height: 100%; background: #01563E; border-radius: 6px; }
  .bar-lbl { font-size: 10px; font-weight: 600; color: #1a1a1a; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #d8dee8; font-size: 10px; color: #888; }
  @media print { body { padding: 0; } table.tbl tr { break-inside: avoid; } }
</style></head>
<body>
  <div class="report-head">
    <img class="logo" src="${DFS_LOGO_DATA_URI}" alt="DFS logo" />
    <div>
      <div class="brand">Drilling Fluid Solutions · Operations</div>
      <h1>${esc(title)}</h1>
      <div class="meta">${esc(range)} · ${esc(report.area_scope)} · Generated ${esc(
        now.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }),
      )}${opts.generatedBy ? ` · by ${esc(opts.generatedBy)}` : ""}</div>
    </div>
  </div>

  ${summaryStrip(report)}
  ${rowsTable(report)}

  <div class="foot">
    Days deployed is the overlap of each asset's current job dates with the selected window; assets
    not on a job (or jobs without a start date) show “—”. Estimated revenue = day rate × days deployed.
    Figures are operational estimates, not accounting records.
  </div>

  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 350);
    });
  </script>
</body></html>`;

  showPdfPreview(html, `${title} · ${range}`);
}
