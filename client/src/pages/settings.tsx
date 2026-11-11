import { PhoneAlertsSection } from "@/components/PhoneAlerts";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ROLE_LABELS } from "@shared/schema";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { ChangePasswordForm } from "@/pages/change-password";

type DailyReportConfigResponse = {
  id: number;
  inbox_email: string | null;
  gmail_query: string;
  active: boolean;
  updated_at: string;
  email_out_ready: boolean;
  ingest_ready: boolean;
};

export default function Settings() {
  const { profile, prefs, refresh } = useAuth();
  const { toast } = useToast();
  const [onSigned, setOnSigned] = useState(true);
  const [onNeeds, setOnNeeds] = useState(true);
  const [onFiled, setOnFiled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefs) {
      setOnSigned(prefs.on_signed);
      setOnNeeds(prefs.on_needs_signoff);
      setOnFiled(prefs.on_filed);
    }
  }, [prefs]);

  async function save() {
    setBusy(true);
    try {
      await apiRequest("PUT", "/api/notification-prefs", {
        on_signed: onSigned,
        on_needs_signoff: onNeeds,
        on_filed: onFiled,
      });
      await refresh();
      toast({ title: "Preferences saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const Row = ({ label, desc, val, set }: any) => (
    <div className="flex items-start justify-between gap-4 py-3.5 border-b border-card-border last:border-0">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{desc}</div>
      </div>
      <Switch checked={val} onCheckedChange={set} />
    </div>
  );

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-xl font-semibold mb-1">Settings</h1>
      <p className="text-sm text-muted-foreground mb-6">
        {profile?.email} · {ROLE_LABELS[profile!.role]}
      </p>

      <div className="rounded-lg border border-card-border bg-card p-4">
        <h2 className="text-sm font-semibold mb-1">Email notifications</h2>
        <p className="text-xs text-muted-foreground mb-2">
          Choose which emails Drilling Fluid Solutions sends to {profile?.email}.
        </p>
        <Row label="My report was signed off" desc="Emailed when an area manager signs off a report you filed."
          val={onSigned} set={setOnSigned} />
        <Row label="A report needs my sign-off" desc="For area managers — emailed when a report in your area is filed."
          val={onNeeds} set={setOnNeeds} />
        <Row label="A report was filed in my area" desc="Optional heads-up whenever any report is filed in your area."
          val={onFiled} set={setOnFiled} />
        <div className="pt-4">
          <Button onClick={save} disabled={busy} data-testid="button-save-prefs">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save preferences
          </Button>
        </div>
      </div>

      {profile?.role !== "field" && <TaskAlerts />}

      <div className="rounded-lg border border-card-border bg-card p-4 mt-6">
        <h2 className="text-sm font-semibold mb-1">Password</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Change the password you use to sign in to DFS Ops.
        </p>
        <div className="max-w-sm">
          <ChangePasswordForm />
        </div>
      </div>

      {profile?.role === "admin" && <DailyReportSource />}
    </div>
  );
}

function DailyReportSource() {
  const { toast } = useToast();
  const { data: config, isLoading } = useQuery<DailyReportConfigResponse>({
    queryKey: ["/api/daily-reports-config"],
  });
  const [inbox, setInbox] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (config) {
      setInbox(config.inbox_email || "");
      setQuery(config.gmail_query || "");
      setActive(config.active);
    }
  }, [config]);

  async function save() {
    setBusy(true);
    try {
      await apiRequest("PUT", "/api/daily-reports-config", {
        inbox_email: inbox.trim(),
        gmail_query: query.trim(),
        active,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/daily-reports-config"] });
      toast({ title: "Daily report source saved" });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-lg border border-card-border bg-card p-4">
      <h2 className="text-sm font-semibold mb-1">Daily report source</h2>
      <p className="text-xs text-muted-foreground mb-4">
        The daily email check reads this inbox each morning, analyzes matching messages, and
        files them under Daily Reports for review.
      </p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-2">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Inbox email</label>
            <Input
              value={inbox}
              onChange={(e) => setInbox(e.target.value)}
              placeholder="dailyreports@yourcompany.com"
              data-testid="input-inbox-email"
            />
            <p className="text-xs text-muted-foreground mt-1">
              The mailbox daily reports are sent to.
            </p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Gmail search query</label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="subject:(daily report)"
              data-testid="input-gmail-query"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Standard Gmail search syntax, e.g. <code>subject:(daily report)</code> or{" "}
              <code>from:field@company.com</code>.
            </p>
          </div>
          <div className="flex items-start justify-between gap-4 py-1">
            <div>
              <div className="text-sm font-medium">Automatic import active</div>
              <div className="text-xs text-muted-foreground">Pause to stop the daily check without losing settings.</div>
            </div>
            <Switch checked={active} onCheckedChange={setActive} data-testid="switch-import-active" />
          </div>

          {config && (
            <div className="rounded-md border border-card-border bg-muted/30 p-3 space-y-1.5 text-xs">
              <StatusLine ok={config.ingest_ready} okText="Import endpoint connected" offText="Import endpoint not yet connected (set at deploy)" />
              <StatusLine ok={config.email_out_ready} okText="Outbound email connected" offText="Outbound email not connected — change requests queue until Resend is set up" />
            </div>
          )}

          <Button onClick={save} disabled={busy} data-testid="button-save-source">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save source
          </Button>
        </div>
      )}
    </div>
  );
}

