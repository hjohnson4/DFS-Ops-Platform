import { DFS_LOGO_DATA_URI } from "./brandAssets";
import { showPdfPreview } from "./pdfPreview";

// Generic branded PDF report builder shared by the Service and Maintenance
// module exports. Same approach as utilizationExport / customerExport: build a
// fully self-contained styled HTML document and hand it to the browser's native
// print-to-PDF via a new tab + window.print(). No PDF dependency; works inside
// the sandboxed iframe.

export interface ReportColumn<Row> {
  header: string;
  /** Cell content (already display-formatted). May return HTML string. */
  cell: (row: Row) => string;
  align?: "left" | "right";
  /** Optional fixed width, e.g. "90px". */
  width?: string;
  /** If true, cell() output is treated as raw HTML (not escaped). */
  html?: boolean;
}

export interface ReportKpi {
  label: string;
  value: string;
}

export interface BrandedReportOptions<Row> {
  title: string;
  subtitle: string; // e.g. date range + scope line
  generatedBy?: string;
  kpis: ReportKpi[];
  columns: ReportColumn<Row>[];
  rows: Row[];
  emptyMessage?: string;
  footnote?: string;
  /** Filename hint used for the browser tab title. */
  fileLabel?: string;
}

export const escapeHtml = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const fmtReportDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
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

