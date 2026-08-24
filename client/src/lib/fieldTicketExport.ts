import type { FieldTicketWithJob } from "@shared/schema";
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

function lineItemsTable(t: FieldTicketWithJob): string {
  const items = t.line_items ?? [];
  const bodyRows =
    items.length === 0
      ? `<tr><td colspan="4" class="empty">No line items on this ticket.</td></tr>`
      : items
          .map(
            (li) => `<tr>
        <td>${esc(li.description)}</td>
        <td class="num">${esc(fmtQty(li.quantity))}</td>
        <td class="num">${esc(fmtMoney(li.unit_cost))}</td>
        <td class="num">${esc(fmtMoney(li.total))}</td>
      </tr>`,
          )
          .join("");
  const lineSum = items.reduce((s, li) => s + (Number(li.total) || 0), 0);
  // The ticket amount can be a manual override; show it as the ticket total.
  const ticketTotal = t.amount != null ? t.amount : lineSum;
  const overridden = t.amount != null && Math.abs(t.amount - lineSum) > 0.005;
  return `
    <table class="tbl items">
      <thead><tr>
        <th>Description</th>
        <th class="num">Quantity</th>
        <th class="num">Unit cost</th>
        <th class="num">Total</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>
        ${
          items.length > 0
            ? `<tr class="subtotal"><td colspan="3" class="num">Line items subtotal</td><td class="num">${esc(
                fmtMoney(lineSum),
              )}</td></tr>`
            : ""
        }
        <tr class="grand"><td colspan="3" class="num">Ticket total${
          overridden ? " (adjusted)" : ""
        }</td><td class="num">${esc(fmtMoney(ticketTotal))}</td></tr>
      </tfoot>
    </table>`;
}

export function buildFieldTicketHtml(
  t: FieldTicketWithJob,
  opts: { generatedBy?: string } = {},
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
    ${field("Work date", fmtDate(t.ticket_date))}
    ${field("County", t.county || "—")}
    ${field("Well name", t.well_name || "—")}
    ${field("P.O. / A.F.E.", t.po_afe || "—")}
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
