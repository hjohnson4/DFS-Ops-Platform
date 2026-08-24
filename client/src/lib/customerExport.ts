import type { Customer, JobWithCustomer, Area } from "@shared/schema";
import { AREAS } from "@shared/schema";
import { DFS_LOGO_DATA_URI } from "./brandAssets";
import { showPdfPreview } from "./pdfPreview";

// Client-side PDF export for the Customers module. We build a fully styled,
// self-contained HTML report and hand it to the browser's native print-to-PDF
// via a hidden iframe + window.print(). This needs no PDF dependency and works
// inside the sandboxed iframe (no localStorage, no external CDN at runtime).

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const fmtMoney = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const STATUS_ORDER = ["Active", "On Hold", "Completed"] as const;

// Revenue convention mirrors the dashboard: daily revenue = sum of day_rate
// across a customer's ACTIVE, rated jobs. The app has no billed-days data, so
// this is a run-rate figure ($/day), not a lifetime/accrued total.
function dailyRevenueOf(jobs: JobWithCustomer[]): number {
  return jobs
    .filter(
      (j) =>
        j.status === "Active" &&
        j.day_rate != null &&
        !isNaN(Number(j.day_rate)),
    )
    .reduce((sum, j) => sum + Number(j.day_rate), 0);
}

function summaryStrip(customers: Customer[], jobs: JobWithCustomer[]): string {
  const activeCustomers = customers.filter((c) => c.active).length;
  const activeJobs = jobs.filter((j) => j.status === "Active").length;
  const items: Array<[string, string]> = [
    ["Customers", String(customers.length)],
    ["Active customers", String(activeCustomers)],
    ["Active jobs", String(activeJobs)],
    ["Daily revenue", fmtMoney(dailyRevenueOf(jobs))],
  ];
  return `<div class="kpis">${items
    .map(
      ([label, value]) =>
        `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(
          label,
        )}</div></div>`,
    )
    .join("")}</div>`;
}

// Breakdown of jobs by operating area, in the canonical area order.
function areaBreakdown(jobs: JobWithCustomer[]): string {
  const rows = (AREAS as readonly Area[])
    .map((area) => {
      const inArea = jobs.filter((j) => j.area === area);
      if (inArea.length === 0) return null;
      const active = inArea.filter((j) => j.status === "Active").length;
      const customers = new Set(inArea.map((j) => j.customer_id)).size;
      return `<tr><td>${esc(area)}</td><td class="num">${customers}</td><td class="num">${
        inArea.length
      }</td><td class="num">${active}</td><td class="num">${esc(
        fmtMoney(dailyRevenueOf(inArea)),
      )}</td></tr>`;
    })
    .filter(Boolean);
  if (rows.length === 0) return "";
  return `
    <h2 class="section">Jobs by area</h2>
    <table class="tbl">
      <thead><tr><th>Operating area</th><th class="num">Customers</th><th class="num">Jobs</th><th class="num">Active</th><th class="num">Daily revenue</th></tr></thead>
      <tbody>${rows.join("")}</tbody>
    </table>`;
}

