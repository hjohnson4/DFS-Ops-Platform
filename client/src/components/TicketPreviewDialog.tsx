// Ticket preview: the job's field ticket as if the job ended today, laid out
// like the paper DFS ticket. Built live from the daily reports; Admin / Area
// Manager can edit it (saved as a draft per well) and turn it into a real
// field ticket. Supervisors view only.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  type FieldTicketWithJob,
  type LineItem,
  type TicketPreview,
  type TicketPreviewHeader,
  type TicketPreviewLine,
  isLiveJobStatus,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { buildFieldTicketHtml, printFieldTicket } from "@/lib/fieldTicketExport";
import { AlertTriangle, CheckCircle2, EyeOff, FileDown, Loader2, Pencil, Plus, RotateCcw, Trash2, Undo2 } from "lucide-react";

const money0 = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const md = (d?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}` : "";
};
const mdy = (d?: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d ?? ""));
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}` : String(d ?? "");
};
const round2 = (n: number) => Math.round(n * 100) / 100;

type Override = { description?: string | null; quantity?: number | null; unit_cost?: number | null; hidden?: boolean };
type UserLine = { id: string; description: string; quantity: number; unit_cost: number; date: string | null; note: string | null };

// Ticket lines the preview turns into (also used for Print / PDF).
export function previewToLineItems(p: TicketPreview): LineItem[] {
  const out: LineItem[] = [];
  const well = p.header.well_name || p.well_name;
  for (const l of p.lines) {
    if (l.hidden) continue;
    if (l.kind === "service" && l.service_ids.length) {
      const sameRate = l.quantity === l.service_ids.length;
      l.service_ids.forEach((sid, i) => {
        const unit = sameRate ? l.unit_cost : l.service_costs?.[i] ?? 0;
        const note = l.notes[i] ?? "";
        const date = /^(\d+)\/(\d+)/.exec(note);
        out.push({
          description: `${l.description}${note ? ` — ${note}` : ""}`,
          quantity: 1,
          unit_cost: unit,
          total: round2(unit),
          start_date: date && l.start_date ? `${l.start_date.slice(0, 4)}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}` : l.start_date,
          end_date: null,
          well_name: well,
          service_id: sid,
        });
      });
      continue;
    }
    let desc = l.description;
    if (l.dates_label) desc += ` ${l.dates_label}`;
    if (l.breakdown.length) desc += ` (${l.breakdown.map((b) => `${b.label.trim()} ${money0(b.amount)}`).join(", ")})`;
    if (l.notes.length) desc += ` (${l.notes.join("; ")})`;
    out.push({
      description: desc,
      quantity: l.quantity,
      unit_cost: l.unit_cost,
      total: round2(l.quantity * l.unit_cost),
      start_date: l.start_date,
      end_date: l.end_date && l.end_date !== l.start_date ? l.end_date : null,
      well_name: well,
    });
  }
  return out;
}

const STATUS_PILL: Record<string, string> = {
  "Signed off": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "Pending Review": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
};

