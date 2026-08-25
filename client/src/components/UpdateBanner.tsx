import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// Polls a stable /version.json (written at build time) and, when the deployed
// build no longer matches the one this tab booted with, shows a slim banner
// prompting a refresh. This closes the "stale tab" gap: after a Vercel redeploy,
// users who already had the app open get nudged onto the new version instead of
// silently running old code until they happen to reload.
//
// Fail-safe by design: if version.json can't be fetched (e.g. the sandbox
// preview iframe, or a transient network blip) the banner simply never appears.

const POLL_MS = 2 * 60 * 1000; // check every 2 minutes

async function fetchVersion(): Promise<string | null> {
  try {
    // Cache-bust + no-store so we always read the freshly deployed value rather
    // than a CDN/browser-cached copy.
    const res = await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export default function UpdateBanner() {
  // The version this tab booted with. Null until the first successful read.
  const bootedVersion = useRef<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const current = await fetchVersion();
      if (cancelled || current === null) return;
      if (bootedVersion.current === null) {
        // First read establishes our baseline; nothing to prompt yet.
        bootedVersion.current = current;
        return;
      }
      if (current !== bootedVersion.current) {
        setUpdateAvailable(true);
      }
    };

    // Establish the baseline immediately, then poll on an interval and whenever
    // the tab regains focus (a common moment for a stale tab to catch up).
    check();
    const id = window.setInterval(check, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!updateAvailable) return null;

  return (
    <div
      className="flex items-center justify-between gap-3 border-b border-primary/30 bg-primary/10 px-4 py-2 text-sm"
      role="status"
      data-testid="banner-update-available"
    >
      <span className="flex items-center gap-2 text-foreground">
        <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
        A new version of DFS Ops is available.
      </span>
      <Button
        size="sm"
        onClick={() => window.location.reload()}
        data-testid="button-refresh-app"
      >
        Refresh
      </Button>
    </div>
  );
}