function jobsTable(jobs: JobWithCustomer[]): string {
  if (jobs.length === 0) {
    return `<div class="empty">No jobs assigned to this customer.</div>`;
  }
  const sorted = [...jobs].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status),
  );
  const rows = sorted
    .map(
      (j) => `<tr>
        <td class="mono">${esc(j.job_number)}</td>
        <td>${esc(j.area)}</td>
        <td>${esc(j.well_name || "—")}</td>
        <td>${esc(j.description || "—")}</td>
        <td>${esc(j.crewing || "Manned")}</td>
        <td class="num">${esc(fmtMoney(j.day_rate))}</td>
        <td>${esc(fmtDate(j.started_on))}</td>
        <td><span class="badge badge-${j.status.replace(/\s+/g, "").toLowerCase()}">${esc(
          j.status,
        )}</span></td>
      </tr>`,
    )
    .join("");
  return `
    <table class="tbl jobs">
      <thead><tr>
        <th>Job #</th><th>Area</th><th>Well</th><th>Description</th>
        <th>Crewing</th><th class="num">Day rate</th><th>Started</th><th>Status</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function customerCard(c: Customer, jobs: JobWithCustomer[]): string {
  const areas = Array.from(new Set(jobs.map((j) => j.area)));
  const activeJobs = jobs.filter((j) => j.status === "Active").length;
  const dailyRev = dailyRevenueOf(jobs);
  return `
    <section class="customer">
      <div class="cust-head">
        <div>
          <div class="cust-name">${esc(c.name)}${
            c.active ? "" : ' <span class="inactive">Inactive</span>'
          }</div>
          <div class="cust-contact">
            ${c.primary_contact ? `<span>${esc(c.primary_contact)}</span>` : ""}
            ${c.phone ? `<span>${esc(c.phone)}</span>` : ""}
            ${c.email ? `<span>${esc(c.email)}</span>` : ""}
          </div>
        </div>
        <div class="cust-stats">
          <span><strong>${jobs.length}</strong> jobs · <strong>${activeJobs}</strong> active</span>
          <span class="cust-rev">${esc(fmtMoney(dailyRev))}<span class="rev-unit">/day</span></span>
          <span>${areas.length ? esc(areas.join(", ")) : "No areas"}</span>
        </div>
      </div>
      ${c.notes ? `<div class="cust-notes"><span class="lbl">Notes</span> ${esc(c.notes)}</div>` : ""}
      ${jobsTable(jobs)}
    </section>`;
}

export interface CustomerExportOptions {
  // When set, export only this one customer (used from the detail page).
  singleCustomerId?: string;
  generatedBy?: string;
}

export function buildCustomerReportHtml(
  customers: Customer[],
  jobs: JobWithCustomer[],
  opts: CustomerExportOptions = {},
): string {
  const scoped = opts.singleCustomerId
    ? customers.filter((c) => c.id === opts.singleCustomerId)
    : customers;

  const jobsByCustomer = (id: string) => jobs.filter((j) => j.customer_id === id);
  const scopedJobs = opts.singleCustomerId
    ? jobsByCustomer(opts.singleCustomerId)
    : jobs;

  const now = new Date();
  const title = opts.singleCustomerId
    ? `Customer report — ${scoped[0]?.name ?? "Customer"}`
    : "Customer & jobs report";

  const cards = [...scoped]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => customerCard(c, jobsByCustomer(c.id)))
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
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
  h2.section { font-size: 13px; margin: 22px 0 8px; color: #01563E; border-bottom: 1px solid #d8dee8; padding-bottom: 4px; }
  .kpis { display: flex; gap: 10px; margin: 14px 0 4px; }
  .kpi { flex: 1; border: 1px solid #d8dee8; border-radius: 8px; padding: 10px 12px; background: #f7f9fc; }
  .kpi-value { font-size: 20px; font-weight: 700; color: #01563E; }
  .kpi-label { font-size: 10px; color: #666; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
  table.tbl { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em;
    color: #555; background: #eef2f8; padding: 6px 8px; border-bottom: 1px solid #d8dee8; }
  table.tbl td { padding: 6px 8px; border-bottom: 1px solid #eceff4; vertical-align: top; }
  .tbl .num { text-align: right; }
  .mono { font-variant-numeric: tabular-nums; font-weight: 600; }
  .customer { margin-top: 20px; page-break-inside: avoid; border: 1px solid #d8dee8; border-radius: 10px; padding: 14px 16px; }
  .cust-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
  .cust-name { font-size: 15px; font-weight: 700; }
  .inactive { font-size: 10px; color: #999; font-weight: 500; }
  .cust-contact { font-size: 11px; color: #555; margin-top: 2px; }
  .cust-contact span:not(:last-child)::after { content: " · "; color: #bbb; }
  .cust-stats { font-size: 11px; color: #444; text-align: right; white-space: nowrap; }
  .cust-stats span { display: block; }
  .cust-rev { font-size: 15px; font-weight: 700; color: #01563E; margin: 2px 0; }
  .rev-unit { font-size: 10px; font-weight: 500; color: #888; }
  .cust-notes { font-size: 11px; color: #444; margin: 8px 0 2px; background: #f7f9fc; border-radius: 6px; padding: 6px 8px; }
  .cust-notes .lbl { color: #888; text-transform: uppercase; font-size: 9px; letter-spacing: .05em; }
  .empty { font-size: 11px; color: #888; padding: 8px 0 2px; font-style: italic; }
  .badge { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; }
  .badge-active { background: #dcf5e6; color: #1a7a44; }
  .badge-onhold { background: #fdf0d5; color: #9a6a12; }
  .badge-completed { background: #eceff4; color: #555; }
  .foot { margin-top: 26px; padding-top: 10px; border-top: 1px solid #d8dee8; font-size: 10px; color: #888; }
  @media print {
    body { padding: 0; }
    .customer { break-inside: avoid; }
  }
</style></head>
<body>
  <div class="report-head">
    <img class="logo" src="${DFS_LOGO_DATA_URI}" alt="DFS logo" />
    <div>
    <div class="brand">Drilling Fluid Solutions · Operations</div>
    <h1>${esc(title)}</h1>
    <div class="meta">Generated ${esc(
      now.toLocaleString("en-US", {
        dateStyle: "long",
        timeStyle: "short",
      }),
    )}${opts.generatedBy ? ` · by ${esc(opts.generatedBy)}` : ""}</div>
    </div>
  </div>

  ${summaryStrip(scoped, scopedJobs)}
  ${opts.singleCustomerId ? "" : areaBreakdown(scopedJobs)}

  <h2 class="section">${opts.singleCustomerId ? "Customer detail" : "Customers"}</h2>
  ${cards || '<div class="empty">No customers to report.</div>'}

  <div class="foot">
    Daily revenue is the run-rate figure used on the dashboard: the sum of the day
    rate ($/day) across each customer's active jobs. It is not a lifetime or
    billed-to-date total. This report reflects data visible to the account that
    generated it — jobs are scoped to your operating area (Drilling Fluid Solutions — West Texas ·
    South Texas · North Louisiana).
  </div>
</body></html>`;
}

// Open the report in the shared in-page preview modal, where the user can review
// it and use the explicit Download PDF button. Always returns true (kept for
// backward compatibility with callers that showed a pop-up-blocked fallback).
export function printCustomerReport(
  html: string,
  fileLabel = "Customer Revenue Report",
): boolean {
  showPdfPreview(html, fileLabel);
  return true;
}
