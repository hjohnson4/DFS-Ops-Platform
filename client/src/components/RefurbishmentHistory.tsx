import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { AssetRefurbishments } from "@shared/schema";
import { parseDisplayDate } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FileText, Loader2, Truck } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Refurbishment history for one asset — closed third-party work orders with
// vendor, dates, what was done, invoice cost, and the invoice file. Shown in
// the asset detail pop-up for admin / area / super.
// ---------------------------------------------------------------------------

export function fmtMoney(n: number | null | undefined, cents = false): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function fmtWoDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = parseDisplayDate(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Invoices are behind auth, so fetch the bytes and open them as a blob.
export async function openWorkOrderInvoice(id: string) {
  const res = await apiRequest("GET", `/api/work-orders/${id}/invoice`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function InvoiceButton({ id, label = "Invoice" }: { id: string; label?: string }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-xs"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await openWorkOrderInvoice(id);
        } catch (e: any) {
          toast({ title: "Could not open the invoice", description: e.message, variant: "destructive" });
        } finally {
          setBusy(false);
        }
      }}
      data-testid={`button-invoice-${id}`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
      {label}
    </Button>
  );
}

export function RefurbishmentHistory({ assetId }: { assetId: string }) {
  const { data, isLoading, error } = useQuery<AssetRefurbishments>({
    queryKey: [`/api/assets/${assetId}/refurbishments`],
  });

  return (
    <div data-testid="refurbishment-history">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Truck className="h-4 w-4 text-muted-foreground" />
          Refurbishment history
          {data && <span className="text-xs text-muted-foreground font-normal">({data.count})</span>}
        </div>
        {data && data.count > 0 && (
          <div className="text-sm">
            <span className="text-xs text-muted-foreground mr-1.5">Total refurbishment cost</span>
            <span className="font-semibold tabular-nums" data-testid="refurb-total">
              {fmtMoney(data.total_cost)}
            </span>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-3">Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive">{(error as Error).message}</div>
      ) : !data ? null : (
        <div className="space-y-2">
          {data.open.map((o) => (
            <div
              key={o.id}
              className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-sm"
              data-testid={`refurb-open-${o.id}`}
            >
              <span className="font-medium">Out now</span>
              <span className="text-muted-foreground">
                {" "}
                · {o.wo_number} · at {o.vendor || "—"} since {fmtWoDate(o.sent_on)}
                {o.due_date ? ` · expected back ${fmtWoDate(o.due_date)}` : ""}
              </span>
            </div>
          ))}
          {data.history.length === 0 ? (
            <div className="rounded-md border border-dashed border-card-border bg-muted/30 p-5 text-center text-sm text-muted-foreground">
              No refurbishments closed out for this asset yet.
            </div>
          ) : (
            <div className="rounded-md border border-card-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-card-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Returned</th>
                    <th className="px-3 py-2 font-medium">Sent to</th>
                    <th className="px-3 py-2 font-medium">What was done</th>
                    <th className="px-3 py-2 font-medium text-right">Cost</th>
                    <th className="px-3 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id} className="border-b border-card-border last:border-0 align-top" data-testid={`refurb-row-${h.id}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div>{fmtWoDate(h.returned_on)}</div>
                        <div className="text-xs text-muted-foreground">
                          {h.wo_number}
                          {h.days_out != null ? ` · ${h.days_out} day${h.days_out === 1 ? "" : "s"} out` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{h.vendor || "—"}</div>
                        <div className="text-xs text-muted-foreground whitespace-nowrap">Sent {fmtWoDate(h.sent_on)}</div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground max-w-xs whitespace-pre-line">
                        {h.work_performed || "—"}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <div className="font-medium tabular-nums">{fmtMoney(h.invoice_total, true)}</div>
                        {h.invoice_number && <div className="text-xs text-muted-foreground">Inv {h.invoice_number}</div>}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        {h.has_invoice ? <InvoiceButton id={h.id} /> : <span className="text-xs text-muted-foreground">No file</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
