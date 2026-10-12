import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { type DailyFieldKpis } from "@shared/schema";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TrendingUp } from "lucide-react";

// The trend charts KPI values over time. KPIs come only from emailed Excel
// daily reports, so each point just needs a date, a label number, and kpis.
export interface KpiTrendPoint {
  report_date: string;
  report_number: number | null;
  kpis: DailyFieldKpis | null | undefined;
}

// Numeric KPIs only (mud_type is text and can't be charted), grouped to match
// the daily-report KPI layout. Keys starting with "cent:" are per-centrifuge:
// the chart draws one line for each centrifuge column (1-4) that has data.
const KPI_OPTIONS: { group: string; fields: { key: string; label: string }[] }[] = [
  {
    group: "Centrifuge KPIs (one line per centrifuge)",
    fields: [
      { key: "cent:daily_run_hours", label: "Daily run hours" },
      { key: "cent:total_run_hours", label: "Total run hours" },
      { key: "cent:centrifuge_feed_rate_gpm", label: "Feed rate (gpm)" },
      { key: "cent:centrifuge_feed_pump_speed_rpm", label: "Feed pump speed (rpm)" },
      { key: "cent:centrifuge_bowl_speed_rpm", label: "Bowl speed (rpm)" },
      { key: "cent:centrifuge_backdrive_rpm", label: "Backdrive (rpm)" },
      { key: "cent:centrifuge_feed_weight_ppg", label: "Feed weight (ppg)" },
      { key: "cent:centrifuge_effluent_weight_ppg", label: "Effluent weight (ppg)" },
    ],
  },
  {
    group: "Mud properties",
    fields: [
      { key: "mud_weight_ppg", label: "Mud weight (ppg)" },
      { key: "lgs_pct", label: "LGS (%)" },
      { key: "retort_roc_pct", label: "Retort R.O.C (%)" },
    ],
  },
  {
    group: "Fluid recovery",
    fields: [
      { key: "daily_fluid_recovery_bbl", label: "Daily fluid recovery (bbl)" },
      { key: "total_fluid_recovery_bbl", label: "Total fluid recovery (bbl)" },
      { key: "maintenance_hours", label: "Maintenance hours" },
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

const LABELS: Record<string, string> = Object.fromEntries(
  KPI_OPTIONS.flatMap((g) => g.fields.map((f) => [f.key, f.label])),
);

const SLOTS = [1, 2, 3, 4] as const;
// One color per centrifuge column (brand green first).
const SLOT_COLORS: Record<number, string> = { 1: "#01563E", 2: "#A84B2F", 3: "#006494", 4: "#D19900" };

const isNum = (v: unknown) => v !== null && v !== undefined && v !== "" && !isNaN(Number(v));

// Value of a metric for one centrifuge column. Run hours for Centrifuge 1
// fall back to the combined field on older reports.
function slotRaw(k: Record<string, unknown>, base: string, slot: number): unknown {
  if (slot === 1) {
    if (base === "daily_run_hours" || base === "total_run_hours") {
      const v = k[`${base}_cent1`];
      return isNum(v) ? v : k[base];
    }
    return k[base];
  }
  return k[`${base}_cent${slot}`];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Format a yyyy-mm-dd date string without going through Date(), which would
// parse it as UTC midnight and shift the label a day earlier in local time.
function shortDate(d: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}

export function JobKpiTrend({ reports }: { reports: KpiTrendPoint[] }) {
  const [metric, setMetric] = useState<string>("cent:daily_run_hours");
  const perCent = metric.startsWith("cent:");
  const base = perCent ? metric.slice(5) : metric;

  // Which options have at least one numeric value across the reports — used
  // to disable options that would render an empty chart.
  const populated = useMemo(() => {
    const set = new Set<string>();
    for (const r of reports) {
      const k = (r.kpis || {}) as Record<string, unknown>;
      for (const g of KPI_OPTIONS)
        for (const f of g.fields) {
          if (set.has(f.key)) continue;
          if (f.key.startsWith("cent:")) {
            const b = f.key.slice(5);
            if (SLOTS.some((n) => isNum(slotRaw(k, b, n)))) set.add(f.key);
          } else if (isNum(k[f.key])) set.add(f.key);
        }
    }
    return set;
  }, [reports]);

  // Rows oldest → newest. Per-centrifuge metrics carry c1..c4; others "value".
  const { data, slots } = useMemo(() => {
    const used = new Set<number>();
    const rows = [...reports]
      .sort((a, b) => a.report_date.localeCompare(b.report_date))
      .map((r) => {
        const k = (r.kpis || {}) as Record<string, unknown>;
        const row: Record<string, any> = {
          date: shortDate(r.report_date),
          fullDate: r.report_date,
          report: r.report_number ?? "",
        };
        let any = false;
        if (perCent) {
          for (const n of SLOTS) {
            const v = slotRaw(k, base, n);
            if (isNum(v)) {
              row[`c${n}`] = Number(v);
              used.add(n);
              any = true;
            }
          }
        } else if (isNum(k[base])) {
          row.value = Number(k[base]);
          any = true;
        }
        return any ? row : null;
      })
      .filter((r): r is Record<string, any> => !!r);
    return { data: rows, slots: SLOTS.filter((n) => used.has(n)) };
  }, [reports, perCent, base]);

  const label = LABELS[metric] ?? metric;
  const series = perCent
    ? slots.map((n) => ({ key: `c${n}`, name: `Centrifuge ${n}`, color: SLOT_COLORS[n] }))
    : [{ key: "value", name: label, color: "#01563E" }];
  const single = data.length === 1 ? data[0] : null;

  return (
    <div className="rounded-lg border border-card-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-medium inline-flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          KPI trend
        </h3>
        <Select value={metric} onValueChange={setMetric}>
          <SelectTrigger className="h-8 w-[240px] text-xs" data-testid="select-kpi-metric">
            <SelectValue placeholder="Select KPI" />
          </SelectTrigger>
          <SelectContent>
            {KPI_OPTIONS.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel className="text-xs">{g.group}</SelectLabel>
                {g.fields.map((f) => (
                  <SelectItem
                    key={f.key}
                    value={f.key}
                    disabled={!populated.has(f.key)}
                    className="text-xs"
                  >
                    {f.label}
                    {!populated.has(f.key) ? " — no data" : ""}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {data.length === 0 ? (
        <div className="h-[180px] flex items-center justify-center text-center text-xs text-muted-foreground">
          No values logged for {label} yet. Enter this KPI on daily reports to
          see its trend.
        </div>
      ) : single ? (
        <div className="h-[180px] flex flex-col items-center justify-center text-center gap-1">
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-1">
            {series.map((s) => (
              <div key={s.key}>
                <div className="text-2xl font-semibold tabular-nums">
                  {single[s.key] != null ? Number(single[s.key]).toLocaleString() : "—"}
                </div>
                {perCent && <div className="text-xs text-muted-foreground">{s.name}</div>}
              </div>
            ))}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {label} · {single.fullDate} (one report — need 2+ for a trend line)
          </div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={perCent && series.length > 1 ? 224 : 200}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="hsl(var(--border))"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={{ stroke: "hsl(var(--border))" }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              tickLine={false}
              axisLine={false}
              width={44}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
                color: "hsl(var(--popover-foreground))",
              }}
              labelFormatter={(_l, payload) => {
                const p = payload?.[0]?.payload as any;
                return p ? `${p.fullDate} · Report #${p.report}` : "";
              }}
              formatter={(v: any, name: any) => [Number(v).toLocaleString(), perCent ? `${name} · ${label}` : label]}
            />
            {perCent && series.length > 1 && (
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
            )}
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2}
                dot={{ r: 3, fill: s.color }}
                activeDot={{ r: 5 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