export const fmtFileSize = (bytes: number | null | undefined): string => {
  if (bytes == null || isNaN(Number(bytes))) return "—";
  const b = Number(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
};

export function buildBrandedReport<Row>(opts: BrandedReportOptions<Row>): string {
  const now = new Date();
  const colCount = opts.columns.length;

  const kpiHtml = opts.kpis
    .map(
      (k) =>
        `<div class="kpi"><div class="kpi-value">${escapeHtml(k.value)}</div><div class="kpi-label">${escapeHtml(k.label)}</div></div>`,
    )
    .join("");

  const headHtml = opts.columns
    .map(
      (c) =>
        `<th class="${c.align === "right" ? "num" : ""}"${c.width ? ` style="width:${c.width}"` : ""}>${escapeHtml(c.header)}</th>`,
    )
    .join("");

  const bodyHtml =
    opts.rows.length === 0
      ? `<tr><td colspan="${colCount}" class="empty">${escapeHtml(opts.emptyMessage || "No records for this window.")}</td></tr>`
      : opts.rows
          .map((row) => {
            const cells = opts.columns
              .map((c) => {
                const raw = c.cell(row);
                const content = c.html ? raw : escapeHtml(raw);
                return `<td class="${c.align === "right" ? "num" : ""}">${content}</td>`;
              })
              .join("");
            return `<tr>${cells}</tr>`;
          })
          .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.fileLabel || opts.title)}</title>
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
  .kpis { display: flex; gap: 10px; margin: 14px 0 8px; flex-wrap: wrap; }
  .kpi { flex: 1; min-width: 120px; border: 1px solid #d8dee8; border-radius: 8px; padding: 10px 12px; background: #f4f8f6; }
  .kpi-value { font-size: 20px; font-weight: 700; color: #01563E; }
  .kpi-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
  table.tbl { width: 100%; border-collapse: collapse; margin-top: 8px; }
  table.tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em;
    color: #555; background: #eaf1ee; padding: 7px 8px; border-bottom: 1px solid #d8dee8; }
  table.tbl td { padding: 7px 8px; border-bottom: 1px solid #eceff4; vertical-align: top; }
  .tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .tbl th.num { text-align: right; }
  .tbl .empty { color: #888; font-style: italic; text-align: center; padding: 16px 0; }
  .tag { font-weight: 700; }
  .sub { font-size: 10px; color: #888; }
  .muted { color: #aaa; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 10px; font-weight: 600;
    background: #eaf1ee; color: #01563E; border: 1px solid #cfe0d8; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #d8dee8; font-size: 10px; color: #888; }
  @media print { body { padding: 0; } table.tbl tr { break-inside: avoid; } }
</style></head>
<body>
  <div class="report-head">
    <img class="logo" src="${DFS_LOGO_DATA_URI}" alt="DFS logo" />
    <div>
      <div class="brand">Drilling Fluid Solutions · Operations</div>
      <h1>${escapeHtml(opts.title)}</h1>
      <div class="meta">${escapeHtml(opts.subtitle)} · Generated ${escapeHtml(
        now.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }),
      )}${opts.generatedBy ? ` · by ${escapeHtml(opts.generatedBy)}` : ""}</div>
    </div>
  </div>

  ${opts.kpis.length ? `<div class="kpis">${kpiHtml}</div>` : ""}

  <table class="tbl">
    <thead><tr>${headHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>

  ${opts.footnote ? `<div class="foot">${escapeHtml(opts.footnote)}</div>` : ""}

  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 350);
    });
  </script>
</body></html>`;
}

/** Open a built HTML report string in the shared in-page preview modal. */
export function openReportDocument(html: string, fileLabel = "DFS Report"): void {
  showPdfPreview(html, fileLabel);
}

// ---------------------------------------------------------------------------
// Service reports export
// ---------------------------------------------------------------------------
export interface ServiceExportRow {
  created_at: string;
  job_number: string | null;
  well_name: string | null;
  area: string | null;
  customer_name: string | null;
  file_name: string | null;
  file_size: number | null;
  uploaded_by_name: string | null;
  notes: string | null;
}

export interface ServiceExportReport {
  start: string;
  end: string;
  window_days: number;
  area_scope: string;
  summary: {
    report_count: number;
    area_count: number;
    customer_count: number;
    by_area: Record<string, number>;
  };
  rows: ServiceExportRow[];
}

export function exportServiceReportsPdf(
  report: ServiceExportReport,
  opts: { generatedBy?: string } = {},
): void {
  const range = `${fmtReportDate(report.start)} – ${fmtReportDate(report.end)} (${report.window_days} days)`;
  const html = buildBrandedReport<ServiceExportRow>({
    title: "Service Reports",
    subtitle: `${range} · ${report.area_scope}`,
    fileLabel: `Service Reports · ${range}`,
    generatedBy: opts.generatedBy,
    kpis: [
      { label: "Reports", value: String(report.summary.report_count) },
      { label: "Areas", value: String(report.summary.area_count) },
      { label: "Customers", value: String(report.summary.customer_count) },
      { label: "Window", value: `${report.window_days} days` },
    ],
    columns: [
      { header: "Date", cell: (r) => fmtReportDate(r.created_at), width: "96px" },
      {
        header: "Job / Well",
        html: true,
        cell: (r) =>
          `<span class="tag">${escapeHtml(r.well_name || r.job_number || "—")}</span>` +
          (r.job_number && r.well_name
            ? `<div class="sub">${escapeHtml(r.job_number)}</div>`
            : ""),
      },
      { header: "Area", cell: (r) => r.area || "—", width: "100px" },
      { header: "Customer", cell: (r) => r.customer_name || "—" },
      {
        header: "File",
        html: true,
        cell: (r) =>
          `${escapeHtml(r.file_name || "—")}<div class="sub">${escapeHtml(fmtFileSize(r.file_size))}</div>`,
      },
      { header: "Uploaded by", cell: (r) => r.uploaded_by_name || "—", width: "120px" },
    ],
    rows: report.rows,
    emptyMessage: "No service reports were uploaded in this window.",
    footnote:
      "Each row is a service report document uploaded against a job. Reports are scoped to your operating area. Figures are operational records, not accounting documents.",
  });
  openReportDocument(html, `Service Reports · ${range}`);
}

// ---------------------------------------------------------------------------
// Maintenance reports export
// ---------------------------------------------------------------------------
export interface MaintenanceExportRow {
  report_date: string;
  filed_at: string;
  asset_tag: string | null;
  asset_category: string | null;
  area: string | null;
  work_type: string;
  status: string;
  supervisor_name: string | null;
  notes: string | null;
}

export interface MaintenanceExportReport {
  start: string;
  end: string;
  window_days: number;
  area_scope: string;
  summary: {
    report_count: number;
    asset_count: number;
    by_work_type: Record<string, number>;
    by_status: Record<string, number>;
  };
  rows: MaintenanceExportRow[];
}

export function exportMaintenanceReportsPdf(
  report: MaintenanceExportReport,
  opts: { generatedBy?: string } = {},
): void {
  const range = `${fmtReportDate(report.start)} – ${fmtReportDate(report.end)} (${report.window_days} days)`;
  const html = buildBrandedReport<MaintenanceExportRow>({
    title: "Maintenance Reports",
    subtitle: `${range} · ${report.area_scope}`,
    fileLabel: `Maintenance Reports · ${range}`,
    generatedBy: opts.generatedBy,
    kpis: [
      { label: "Reports", value: String(report.summary.report_count) },
      { label: "Assets serviced", value: String(report.summary.asset_count) },
      { label: "Window", value: `${report.window_days} days` },
    ],
    columns: [
      { header: "Date", cell: (r) => fmtReportDate(r.report_date), width: "96px" },
      {
        header: "Asset",
        html: true,
        cell: (r) =>
          `<span class="tag">${escapeHtml(r.asset_tag || "—")}</span>` +
          (r.asset_category ? `<div class="sub">${escapeHtml(r.asset_category)}</div>` : ""),
      },
      { header: "Area", cell: (r) => r.area || "—", width: "100px" },
      {
        header: "Work type",
        html: true,
        cell: (r) => `<span class="pill">${escapeHtml(r.work_type)}</span>`,
      },
      { header: "Status", cell: (r) => r.status || "—", width: "100px" },
      { header: "Supervisor", cell: (r) => r.supervisor_name || "—", width: "120px" },
      { header: "Notes", cell: (r) => r.notes || "—" },
    ],
    rows: report.rows,
    emptyMessage: "No maintenance reports were filed in this window.",
    footnote:
      "Each row is a filed maintenance/inspection report. Reports are scoped to your operating area. Figures are operational records, not accounting documents.",
  });
  openReportDocument(html, `Maintenance Reports · ${range}`);
}
