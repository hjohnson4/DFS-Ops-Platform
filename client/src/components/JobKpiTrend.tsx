import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
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
// the daily-report form layout.
const KPI_OPTIONS: { group: string; fields: { key: keyof DailyFieldKpis; label: string }[] }[] = [
  {
    group: "Mud properties",
    fields: [
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
  KPI_OPTIONS.flatMap((g) => g.fields.map((f) => [f.key as string, f.label])),
);

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
  const [metric, setMetric] = useState<keyof DailyFieldKpis>("daily_run_hours");

  // Which KPIs actually have at least one numeric value across the reports —
  // used to disable options that would render an empty chart.
  const populated = useMemo(() => {
    const set = new Set<string>();
    for (const r of reports) {
      const k = (r.kpis || {}) as DailyFieldKpis;
      for (const key of Object.keys(k)) {
        const v = (k as any)[key];
        if (key !== "mud_type" && v !== null && v !== undefined && v !== "" && !isNaN(Number(v)))
          set.add(key);
      }
    }
    return set;
  }, [reports]);

  // Build the series for the selected metric: oldest → newest, values present only.
  const data = useMemo(() => {
    return [...reports]
      .filter((r) => {
        const v = (r.kpis as any)?.[metric];
        return v !== null && v !== undefined && v !== "" && !isNaN(Number(v));
      })
      .sort((a, b) => a.report_date.localeCompare(b.report_date))
      .map((r) => ({
        date: shortDate(r.report_date),
        fullDate: r.report_date,
        report: r.report_number ?? "",
        value: Number((r.kpis as any)[metric]),
      }));
  }, [reports, metric]);

  const label = LABELS[metric as string] ?? String(metric);

  return (
    <div className="rounded-lg border border-card-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-medium inline-flex items-center gap-1.5">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          KPI trend
        </h3>
        <Select value={metric as string} onValueChange={(v) => setMetric(v as keyof DailyFieldKpis)}>
          <SelectTrigger className="h-8 w-[240px] text-xs" data-testid="select-kpi-metric">
            <SelectValue placeholder="Select KPI" />
          </SelectTrigger>
          <SelectContent>
            {KPI_OPTIONS.map((g) => (
              <SelectGroup key={g.group}>
                <SelectLabel className="text-xs">{g.group}</SelectLabel>
                {g.fields.map((f) => (
                  <SelectItem
                    key={f.key as string}
                    value={f.key as string}
                    disabled={!populated.has(f.key as string)}
                    className="text-xs"
                  >
                    {f.label}
                    {!populated.has(f.key as string) ? " — no data" : ""}
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
      ) : data.length === 1 ? (
        <div className="h-[180px] flex flex-col items-center justify-center text-center">
          <div className="text-2xl font-semibold tabular-nums">
            {data[0].value.toLocaleString()}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {label} · {data[0].fullDate} (one report — need 2+ for a trend line)
          </div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
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
              formatter={(v: any) => [Number(v).toLocaleString(), label]}
            />
            <Line
              type="monotone"
              dataKey="value"
              name={label}
              stroke="#01563E"
              strokeWidth={2}
              dot={{ r: 3, fill: "#01563E" }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
