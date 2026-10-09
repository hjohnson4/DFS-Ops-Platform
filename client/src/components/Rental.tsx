import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { RentalDetail, RentalSummary } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Plus, Trash2 } from "lucide-react";

// ---- Visual identifier ------------------------------------------------------
// Orange "RENTAL" pill shown next to the asset number wherever a rented unit
// appears. `withVendor` adds the rental company's name.
type RentalLike = { is_rental?: boolean | null; rental_vendor?: string | null } | null | undefined;

export function isRental(a: RentalLike): boolean {
  return !!a?.is_rental;
}

export function RentalBadge({ asset, withVendor = false, className = "" }: { asset: RentalLike; withVendor?: boolean; className?: string }) {
  if (!isRental(asset)) return null;
  const vendor = asset?.rental_vendor?.trim();
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-orange-400 bg-orange-100 px-1.5 py-px text-[10px] font-bold uppercase leading-4 tracking-wide text-orange-800 dark:border-orange-500/60 dark:bg-orange-500/15 dark:text-orange-300 ${className}`}
      title={vendor ? `Rental from ${vendor}` : "Rental unit"}
      data-testid="badge-rental"
    >
      Rental
      {withVendor && vendor && <span className="font-medium normal-case tracking-normal">· {vendor}</span>}
    </span>
  );
}

// Asset number with the rental badge after it.
export function AssetTag({
  asset,
  withVendor = false,
  className = "font-medium",
}: {
  asset: ({ tag: string } & NonNullable<RentalLike>) | null | undefined;
  withVendor?: boolean;
  className?: string;
}) {
  if (!asset) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={className}>{asset.tag}</span>
      <RentalBadge asset={asset} withVendor={withVendor} />
    </span>
  );
}

// ---- Money helpers ----------------------------------------------------------
export const money = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmtDay = (d: string | null | undefined) => {
  if (!d) return "—";
  const [y, m, dd] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const todayCentral = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ---- Form fields (create + edit asset) ---------------------------------------
export type RentalForm = {
  is_rental: boolean;
  vendor: string;
  ref: string;
  monthly: string;
  start: string;
  end: string;
  notes: string;
};

export function rentalFormFrom(a?: any): RentalForm {
  return {
    is_rental: !!a?.is_rental,
    vendor: a?.rental_vendor ?? "",
    ref: a?.rental_ref ?? "",
    monthly: a?.rental_monthly_rate != null ? String(a.rental_monthly_rate) : "",
    start: a?.rental_start ?? "",
    end: a?.rental_end ?? "",
    notes: a?.rental_notes ?? "",
  };
}

// Body fields for POST/PATCH /api/assets. Throws a readable error if invalid.
export function rentalPayload(f: RentalForm, wasRental: boolean): Record<string, any> {
  if (!f.is_rental) return wasRental ? { is_rental: false } : {};
  if (!f.vendor.trim()) throw new Error("Enter the rental company");
  const m = f.monthly.trim();
  if (m && (isNaN(Number(m)) || Number(m) < 0)) throw new Error("Monthly rental rate must be a non-negative number");
  if (!f.start) throw new Error("Enter the date the rental was received");
  if (f.end && f.end < f.start) throw new Error("The return date must be on or after the date received");
  return {
    is_rental: true,
    rental_vendor: f.vendor.trim(),
    rental_ref: f.ref.trim() || null,
    rental_monthly_rate: m === "" ? null : Number(m),
    rental_start: f.start,
    rental_end: f.end || null,
    rental_notes: f.notes.trim() || null,
  };
}

export function RentalFields({ value, onChange, onJob }: { value: RentalForm; onChange: (v: RentalForm) => void; onJob?: boolean }) {
  const set = (k: keyof RentalForm, v: any) => onChange({ ...value, [k]: v });
  const returning = !!value.end && value.end <= todayCentral();
  return (
    <div className="rounded-md border border-orange-300 bg-orange-50/60 p-3 dark:border-orange-500/40 dark:bg-orange-500/5" data-testid="rental-fields">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox checked={value.is_rental} onCheckedChange={(v) => set("is_rental", !!v)} data-testid="check-is-rental" />
        Rented from a third party
        <RentalBadge asset={{ is_rental: true }} />
      </label>
      {value.is_rental && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="rental-vendor">Rental company</Label>
            <Input id="rental-vendor" value={value.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="Who we rent it from" data-testid="input-rental-vendor" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="rental-ref">Their serial / ref # (optional)</Label>
            <Input id="rental-ref" value={value.ref} onChange={(e) => set("ref", e.target.value)} data-testid="input-rental-ref" />
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="rental-monthly">What we pay per month</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                id="rental-monthly"
                type="number"
                min="0"
                step="1"
                className="pl-6"
                value={value.monthly}
                onChange={(e) => set("monthly", e.target.value)}
                placeholder="e.g. 18000"
                data-testid="input-rental-monthly"
              />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Prorated by day for partial months.</p>
          </div>
          <div className="col-span-2 sm:col-span-1" />
          <div>
            <Label htmlFor="rental-start">Received (on rent)</Label>
            <Input id="rental-start" type="date" value={value.start} onChange={(e) => set("start", e.target.value)} data-testid="input-rental-start" />
          </div>
          <div>
            <Label htmlFor="rental-end">Returned (off rent)</Label>
            <Input id="rental-end" type="date" value={value.end} onChange={(e) => set("end", e.target.value)} data-testid="input-rental-end" />
            <p className="mt-1 text-xs text-muted-foreground">Leave empty while we still have it.</p>
          </div>
          {returning && (
            <p className="col-span-2 rounded border border-orange-300 bg-orange-100 px-2 py-1.5 text-xs text-orange-900 dark:bg-orange-500/10 dark:text-orange-200" data-testid="text-rental-returning">
              Saving with this return date stops the rental cost{onJob ? ", releases the unit from its job" : ""} and marks it Returned.
            </p>
          )}
          <div className="col-span-2">
            <Label htmlFor="rental-notes">Rental notes (optional)</Label>
            <Textarea id="rental-notes" rows={2} value={value.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Contract #, terms, contact…" data-testid="input-rental-notes" />
          </div>
          <p className="col-span-2 text-xs text-muted-foreground">
            The asset's own day rate is what we charge. Earnings = that day rate × each day the unit is on a job. Only Admins and Area Managers see costs and profit.
          </p>
        </div>
      )}
    </div>
  );
}

// ---- Rental box on the asset ---------------------------------------------------
function Stat({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

export const profitTone = (n: number) => (n < 0 ? "text-rose-700 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400");

export function RentalPanel({ asset, canEdit }: { asset: any; canEdit: boolean }) {
  const { toast } = useToast();
  const url = `/api/assets/${asset.id}/rental`;
  const { data, isLoading, error } = useQuery<RentalDetail>({ queryKey: [url] });
  const [adding, setAdding] = useState(false);
  const [cDate, setCDate] = useState(todayCentral());
  const [cDesc, setCDesc] = useState("");
  const [cAmt, setCAmt] = useState("");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: [url] });
    queryClient.invalidateQueries({ queryKey: ["/api/rentals"] });
  };
  const add = useMutation({
    mutationFn: async () => {
      if (!cDesc.trim()) throw new Error("Describe the charge");
      if (cAmt.trim() === "" || isNaN(Number(cAmt)) || Number(cAmt) < 0) throw new Error("Enter an amount");
      await apiRequest("POST", `/api/assets/${asset.id}/rental-charges`, { charge_date: cDate, description: cDesc.trim(), amount: Number(cAmt) });
    },
    onSuccess: () => {
      refresh();
      setAdding(false);
      setCDesc("");
      setCAmt("");
      toast({ title: "Charge added" });
    },
    onError: (e: any) => toast({ title: "Could not add the charge", description: e.message, variant: "destructive" }),
  });
  const del = useMutation({
    mutationFn: async (id: string) => apiRequest("DELETE", `/api/rental-charges/${id}`),
    onSuccess: () => {
      refresh();
      toast({ title: "Charge removed" });
    },
    onError: (e: any) => toast({ title: "Could not remove the charge", description: e.message, variant: "destructive" }),
  });

  const s: RentalSummary | undefined = data?.summary;
  return (
    <div className="rounded-lg border border-orange-300 bg-card p-4 text-sm dark:border-orange-500/40" data-testid="rental-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          Rental <RentalBadge asset={asset} withVendor />
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtDay(asset.rental_start)} → {asset.rental_end ? fmtDay(asset.rental_end) : "still on rent"}
          {asset.rental_ref ? ` · Ref ${asset.rental_ref}` : ""}
        </div>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 py-4 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="py-3 text-rose-700 dark:text-rose-400">{(error as any).message}</div>
      ) : s ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Spent to date" value={money(s.total_cost)} />
            <Stat label="Earned to date" value={money(s.earned)} />
            <Stat label={s.profit < 0 ? "Loss to date" : "Profit to date"} value={money(s.profit)} tone={profitTone(s.profit)} />
            <Stat label="Days working / on rent" value={`${s.days_on_job} / ${s.days_on_rent}`} />
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Rent {money(s.rent_cost)} at {s.monthly_rate == null ? "— (no monthly rate)" : `${money(s.monthly_rate)}/month`} + one-time charges {money(s.one_time_charges)}
            {s.through ? ` · through ${fmtDay(s.through)}` : ""}
            {s.days_missing_rate > 0 && (
              <span className="text-amber-700 dark:text-amber-400"> · {s.days_missing_rate} working day(s) had no day rate saved and earned $0</span>
            )}
          </div>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">One-time charges</div>
              {canEdit && !adding && (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setAdding(true)} data-testid="button-add-rental-charge">
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add charge
                </Button>
              )}
            </div>
            {adding && (
              <div className="mb-2 grid grid-cols-[8.5rem_1fr_7rem_auto] items-end gap-2">
                <Input type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} data-testid="input-charge-date" />
                <Input value={cDesc} onChange={(e) => setCDesc(e.target.value)} placeholder="Delivery, pickup…" data-testid="input-charge-desc" />
                <Input type="number" min="0" value={cAmt} onChange={(e) => setCAmt(e.target.value)} placeholder="$" data-testid="input-charge-amount" />
                <div className="flex gap-1">
                  <Button size="sm" onClick={() => add.mutate()} disabled={add.isPending} data-testid="button-save-charge">
                    {add.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Add
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {data!.charges.length === 0 ? (
              <div className="text-xs text-muted-foreground">None</div>
            ) : (
              <ul className="divide-y divide-card-border rounded-md border border-card-border">
                {data!.charges.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-3 py-1.5" data-testid={`row-rental-charge-${c.id}`}>
                    <span className="w-24 text-xs text-muted-foreground">{fmtDay(c.charge_date)}</span>
                    <span className="flex-1">{c.description}</span>
                    <span className="tabular-nums">{money(Number(c.amount))}</span>
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-1.5 text-rose-600"
                        onClick={() => confirm(`Remove "${c.description}"?`) && del.mutate(c.id)}
                        aria-label="Remove charge"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Jobs while on rent</div>
            {data!.jobs.length === 0 ? (
              <div className="text-xs text-muted-foreground">Not on a job yet. Job days are recorded from the day this update went live.</div>
            ) : (
              <ul className="space-y-1 text-xs">
                {data!.jobs.map((j, i) => (
                  <li key={i} className="flex flex-wrap gap-x-3">
                    <span className="font-medium">{j.job_number ?? "—"}</span>
                    <span className="text-muted-foreground">
                      {fmtDay(j.start_date)} → {j.end_date ? fmtDay(j.end_date) : "now"}
                    </span>
                    <span className="text-muted-foreground">{j.day_rate == null ? "no day rate" : `${money(j.day_rate)}/day`}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- Rentals summary (assets page) ----------------------------------------------
type RentalRow = {
  id: string;
  tag: string;
  category: string;
  area: string;
  status: string;
  is_rental: boolean;
  rental_vendor: string | null;
  rental_start: string | null;
  rental_end: string | null;
  job: { id: string; job_number: string } | null;
  rental: RentalSummary;
};

export function RentalsSummary({ onOpen }: { onOpen?: (id: string) => void }) {
  const { data, isLoading, error } = useQuery<{ rentals: RentalRow[]; totals: { total_cost: number; earned: number; profit: number; on_rent: number; count: number } }>({
    queryKey: ["/api/rentals"],
  });
  const [showReturned, setShowReturned] = useState(false);
  if (isLoading || error || !data || data.rentals.length === 0) return null;
  const rows = data.rentals.filter((r) => showReturned || r.rental.on_rent);
  const t = data.totals;
  return (
    <div className="rounded-lg border border-orange-300 bg-card dark:border-orange-500/40" data-testid="rentals-summary">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 pb-3">
        <div>
          <div className="flex items-center gap-2 font-medium">
            Rental centrifuges <RentalBadge asset={{ is_rental: true }} />
          </div>
          <div className="text-xs text-muted-foreground">
            {t.on_rent} on rent now · cost = monthly rate prorated by day + one-time charges · earned = our day rate × days on a job
          </div>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <div className="text-xs text-muted-foreground">Spent</div>
            <div className="font-semibold tabular-nums">{money(t.total_cost)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Earned</div>
            <div className="font-semibold tabular-nums">{money(t.earned)}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">{t.profit < 0 ? "Loss" : "Profit"}</div>
            <div className={`font-semibold tabular-nums ${profitTone(t.profit)}`}>{money(t.profit)}</div>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto border-t border-card-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="text-left">
              <th className="px-3 py-2 font-medium">Asset</th>
              <th className="px-3 py-2 font-medium">Rental company</th>
              <th className="px-3 py-2 font-medium">On rent</th>
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 text-right font-medium">Days working / on rent</th>
              <th className="px-3 py-2 text-right font-medium">Spent</th>
              <th className="px-3 py-2 text-right font-medium">Earned</th>
              <th className="px-3 py-2 text-right font-medium">Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-t border-card-border ${onOpen ? "cursor-pointer hover:bg-muted/40" : ""}`}
                onClick={() => onOpen?.(r.id)}
                data-testid={`row-rental-${r.tag}`}
              >
                <td className="px-3 py-2">
                  <AssetTag asset={r} />
                  <div className="text-xs text-muted-foreground">{r.category} · {r.area}</div>
                </td>
                <td className="px-3 py-2">{r.rental_vendor || "—"}</td>
                <td className="px-3 py-2 whitespace-nowrap text-xs">
                  {fmtDay(r.rental_start)} → {r.rental_end ? fmtDay(r.rental_end) : "now"}
                </td>
                <td className="px-3 py-2 text-xs">{r.job?.job_number ?? (r.rental.on_rent ? "Idle" : "Returned")}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.rental.days_on_job} / {r.rental.days_on_rent}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{money(r.rental.total_cost)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(r.rental.earned)}</td>
                <td className={`px-3 py-2 text-right font-medium tabular-nums ${profitTone(r.rental.profit)}`}>{money(r.rental.profit)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-4 text-center text-muted-foreground">
                  No rentals on rent right now.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data.rentals.some((r) => !r.rental.on_rent) && (
        <label className="flex items-center gap-2 border-t border-card-border px-4 py-2 text-xs text-muted-foreground">
          <Checkbox checked={showReturned} onCheckedChange={(v) => setShowReturned(!!v)} data-testid="check-show-returned-rentals" />
          Show returned rentals (totals always include them)
        </label>
      )}
    </div>
  );
}
