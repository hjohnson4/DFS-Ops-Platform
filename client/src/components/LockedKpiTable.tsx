import { type DailyFieldKpis, type KpiCellRef } from "@shared/schema";
import { FileSpreadsheet, Lock } from "lucide-react";

// Grouped KPI layout (mirrors the daily-report workbook). mud_type is text;
// every other field is numeric. Values here are read straight from the emailed
// Excel "Report Day N" sheet and are locked (read-only) in the app.
const KPI_GROUPS: {
  group: string;
  // Shown as one column per centrifuge when more than one centrifuge has data.
  perCentrifuge?: boolean;
  fields: { key: keyof DailyFieldKpis; label: string; text?: boolean }[];
}[] = [
  {
    group: "Mud properties",
    fields: [
      { key: "mud_type", label: "Mud type", text: true },
      { key: "mud_weight_ppg", label: "Mud weight (ppg)" },
      { key: "lgs_pct", label: "LGS (%)" },
      { key: "retort_roc_pct", label: "Retort R.O.C (%)" },
    ],
  },
  {
    group: "Fluid recovery & run hours",
    fields: [
      { key: "daily_fluid_recovery_bbl", label: "Daily fluid recovery (bbl)" },
      { key: "total_fluid_recovery_bbl", label: "Total fluid recovery (bbl)" },
      { key: "daily_run_hours", label: "Daily run hours" },
      { key: "total_run_hours", label: "Total run hours" },
      { key: "maintenance_hours", label: "Maintenance hours" },
      { key: "volume_processed_bbl", label: "Volume processed — Cent 1 (bbl)" },
      { key: "volume_processed_cent2_bbl", label: "Volume processed — Cent 2 (bbl)" },
    ],
  },
  {
    group: "Centrifuge parameters",
    perCentrifuge: true,
    fields: [
      { key: "centrifuge_feed_rate_gpm", label: "Feed rate (gpm)" },
      { key: "centrifuge_feed_pump_speed_rpm", label: "Feed pump speed (rpm)" },
      { key: "centrifuge_bowl_speed_rpm", label: "Bowl speed (rpm)" },
      { key: "centrifuge_backdrive_rpm", label: "Backdrive (rpm)" },
      { key: "centrifuge_feed_weight_ppg", label: "Feed weight (ppg)" },
      { key: "centrifuge_effluent_weight_ppg", label: "Effluent weight (ppg)" },
    ],
  },
  {
    group: "Additions (bbl)",
    fields: [
      { key: "add_base_diesel_bbl", label: "Base / diesel" },
      { key: "add_water_bbl", label: "Water" },
      { key: "add_barite_bbl", label: "Barite" },
      { key: "add_chemicals_bbl", label: "Chemicals" },
    ],
  },
  {
    group: "Waste disposal",
    fields: [
      { key: "end_dumps_loaded", label: "End dumps loaded" },
      { key: "cuttings_volume_bbl", label: "Cuttings volume (bbl)" },
      { key: "vac_trucks", label: "Vac trucks" },
      { key: "liquids_to_disposal_bbl", label: "Liquids to disposal (bbl)" },
    ],
  },
];

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") {
    // Trim trailing zeros but keep up to 3 decimals for values like 0.061.
    return Number(v).toLocaleString("en-US", { maximumFractionDigits: 3 });
  }
  return String(v);
}

// Key for a parameter on a given centrifuge: Centrifuge 1 uses the plain
// field, Centrifuge 2-4 use the _cent2/_cent3/_cent4 suffix.
const centKey = (key: string, slot: number) => (slot === 1 ? key : `${key}_cent${slot}`);
const hasVal = (v: unknown) => v !== null && v !== undefined && v !== "";

