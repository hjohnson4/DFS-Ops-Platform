import { type FieldTicketWithJob, workDatesLabel, ticketDatesLabel } from "@shared/schema";
import { DFS_LOGO_DATA_URI } from "./brandAssets";
import { showPdfPreview } from "./pdfPreview";

// Client-side PDF export for a single field ticket. We build a fully styled,
// self-contained HTML document and hand it to the browser's native
// print-to-PDF via a new tab + window.print(). This mirrors the Customers
// module export (client/src/lib/customerExport.ts): no PDF dependency, and it
// works inside the sandboxed iframe (no localStorage, no runtime CDN).

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fmtDate = (d: string | null | undefined): string => {
  if (!d) return "—";
  // Treat yyyy-mm-dd as a plain calendar date (avoid TZ shifting a day back).
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
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const fmtQty = (n: number): string =>
  Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

// A field row on the header grid: label + value. Missing values render "—".
function field(label: string, value: string): string {
  return `<div class="fld"><div class="fld-label">${esc(
    label,
  )}</div><div class="fld-value">${esc(value)}</div></div>`;
}

// "Aug 2 – Aug 4" / "Aug 4" for a line's dates.
const lineDates = (a?: string | null, b?: string | null): string => {
  if (!a) return "—";
  const f = (d: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    return m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : d;
  };
  return b && b > a ? `${f(a)} – ${f(b)}` : f(a);
};

function lineItemsTable(t: FieldTicketWithJob): string {
  const items = t.line_items ?? [];
  const hasDates = items.some((li) => li.start_date);
  const wells = Array.from(new Set(items.map((li) => li.well_name).filter(Boolean)));
  const cols = hasDates ? 5 : 4;
  let lastKey = "";
  let secNo = 0;
  const rows: string[] = [];
  for (const li of items) {
    const key = `${li.section ?? ""}|${li.well_name ?? ""}`;
    const showHead = (li.section || wells.length > 1) && key !== lastKey;
    if (showHead) {
      secNo++;
      const label = [li.section || `Section ${secNo}`, wells.length > 1 ? li.well_name : null].filter(Boolean).join(" · ");
      rows.push(`<tr class="sec"><td colspan="${cols}">${esc(label)}</td></tr>`);
    }
    lastKey = key;
    rows.push(`<tr>
        ${hasDates ? `<td class="dates">${esc(lineDates(li.start_date, li.end_date))}</td>` : ""}
        <td>${esc(li.description)}</td>
        <td class="num">${esc(fmtQty(li.quantity))}</td>
        <td class="num">${esc(fmtMoney(li.unit_cost))}</td>
        <td class="num">${esc(fmtMoney(li.total))}</td>
      </tr>`);
  }
  const bodyRows =
    items.length === 0
      ? `<tr><td colspan="${cols}" class="empty">No line items on this ticket.</td></tr>`
      : rows.join("");
  const lineSum = items.reduce((s, li) => s + (Number(li.total) || 0), 0);
  // The ticket amount can be a manual override; show it as the ticket total.
  const ticketTotal = t.amount != null ? t.amount : lineSum;
  const overridden = t.amount != null && Math.abs(t.amount - lineSum) > 0.005;
  const span = cols - 1;
  return `
    <table class="tbl items">
      <thead><tr>
        ${hasDates ? "<th>Dates</th>" : ""}
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit cost</th>
        <th class="num">Total</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        ${
          overridden
            ? `<tr class="subtotal"><td colspan="${span}" class="num">Line items subtotal</td><td class="num">${esc(
                fmtMoney(lineSum),
              )}</td></tr>`
            : ""
        }
        <tr class="grand"><td colspan="${span}" class="num">Ticket total${
          overridden ? " (adjusted)" : ""
        }</td><td class="num">${esc(fmtMoney(ticketTotal))}</td></tr>
      </tfoot>
    </table>`;
}

export function buildFieldTicketHtml(
  t: FieldTicketWithJob,
  opts: { generatedBy?: string; units?: string[] } = {},
): string {
  const now = new Date();
  const title = `Field Ticket #${t.ticket_number}`;

  const contactBits = [t.customer_phone, t.customer_email]
    .filter(Boolean)
    .map((x) => esc(x))
    .join(" · ");

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
  .report-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #01563E; padding-bottom: 12px; margin-bottom: 18px;
  }
  .brand-row { display: flex; align-items: center; gap: 12px; }
  .logo { width: 46px; height: 46px; object-fit: contain; }
  .brand { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #01563E; font-weight: 700; }
  h1 { font-size: 22px; margin: 4px 0 2px; }
  .meta { font-size: 11px; color: #666; }
  .ticket-num { text-align: right; }
  .ticket-num .big { font-size: 24px; font-weight: 800; color: #01563E; }
  .ticket-num .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #888; }
  h2.section { font-size: 12px; margin: 22px 0 8px; color: #01563E; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #d8dee8; padding-bottom: 4px; }
  .cust-name { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
  .cust-contact { font-size: 11px; color: #555; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; margin-top: 6px; }
  .fld-label { font-size: 9px; text-transform: uppercase; letter-spacing: .04em; color: #888; }
  .fld-value { font-size: 13px; font-weight: 600; }
  table.tbl { width: 100%; border-collapse: collapse; margin-top: 6px; }
  table.tbl th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em;
    color: #555; background: #eef2f8; padding: 7px 9px; border-bottom: 1px solid #d8dee8; }
  table.tbl td { padding: 7px 9px; border-bottom: 1px solid #eceff4; vertical-align: top; }
  .tbl .num { text-align: right; font-variant-numeric: tabular-nums; }
  .tbl tr.sec td { background: #e6efeb; color: #01563E; font-weight: 800; font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 9px; }
  .tbl td.dates { white-space: nowrap; width: 15%; }
  .status { display: inline-block; margin-top: 4px; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; }
  .status.open { background: #fff4d6; color: #8a6400; }
  .status.closed { background: #e0eefa; color: #245a93; }
  .status.approved { background: #dff1e7; color: #01563E; }
  .tbl .empty { color: #888; font-style: italic; text-align: center; padding: 14px 0; }
  .tbl tfoot td { border-bottom: none; padding: 6px 9px; }
  .tbl tfoot .subtotal td { color: #555; }
  .tbl tfoot .grand td { font-size: 14px; font-weight: 800; color: #01563E; border-top: 2px solid #01563E; }
  .desc-box, .comment-box { font-size: 12px; color: #333; background: #f7f9fc; border: 1px solid #e2e8f2;
    border-radius: 6px; padding: 9px 11px; margin-top: 4px; white-space: pre-wrap; min-height: 20px; }
  .sig { display: grid; grid-template-columns: 2fr 1fr; gap: 30px; margin-top: 14px; }
  .sig-line { border-top: 1px solid #333; margin-top: 42px; padding-top: 4px; font-size: 10px; color: #666;
    text-transform: uppercase; letter-spacing: .04em; }
  .sig-name { margin-top: 20px; }
  .foot { margin-top: 30px; padding-top: 10px; border-top: 1px solid #d8dee8; font-size: 10px; color: #888; }
  @media print { body { padding: 0; } .sheet { break-inside: avoid; } }
</style></head>
<body>
  <div class="report-head">
    <div class="brand-row">
      <img class="logo" src="${DFS_LOGO_DATA_URI}" alt="DFS logo" />
      <div>
      <div class="brand">Drilling Fluid Solutions · Operations</div>
      <h1>Field Ticket</h1>
      <div class="meta">Generated ${esc(
        now.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }),
      )}${opts.generatedBy ? ` · by ${esc(opts.generatedBy)}` : ""}</div>
      </div>
    </div>
    <div class="ticket-num">
      <div class="lbl">Ticket No.</div>
      <div class="big">#${esc(t.ticket_number)}</div>
      ${t.ticket_type ? `<div class="meta">${t.ticket_type === "delivery" ? "Delivery ticket" : "Service ticket"}</div>` : ""}
      ${t.status ? `<div class="status ${esc(t.status)}">${esc(t.status === "open" ? "Open · not final" : t.status === "closed" ? "Closed · awaiting approval" : "Approved")}</div>` : ""}
    </div>
  </div>

  <h2 class="section">Customer</h2>
  <div class="cust-name">${esc(t.customer_name || "—")}</div>
  <div class="cust-contact">
    ${t.customer_contact ? `${esc(t.customer_contact)}` : ""}${
      t.customer_contact && contactBits ? " · " : ""
    }${contactBits}
  </div>

  <h2 class="section">Ticket details</h2>
  <div class="grid">
    ${field("Job No.", t.job_number || "—")}
    ${field("Area", t.area || "—")}
    ${field(t.ticket_end_date && t.ticket_end_date !== t.ticket_date ? "Work dates" : "Work date", ticketDatesLabel(t))}
    ${field("County", t.county || "—")}
    ${field("Well name", t.well_name || "—")}
    ${field("P.O. / A.F.E.", t.po_afe || "—")}
    ${t.ordered_by ? field("Ordered by", t.ordered_by) : ""}
    ${opts.units && opts.units.length ? field("Units", opts.units.join(", ")) : ""}
    ${t.status === "approved" && t.approved_at ? field("Approved", `${fmtDate(String(t.approved_at).slice(0, 10))}${t.approved_by_name ? " · " + t.approved_by_name : ""}`) : ""}
  </div>

  <h2 class="section">Description &amp; line items</h2>
  ${
    t.description
      ? `<div class="desc-box">${esc(t.description)}</div>`
      : ""
  }
  ${lineItemsTable(t)}

  <h2 class="section">Comments</h2>
  <div class="comment-box">${t.comments ? esc(t.comments) : "—"}</div>

  <h2 class="section">Customer acceptance</h2>
  <div class="sig">
    <div>
      <div class="sig-line">Customer signature</div>
      <div class="sig-line sig-name">Printed name</div>
    </div>
    <div>
      <div class="sig-line">Date</div>
    </div>
  </div>

  <div class="foot">
    This field ticket reflects work performed by Drilling Fluid Solutions (West Texas · South
    Texas · North Louisiana). Line-item totals are Quantity × Unit cost; the
    ticket total may reflect a manual adjustment where noted. Signature confirms
    the customer's acceptance of the work and quantities shown.
  </div>
</body></html>`;
}

// Open the ticket in the shared in-page preview modal so the user can review it
// and use the explicit Download PDF button. Always returns true (kept for
// backward compatibility with callers that showed a pop-up-blocked fallback).
export function printFieldTicket(html: string, fileLabel?: string): boolean {
  const fromTitle = /<title>([^<]*)<\/title>/i.exec(html)?.[1];
  showPdfPreview(html, fileLabel || fromTitle || "Field Ticket");
  return true;
}