type PushKind = { key: string; label: string; desc: string; on: boolean };

// One on/off switch per kind of phone alert. Saves as soon as it's flipped.
function PhoneAlertChoices() {
  const { toast } = useToast();
  const { data } = useQuery<{ ready: boolean; kinds: PushKind[] }>({ queryKey: ["/api/alert-prefs/push"] });
  const [vals, setVals] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (data) setVals(Object.fromEntries(data.kinds.map((k) => [k.key, k.on])));
  }, [data]);
  async function flip(key: string, on: boolean) {
    setVals((v) => ({ ...v, [key]: on }));
    try {
      await apiRequest("PUT", "/api/alert-prefs/push", { key, on });
      queryClient.invalidateQueries({ queryKey: ["/api/alert-prefs/push"] });
    } catch (e: any) {
      setVals((v) => ({ ...v, [key]: !on }));
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" });
    }
  }
  if (!data?.kinds?.length) return null;
  return (
    <div className="mt-2" data-testid="list-push-kinds">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground pt-3">Send to my phone</div>
      {data.kinds.map((k, i) => (
        <div
          key={k.key}
          className={`flex items-start justify-between gap-4 py-3 ${i < data.kinds.length - 1 ? "border-b border-card-border" : ""}`}
        >
          <label htmlFor={`push-${k.key}`} className="min-w-0 cursor-pointer">
            <div className="text-sm font-medium">{k.label}</div>
            <div className="text-xs text-muted-foreground">{k.desc}</div>
          </label>
          <Switch
            id={`push-${k.key}`}
            checked={!!vals[k.key]}
            onCheckedChange={(on) => flip(k.key, on)}
            className="shrink-0 mt-0.5"
            data-testid={`switch-push-${k.key}`}
          />
        </div>
      ))}
    </div>
  );
}

function TaskAlerts() {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4 mt-6" data-testid="card-task-alerts">
      <h2 className="text-sm font-semibold mb-1">Task alerts</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Pick what DFS Ops sends to your phone. Everything still shows in the bell either way.
      </p>
      <PhoneAlertsSection />
      <PhoneAlertChoices />
    </div>
  );
}

function StatusLine({ ok, okText, offText }: { ok: boolean; okText: string; offText: string }) {
  return (
    <div className={`flex items-center gap-1.5 ${ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
      {ok ? okText : offText}
    </div>
  );
}