export default function LockedKpiTable({
  kpis,
  cellMap,
  sourceSheet,
  attachmentName,
  slotTags,
}: {
  kpis: DailyFieldKpis | null | undefined;
  cellMap?: Record<string, KpiCellRef> | null;
  sourceSheet?: string | null;
  attachmentName?: string | null;
  // Optional asset tag per centrifuge slot (from the job's slot mapping).
  slotTags?: Record<number, string[]>;
}) {
  const k = kpis || {};
  const map = cellMap || {};
  const kv = k as Record<string, unknown>;

  // Which centrifuges have parameter data on this report. Centrifuge 1 is
  // always included; 2-4 only when at least one of their cells has a value.
  const centGroup = KPI_GROUPS.find((g) => g.perCentrifuge);
  const centSlots = [1, 2, 3, 4].filter(
    (slot) =>
      slot === 1 ||
      (centGroup?.fields ?? []).some((f) => hasVal(kv[centKey(f.key as string, slot)])),
  );

  return (
    <div className="rounded-lg border border-card-border bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-card-border px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <FileSpreadsheet className="h-4 w-4 text-primary" />
          Daily report KPIs
        </div>
        <div
          className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
          data-testid="badge-excel-source"
          title={
            attachmentName
              ? `Read from ${attachmentName}${sourceSheet ? ` · ${sourceSheet}` : ""}`
              : "Read directly from the emailed Excel workbook"
          }
        >
          <Lock className="h-3 w-3" />
          Source: Excel attachment
          {sourceSheet ? ` · ${sourceSheet}` : ""}
        </div>
      </div>

      <div className="divide-y divide-card-border">
        {KPI_GROUPS.map((g) => (
          <div key={g.group} className="px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              {g.group}
            </div>
            {g.perCentrifuge && centSlots.length > 1 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="kpi-centrifuge-params">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 pr-3 text-left font-normal">Parameter</th>
                      {centSlots.map((slot) => (
                        <th
                          key={slot}
                          className="py-1 pl-3 text-right font-medium text-foreground whitespace-nowrap"
                          data-testid={`kpi-cent-col-${slot}`}
                        >
                          Centrifuge {slot}
                          {slotTags?.[slot]?.length ? (
                            <div className="text-[11px] font-normal text-muted-foreground">
                              {slotTags[slot].join(", ")}
                            </div>
                          ) : null}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border">
                    {g.fields.map((f) => (
                      <tr key={f.key as string} data-testid={`kpi-row-${f.key}`}>
                        <td className="py-1.5 pr-3 text-muted-foreground">{f.label}</td>
                        {centSlots.map((slot) => {
                          const key = centKey(f.key as string, slot);
                          const ref = map[key];
                          return (
                            <td
                              key={slot}
                              className="py-1.5 pl-3 text-right font-medium tabular-nums whitespace-nowrap"
                              title={ref?.cell ? `Cell ${ref.sheet ? `${ref.sheet}!` : ""}${ref.cell}` : undefined}
                              data-testid={`kpi-cell-${key}`}
                            >
                              {fmt(kv[key])}
                              {ref?.cell && (
                                <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                                  {ref.cell}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {g.fields.map((f) => {
                const ref = map[f.key as string];
                return (
                  <div
                    key={f.key as string}
                    className="flex items-baseline justify-between gap-3 text-sm"
                    data-testid={`kpi-row-${f.key}`}
                  >
                    <dt className="text-muted-foreground">{f.label}</dt>
                    <dd className="flex items-baseline gap-2 font-medium tabular-nums">
                      <span>{fmt((k as any)[f.key])}</span>
                      {ref?.cell && (
                        <span
                          className="rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground"
                          title={`Cell ${ref.sheet ? `${ref.sheet}!` : ""}${ref.cell}`}
                        >
                          {ref.cell}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-card-border px-4 py-2 text-xs text-muted-foreground">
        These values are read directly from the emailed workbook and are locked
        in the app. Re-importing the report overwrites them. A dash (—) means the
        cell was blank in the source sheet.
      </div>
    </div>
  );
}
