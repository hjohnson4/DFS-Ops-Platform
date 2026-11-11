import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { BellRing, BellOff, Loader2, Smartphone, Share, X } from "lucide-react";
import { pushState, enablePush, disablePush, isIos, type PushState } from "@/lib/push";

function usePushState() {
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    pushState().then(setState).catch(() => setState("unsupported"));
  }, []);
  return [state, setState] as const;
}

function HomeScreenHelp() {
  return (
    <ol className="text-sm text-muted-foreground list-decimal pl-5 space-y-1">
      <li>
        In Safari, tap <Share className="inline h-3.5 w-3.5 -mt-0.5" /> Share, then <b>Add to Home Screen</b>.
      </li>
      <li>Close Safari and open DFS Ops from the new icon on your Home Screen.</li>
      <li>Sign in, come back here and tap <b>Turn on phone alerts</b>.</li>
    </ol>
  );
}

/** Settings section: turn phone alerts on/off for this phone, send a test. */
export function PhoneAlertsSection() {
  const { toast } = useToast();
  const [state, setState] = usePushState();
  const [busy, setBusy] = useState(false);

  const turnOn = async () => {
    setBusy(true);
    try {
      const s = await enablePush();
      setState(s);
      if (s === "on") toast({ title: "Phone alerts are on for this phone" });
      else if (s === "blocked") toast({ title: "Alerts are blocked", description: "Allow notifications for DFS Ops in your phone's settings.", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Couldn't turn on alerts", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      setState(await disablePush());
      toast({ title: "Phone alerts are off for this phone" });
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const r = await (await apiRequest("POST", "/api/board/push/test")).json();
      toast(r.sent ? { title: "Test alert sent", description: "It should pop up in a few seconds." } : { title: "No alert was sent", description: "Turn alerts off and on again on this phone.", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Test failed", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2.5" data-testid="section-phone-alerts">
      <div className="flex items-start gap-2.5">
        <Smartphone className="h-5 w-5 text-primary mt-0.5 shrink-0" />
        <div className="min-w-0">
          <div className="font-medium">Phone alerts</div>
          <p className="text-sm text-muted-foreground">
            A pop-up on this phone's lock screen when a task is assigned to you, your request is done, someone comments on your task or replies to your post,
            or a manager pins a post. Free — no text plan needed. Turn it on separately on each phone or computer you use.
          </p>
        </div>
      </div>
      {state === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : state === "needs-home-screen" ? (
        <div className="rounded-md bg-muted/50 p-3 space-y-2" data-testid="push-needs-home-screen">
          <p className="text-sm font-medium">On iPhone, phone alerts only work from the Home Screen icon.</p>
          <HomeScreenHelp />
        </div>
      ) : state === "unsupported" ? (
        <p className="text-sm text-muted-foreground" data-testid="push-unsupported">
          This browser can't show phone alerts. On iPhone, update to iOS 16.4 or newer and open DFS Ops from the Home Screen icon. On Android, use Chrome.
        </p>
      ) : state === "blocked" ? (
        <p className="text-sm text-muted-foreground" data-testid="push-blocked">
          Alerts are blocked for DFS Ops on this phone.{" "}
          {isIos() ? "Open the iPhone Settings app → Notifications → DFS Ops → turn on Allow Notifications." : "Tap the lock icon next to the address (or long-press the app icon → App info) → Notifications → Allow."}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {state === "on" ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400 mr-1 h-9" data-testid="push-on">
                <BellRing className="h-4 w-4" /> On for this phone
              </span>
              <Button variant="outline" size="sm" className="max-sm:h-11" disabled={busy} onClick={test} data-testid="button-push-test">
                Send a test alert
              </Button>
              <Button variant="ghost" size="sm" className="max-sm:h-11 text-muted-foreground" disabled={busy} onClick={turnOff} data-testid="button-push-off">
                <BellOff className="h-4 w-4 mr-1.5" /> Turn off
              </Button>
            </>
          ) : (
            <Button size="sm" className="max-sm:h-11 max-sm:w-full" disabled={busy} onClick={turnOn} data-testid="button-push-on">
              {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <BellRing className="h-4 w-4 mr-1.5" />} Turn on phone alerts
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const DISMISS_KEY = "dfs.board.pushPromptDismissed";

/** Small prompt on the board until this phone has alerts on (or it's dismissed). */
export function PhoneAlertsPrompt() {
  const { toast } = useToast();
  const [state, setState] = usePushState();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [busy, setBusy] = useState(false);
  const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIos();
  if (!phone || hidden || state === null || state === "on" || state === "unsupported" || state === "blocked") return null;
  const dismiss = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex gap-3 items-start" data-testid="banner-push-prompt">
      <BellRing className="h-5 w-5 text-primary mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="text-sm">
          <span className="font-medium">Get a pop-up on your phone</span> when a task is assigned to you or a manager pins a post.
        </div>
        {state === "needs-home-screen" ? (
          <HomeScreenHelp />
        ) : (
          <Button
            size="sm"
            className="max-sm:h-10"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const s = await enablePush();
                setState(s);
                if (s === "on") toast({ title: "Phone alerts are on" });
              } catch (e: any) {
                toast({ title: "Couldn't turn on alerts", description: e.message, variant: "destructive" });
              } finally {
                setBusy(false);
              }
            }}
            data-testid="button-prompt-push-on"
          >
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Turn on phone alerts
          </Button>
        )}
      </div>
      <button onClick={dismiss} className="p-1.5 -m-1 text-muted-foreground hover:text-foreground" aria-label="Hide">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