export function TicketPreviewDialog({ jobId, trigger }: { jobId: string; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [well, setWell] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();
  const { profile } = useAuth();

  const key = ["/api/jobs", jobId, "ticket-preview", well];
  const { data: p, isLoading, error } = useQuery<TicketPreview>({
    queryKey: key,
    enabled: open,
    queryFn: async () =>
      (await apiRequest("GET", `/api/jobs/${jobId}/ticket-preview${well ? `?well=${encodeURIComponent(well)}` : ""}`)).json(),
  });
  useEffect(() => {
    if (p && !well && p.well_name) setWell(p.well_name);
  }, [p, well]);

  // ---- edit state
  const [hdr, setHdr] = useState<TicketPreviewHeader | null>(null);
  const [ovr, setOvr] = useState<Record<string, Override>>({});
  const [userLines, setUserLines] = useState<UserLine[]>([]);
  const startEdit = () => {
    if (!p) return;
    setHdr({ ...p.header });
    const o: Record<string, Override> = {};
    for (const l of p.lines)
      if (l.kind !== "user" && l.edited) o[l.key] = { description: l.description, quantity: l.quantity, unit_cost: l.unit_cost, hidden: l.hidden };
    setOvr(o);
    setUserLines(
      p.lines
        .filter((l) => l.kind === "user")
        .map((l) => ({ id: l.user_id!, description: l.description, quantity: l.quantity, unit_cost: l.unit_cost, date: l.user_date ?? null, note: l.notes[0] ?? null })),
    );
    setEditing(true);
  };

  const setData = (d: TicketPreview) => queryClient.setQueryData(["/api/jobs", jobId, "ticket-preview", d.well_name], d);
  const saveMut = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("PUT", `/api/jobs/${jobId}/ticket-preview`, {
          well_name: p!.well_name,
          header: hdr,
          overrides: ovr,
          extra_lines: userLines.map((u) => ({ ...u, description: u.description.trim() })),
        })
      ).json(),
    onSuccess: (d: TicketPreview) => {
      setData(d);
      setEditing(false);
      toast({ title: "Ticket preview saved", description: "Your edits stay on this well's preview until it's made into a field ticket." });
    },
    onError: (e: any) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const resetMut = useMutation({
    mutationFn: async () =>
      (await apiRequest("DELETE", `/api/jobs/${jobId}/ticket-preview?well=${encodeURIComponent(p!.well_name)}`)).json(),
    onSuccess: (d: TicketPreview) => {
      setData(d);
      setEditing(false);
      toast({ title: "Back to the reports", description: "Edits on this well's preview were cleared." });
    },
    onError: (e: any) => toast({ title: "Could not reset", description: e.message, variant: "destructive" }),
  });
  const makeMut = useMutation({
    mutationFn: async () => {
      const items = previewToLineItems(p!);
      if (!items.length) throw new Error("There's nothing on the preview to put on a ticket.");
      const res = await apiRequest("POST", `/api/jobs/${jobId}/field-tickets`, {
        ticket_type: p!.header.ticket_type,
        ordered_by: p!.header.ordered_by || null,
        ticket_date: items.map((l) => l.start_date).filter(Boolean).sort()[0] ?? p!.header.date,
        county: p!.header.county || null,
        well_name: p!.header.well_name || p!.well_name,
        po_afe: p!.header.po_afe || null,
        comments: p!.header.comments || null,
        line_items: items,
      });
      const t: FieldTicketWithJob = await res.json();
      await apiRequest("DELETE", `/api/jobs/${jobId}/ticket-preview?well=${encodeURIComponent(p!.well_name)}`).catch(() => null);
      return t;
    },
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: ["/api/jobs", jobId] });
      queryClient.invalidateQueries({ queryKey: ["/api/field-tickets"] });
      toast({ title: `Field ticket #${t.ticket_number} created`, description: "It's Open on the job's Field tickets list. These days are now off the preview." });
      setOpen(false);
    },
    onError: (e: any) => toast({ title: "Could not create the ticket", description: e.message, variant: "destructive" }),
  });

  // What's shown: saved preview, or the preview with in-progress edits applied.
  const view: TicketPreview | null = useMemo(() => {
    if (!p) return null;
    if (!editing || !hdr) return p;
    const lines: TicketPreviewLine[] = p.lines
      .filter((l) => l.kind !== "user")
      .map((l) => {
        const o = ovr[l.key];
        if (!o) return l;
        const q = o.quantity ?? l.quantity;
        const u = o.unit_cost ?? l.unit_cost;
        return { ...l, description: o.description ?? l.description, quantity: q, unit_cost: u, total: round2(q * u), hidden: !!o.hidden, edited: true };
      });
    for (const u of userLines)
      lines.push({
        key: `user:${u.id}`, kind: "user", description: u.description, dates_label: null,
        start_date: u.date || p.days[p.days.length - 1]?.date || p.header.date, end_date: null,
        quantity: u.quantity, unit_cost: u.unit_cost, total: round2(u.quantity * u.unit_cost),
        breakdown: [], notes: u.note ? [u.note] : [], edited: true, hidden: false, service_ids: [], user_id: u.id, user_date: u.date,
      });
    return { ...p, header: hdr, lines, total: round2(lines.filter((l) => !l.hidden).reduce((s, l) => s + l.total, 0)) };
  }, [p, editing, hdr, ovr, userLines]);

  const canEdit = !!p?.can_edit;
  const live = p ? isLiveJobStatus(p.job_status as any) : false;
  const busy = saveMut.isPending || resetMut.isPending || makeMut.isPending;
  const openDays = p ? p.days.filter((d) => d.on_ticket == null) : [];
  const lastCum = openDays.length ? openDays[openDays.length - 1].cumulative : null;

  const printPdf = () => {
    if (!view) return;
    const items = previewToLineItems(view);
    const t = {
      ticket_number: "PREVIEW",
      status: "open",
      ticket_type: view.header.ticket_type,
      ordered_by: view.header.ordered_by || null,
      county: view.header.county || null,
      po_afe: view.header.po_afe || null,
      comments: view.header.comments || null,
      line_items: items,
      asset_ids: [],
      amount: view.total,
      well_name: view.header.well_name || view.well_name,
      ticket_date: items.map((l) => l.start_date).filter(Boolean).sort()[0] ?? view.header.date,
      job_number: view.job_number,
      customer_name: view.header.customer,
      history: [],
    } as unknown as FieldTicketWithJob;
    printFieldTicket(buildFieldTicketHtml(t, { generatedBy: profile?.name }), `Ticket preview — ${view.job_number}`);
  };

  // Plain function (not a component) so inputs keep focus while typing.
  const H = ({ k, label }: { k: keyof TicketPreviewHeader; label: string }) => (
    <div key={k}>
      <div className="border-b border-neutral-900 min-h-[26px] flex items-end justify-center pb-0.5">
        {editing && hdr ? (
          <Input
            className="h-7 text-center bg-amber-50 border-amber-500 text-neutral-900"
            value={String(hdr[k] ?? "")}
            onChange={(e) => setHdr({ ...hdr, [k]: e.target.value } as TicketPreviewHeader)}
            data-testid={`preview-header-${k}`}
          />
        ) : (
          <span className="font-[cursive] text-[15px] text-indigo-900">{(k === "date" ? mdy(view?.header.date) : String(view?.header[k] ?? "")) || "\u00a0"}</span>
        )}
      </div>
      <div className="text-center text-[10px] text-neutral-700">{label}</div>
    </div>
  );

  const numIn = (v: number, on: (n: number) => void, tid: string) => (
    <Input
      type="number"
      inputMode="decimal"
      className="h-7 w-full text-center bg-amber-50 border-amber-500 text-neutral-900 px-1"
      value={Number.isFinite(v) ? v : 0}
      onChange={(e) => on(Math.max(0, Number(e.target.value) || 0))}
      data-testid={tid}
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setEditing(false);
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-[1200px] w-[96vw] max-h-[94vh] overflow-y-auto p-0" data-testid="dialog-ticket-preview">
        <DialogHeader className={`px-5 py-3 ${editing ? "bg-amber-600" : "bg-[#0d5c3f]"} text-white sticky top-0 z-10`}>
          <DialogTitle className="text-base font-semibold flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>{editing ? "Editing ticket preview" : "Ticket preview"}{p ? ` — ${p.job_number}` : ""}</span>
            {p && p.wells.length > 1 && !editing && (
              <Select value={p.well_name} onValueChange={(w) => setWell(w)}>
                <SelectTrigger className="h-8 w-[260px] bg-white text-neutral-900" data-testid="select-preview-well">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {p.wells.map((w) => (
                    <SelectItem key={w.key} value={w.well_name}>
                      {w.well_name} · {w.open_days} open day{w.open_days === 1 ? "" : "s"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <span className="ml-auto flex flex-wrap gap-2">
              {!editing && p && (
                <Button size="sm" variant="secondary" onClick={printPdf} data-testid="button-preview-pdf">
                  <FileDown className="mr-1 h-4 w-4" /> Print / PDF
                </Button>
              )}
              {!editing && canEdit && live && p && p.drafts_ready && (
                <Button size="sm" variant="secondary" onClick={startEdit} data-testid="button-preview-edit">
                  <Pencil className="mr-1 h-4 w-4" /> Edit
                </Button>
              )}
              {!editing && canEdit && live && p && view && view.lines.some((l) => !l.hidden) && (
                <Button
                  size="sm"
                  className="bg-white text-[#0d5c3f] hover:bg-neutral-100"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Create an Open field ticket for ${p.well_name} with these lines (${money0(view.total)})? The days on it will drop off the preview.`))
                      makeMut.mutate();
                  }}
                  data-testid="button-preview-make-ticket"
                >
                  {makeMut.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
                  Make field ticket
                </Button>
              )}
              {editing && (
                <>
                  <Button size="sm" className="bg-white text-amber-700 hover:bg-neutral-100" disabled={busy} onClick={() => saveMut.mutate()} data-testid="button-preview-save">
                    {saveMut.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />} Save
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(false)} data-testid="button-preview-cancel">
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Clear every edit on this well's preview and go back to what the reports say?")) resetMut.mutate();
                    }}
                    data-testid="button-preview-reset"
                  >
                    <RotateCcw className="mr-1 h-4 w-4" /> Reset to reports
                  </Button>
                </>
              )}
            </span>
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="p-10 text-center text-muted-foreground">
            <Loader2 className="inline mr-2 h-4 w-4 animate-spin" /> Building the preview…
          </div>
        )}
        {error && <div className="p-6 text-destructive">{(error as any).message}</div>}

        {view && (
          <div className="flex flex-col lg:flex-row gap-4 p-4 bg-neutral-100 dark:bg-neutral-900">
            {/* ------------------------------------------------ paper ticket */}
            <div className="bg-white text-neutral-900 shadow p-5 flex-1 min-w-0 relative" data-testid="preview-paper">
              <div className="flex justify-between gap-3">
                <div className="italic text-[11px] leading-5 w-36 shrink-0 hidden sm:block">
                  • Closed Loop Systems<br />• Dewatering<br />• Solid Control Rentals<br />• Screen Sales
                </div>
                <div className="text-center flex-1">
                  <div className="font-serif text-xl sm:text-2xl [font-variant:small-caps] border-b-4 border-double border-neutral-900 inline-block">
                    Drilling Fluid Solutions, L.L.C.
                  </div>
                  <div className="text-xs mt-1">P.O. Box 111 • Rayne, LA 70578</div>
                  <div className="text-xs">Office: 337-223-6010 • Fax: 337-223-6011</div>
                </div>
                <div className="text-sm w-48 shrink-0">
                  <div className="text-lg font-bold">
                    Ticket No. <span className="text-red-700">PREVIEW</span>
                  </div>
                  {(["service", "delivery"] as const).map((t) => (
                    <label key={t} className="flex items-center gap-2 mt-1 cursor-default">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-neutral-900"
                        checked={view.header.ticket_type === t}
                        disabled={!editing}
                        onChange={() => hdr && setHdr({ ...hdr, ticket_type: t })}
                        data-testid={`preview-type-${t}`}
                      />
                      {t === "service" ? "SERVICE TICKET" : "DELIVERY TICKET"}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-[1.3fr_1fr] gap-x-8 gap-y-1.5 mt-4">
                {H({ k: "customer", label: "Customer" })}
                {H({ k: "date", label: "Date" })}
                {H({ k: "address", label: "P.O. Box or Street Address" })}
                {H({ k: "ordered_by", label: "Ordered By" })}
                {H({ k: "city_state_zip", label: "City / State / Zip Code" })}
                <div />
                {H({ k: "county", label: "Parish / County" })}
                {H({ k: "po_afe", label: "Customer P.O. or A.F.E. No." })}
                {H({ k: "well_name", label: "Well Name / Lease No." })}
                {H({ k: "job_no", label: "Job No. (RSC)" })}
              </div>

              <table className="w-full mt-4 border-collapse text-[13px]">
                <thead>
                  <tr>
                    {["CODE", "DESCRIPTION", "QTY.", "UNIT COST", "TOTAL"].map((h, i) => (
                      <th key={h} className={`border-2 border-neutral-900 py-1 ${["w-12", "", "w-20", "w-28", "w-28"][i]}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.lines.length === 0 && (
                    <tr>
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-neutral-900 px-2 py-3 text-neutral-500" colSpan={1}>
                        {view.last_ticketed_date
                          ? `Every report day through ${mdy(view.last_ticketed_date)} is already on a field ticket.`
                          : "No report days on this job yet."}
                      </td>
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-neutral-900" />
                    </tr>
                  )}
                  {view.lines.map((l) => {
                    const o = ovr[l.key] || {};
                    const setO = (patch: Override) => setOvr({ ...ovr, [l.key]: { description: l.description, quantity: l.quantity, unit_cost: l.unit_cost, ...o, ...patch } });
                    const u = l.kind === "user" ? userLines.find((x) => x.id === l.user_id) : null;
                    const setU = (patch: Partial<UserLine>) => setUserLines(userLines.map((x) => (x.id === l.user_id ? { ...x, ...patch } : x)));
                    if (l.hidden && !editing) return null;
                    const sub = [
                      ...(l.breakdown.length
                        ? [<span key="b" className="block pl-4 text-[11px] text-neutral-600 leading-4">{l.breakdown.map((b) => `${b.label.trim()} ${money0(b.amount)}`).join(" · ")}</span>]
                        : []),
                      ...l.notes.map((n, i) => (
                        <span key={i} className="block pl-4 font-[cursive] text-indigo-900 text-[13px]">{n}</span>
                      )),
                    ];
                    return (
                      <tr key={l.key} className={`align-top ${l.hidden ? "opacity-40" : ""}`} data-testid={`preview-line-${l.key}`}>
                        <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400" />
                        <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400 px-2 py-1">
                          <div className="flex items-center gap-2">
                            {editing ? (
                              <Input
                                className="h-7 bg-amber-50 border-amber-500 text-neutral-900 font-semibold"
                                value={u ? u.description : o.description ?? l.description}
                                placeholder="e.g. Trucking, Rig-up material"
                                onChange={(e) => (u ? setU({ description: e.target.value }) : setO({ description: e.target.value }))}
                                data-testid={`preview-desc-${l.key}`}
                              />
                            ) : (
                              <span className="font-semibold">{l.description}</span>
                            )}
                            {l.dates_label && <span className="font-[cursive] text-indigo-900 whitespace-nowrap">{l.dates_label}</span>}
                            {editing && u && (
                              <Input
                                type="date"
                                className="h-7 w-36 bg-amber-50 border-amber-500 text-neutral-900"
                                value={u.date ?? ""}
                                onChange={(e) => setU({ date: e.target.value || null })}
                                data-testid={`preview-date-${l.key}`}
                              />
                            )}
                            {editing && !u && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title={l.hidden ? "Show this line" : "Leave this line off"} onClick={() => setO({ hidden: !l.hidden })} data-testid={`preview-hide-${l.key}`}>
                                {l.hidden ? <Undo2 className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                              </Button>
                            )}
                            {editing && !u && ovr[l.key] && (
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs shrink-0" onClick={() => { const n = { ...ovr }; delete n[l.key]; setOvr(n); }} data-testid={`preview-undo-${l.key}`}>
                                Use report
                              </Button>
                            )}
                            {editing && u && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" title="Remove line" onClick={() => setUserLines(userLines.filter((x) => x.id !== u.id))} data-testid={`preview-remove-${l.key}`}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            )}
                            {!editing && l.edited && <span className="text-[10px] text-amber-700 border border-amber-400 rounded px-1">edited</span>}
                          </div>
                          {editing && u ? (
                            <Input
                              className="h-7 mt-1 bg-amber-50 border-amber-500 text-neutral-900 text-xs"
                              value={u.note ?? ""}
                              placeholder="Note (optional), e.g. 11/2 – 2 loads to disposal"
                              onChange={(e) => setU({ note: e.target.value || null })}
                              data-testid={`preview-note-${l.key}`}
                            />
                          ) : (
                            sub
                          )}
                        </td>
                        <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400 px-1 py-1 text-center">
                          {editing ? numIn(u ? u.quantity : o.quantity ?? l.quantity, (n) => (u ? setU({ quantity: n }) : setO({ quantity: n })), `preview-qty-${l.key}`) : <span className="font-[cursive] text-indigo-900">{l.quantity}</span>}
                        </td>
                        <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400 px-1 py-1 text-center">
                          {editing ? numIn(u ? u.unit_cost : o.unit_cost ?? l.unit_cost, (n) => (u ? setU({ unit_cost: n }) : setO({ unit_cost: n })), `preview-unit-${l.key}`) : <span className="font-[cursive] text-indigo-900">{money0(l.unit_cost)}</span>}
                        </td>
                        <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400 px-2 py-1 text-right font-[cursive] text-indigo-900">{money0(l.total)}</td>
                      </tr>
                    );
                  })}
                  {editing && (
                    <tr>
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-b border-neutral-900 border-b-neutral-400 px-2 py-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-dashed border-[#0d5c3f] text-[#0d5c3f]"
                          onClick={() =>
                            setUserLines([
                              ...userLines,
                              { id: Math.random().toString(36).slice(2, 10), description: "", quantity: 1, unit_cost: 0, date: p!.days.filter((d) => d.on_ticket == null).pop()?.date ?? p!.header.date, note: null },
                            ])
                          }
                          data-testid="button-preview-add-line"
                        >
                          <Plus className="mr-1 h-4 w-4" /> Add line (trucking, rig-up material…)
                        </Button>
                      </td>
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-neutral-900" />
                      <td className="border-x-2 border-neutral-900" />
                    </tr>
                  )}
                  {Array.from({ length: Math.max(2, 7 - view.lines.length) }).map((_, i) => (
                    <tr key={`blank-${i}`}>
                      {[0, 1, 2, 3, 4].map((c) => (
                        <td key={c} className="border-x-2 border-b border-neutral-900 border-b-neutral-400 h-6" />
                      ))}
                    </tr>
                  ))}
                  <tr>
                    {[0, 1, 2, 3, 4].map((c) => (
                      <td key={c} className="border-x-2 border-b-2 border-neutral-900 h-1" />
                    ))}
                  </tr>
                </tbody>
              </table>
              <div className="text-right text-lg font-bold mt-2" data-testid="preview-total">
                TOTAL <span className="inline-block min-w-[120px] border-b-2 border-neutral-900 px-2 font-[cursive] text-indigo-900">{money0(view.total)}</span>
              </div>
              <div className="mt-2 text-xs flex items-end gap-2 border-b border-neutral-900 pb-0.5">
                Comments:
                {editing && hdr ? (
                  <Input className="h-7 bg-amber-50 border-amber-500 text-neutral-900" value={hdr.comments} onChange={(e) => setHdr({ ...hdr, comments: e.target.value })} data-testid="preview-header-comments" />
                ) : (
                  <span className="font-[cursive] text-[14px] text-indigo-900">{view.header.comments}</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 mt-3 text-xs">
                {["Volume Rain Gauge", "Volume Recycled", "Volume Injection", "Volume Landfarmed", "Volume Treated", "Volume Dewatered"].map((v) => (
                  <div key={v} className="border-b border-neutral-900 h-5">{v}</div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-8 mt-8 text-xs text-center">
                <div className="border-t border-neutral-900 pt-1">Customer Signature</div>
                <div className="border-t border-neutral-900 pt-1">Service Technician</div>
              </div>
              {editing && (
                <p className="mt-3 text-[11px] text-neutral-500">
                  Address and City/State/Zip stay on the preview only; the field ticket record doesn't have those fields yet.
                </p>
              )}
            </div>

            {/* ------------------------------------------------ day by day */}
            <div className="bg-white dark:bg-neutral-950 shadow p-4 lg:w-[400px] shrink-0 text-sm self-start" data-testid="preview-days">
              <div className="font-semibold text-[#0d5c3f]">Day by day (from daily reports)</div>
              <div className="text-xs text-muted-foreground mb-2">
                {view.well_name || "—"}
                {view.last_ticketed_date ? ` · on tickets through ${mdy(view.last_ticketed_date)}` : ""}
              </div>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b-2 border-[#0d5c3f] text-left text-xs">
                    <th className="py-1">Day</th>
                    <th>Date</th>
                    <th className="text-right">Day cost</th>
                    <th className="text-right">Cumulative</th>
                    <th className="pl-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {view.days.map((d) => (
                    <tr key={d.report_id} className={`border-b border-neutral-200 dark:border-neutral-800 ${d.on_ticket != null ? "text-muted-foreground" : ""}`}>
                      <td className="py-1">{d.report_day ?? ""}</td>
                      <td>{md(d.date)}</td>
                      <td className="text-right tabular-nums">{money0(d.day_cost)}</td>
                      <td className="text-right tabular-nums">{money0(d.cumulative)}</td>
                      <td className="pl-2">
                        {d.on_ticket != null ? (
                          <span className="text-[11px]">Ticket #{d.on_ticket}</span>
                        ) : (
                          <span className={`text-[11px] rounded-full px-2 py-0.5 ${STATUS_PILL[d.status] ?? "bg-neutral-100 text-neutral-700"}`}>{d.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {openDays.length > 0 && (
                <div className="mt-3 rounded-md bg-emerald-50 dark:bg-emerald-950/30 p-2.5 text-xs leading-5">
                  <b>Open days:</b> {openDays.length} ({md(openDays[0].date)} – {md(openDays[openDays.length - 1].date)})
                  <br />
                  Report day costs: {money0(round2(openDays.reduce((s, d) => s + (d.day_cost ?? 0), 0)))} · Ticket: {money0(view.total)}
                  {lastCum != null && (
                    <>
                      <br />
                      Report running total on {md(openDays[openDays.length - 1].date)}: {money0(lastCum)}
                    </>
                  )}
                </div>
              )}
              {view.flags.length > 0 && (
                <div className="mt-2 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-300 p-2.5 text-xs leading-5" data-testid="preview-flags">
                  <div className="font-semibold flex items-center gap-1">
                    <AlertTriangle className="h-3.5 w-3.5" /> Needs attention
                  </div>
                  {view.flags.map((f, i) => (
                    <div key={i}>• {f}</div>
                  ))}
                </div>
              )}
              {!view.drafts_ready && canEdit && (
                <div className="mt-2 rounded-md border border-red-300 bg-red-50 p-2.5 text-xs">
                  Editing needs a one-time database update: run "Ticket preview setup.sql" in the Supabase SQL Editor.
                </div>
              )}
              {view.draft_saved_at && !editing && (
                <div className="mt-2 text-[11px] text-muted-foreground">
                  Edited by {view.draft_saved_by ?? "someone"} on {new Date(view.draft_saved_at).toLocaleString()}
                </div>
              )}
              {!canEdit && <div className="mt-2 text-[11px] text-muted-foreground">View only. An Admin or Area Manager can edit this preview.</div>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
