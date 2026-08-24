import { useEffect, useState } from "react";
import { apiRequest, setAccessToken } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2 } from "lucide-react";
import logoUrl from "@/assets/dfs-logo.png";

function Logo() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Drilling Fluid Solutions">
      <img src={logoUrl} alt="DFS logo" className="h-10 w-10 shrink-0 object-contain" />
      <div className="leading-tight">
        <div className="font-semibold text-base tracking-tight">Drilling Fluid Solutions</div>
        <div className="text-[11px] text-muted-foreground -mt-0.5">Operations</div>
      </div>
    </div>
  );
}

// Read ?token=... out of the hash-route query string. With the hash router the
// URL looks like https://host/#/set-password?token=abc — the token is in the
// portion after the "?" inside location.hash.
function tokenFromHash(): string {
  const hash = window.location.hash || "";
  const qIdx = hash.indexOf("?");
  if (qIdx === -1) return "";
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get("token") || "";
}

const PW_OK = (p: string) => /^(?=.*[A-Za-z])(?=.*[0-9]).{10,}$/.test(p);

export default function SetPassword() {
  const { refresh } = useAuth();
  const [token] = useState(tokenFromHash);
  const [checking, setChecking] = useState(true);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [greetName, setGreetName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  // Verify the token on mount so we can greet the invitee (or show an error).
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) {
        setInvalid("This link is missing its invite token. Ask your admin to resend the invite.");
        setChecking(false);
        return;
      }
      try {
        const res = await apiRequest("POST", "/api/invite/verify", { token });
        const data = await res.json();
        if (!alive) return;
        setGreetName(data.name || null);
        setEmail(data.email || null);
      } catch (e: any) {
        if (!alive) return;
        setInvalid(e.message || "This invite link is invalid or has expired.");
      } finally {
        if (alive) setChecking(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!PW_OK(pw)) {
      setErr("Password must be at least 10 characters and include a letter and a number.");
      return;
    }
    if (pw !== pw2) {
      setErr("The two passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest("POST", "/api/invite/complete", { token, password: pw });
      const data = await res.json();
      if (data.access_token) {
        // Auto-login: store the session and route into the app.
        setAccessToken(data.access_token);
        await refresh();
        window.location.hash = "#/";
      } else {
        // Password set but auto-login unavailable — send them to the login page.
        setDone(true);
      }
    } catch (e: any) {
      setErr(e.message || "Could not set your password. The link may have expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-xl border border-card-border bg-card p-6 shadow-sm">
          {checking ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : invalid ? (
            <>
              <h1 className="text-lg font-semibold mb-1">Invite link problem</h1>
              <p className="text-sm text-muted-foreground mb-5">{invalid}</p>
              <Button variant="outline" className="w-full" onClick={() => (window.location.hash = "#/")}>
                Go to sign in
              </Button>
            </>
          ) : done ? (
            <>
              <div className="flex items-center gap-2 mb-2 text-green-600">
                <CheckCircle2 className="h-5 w-5" />
                <h1 className="text-lg font-semibold">Password set</h1>
              </div>
              <p className="text-sm text-muted-foreground mb-5">
                Your password is set. You can now sign in with{email ? ` ${email}` : " your email"}.
              </p>
              <Button className="w-full" onClick={() => (window.location.hash = "#/")}>
                Go to sign in
              </Button>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold mb-1">
                Welcome{greetName ? `, ${greetName}` : ""}
              </h1>
              <p className="text-sm text-muted-foreground mb-5">
                Set a password to finish setting up your DFS Ops account
                {email ? ` (${email})` : ""}.
              </p>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="pw">New password</Label>
                  <Input
                    id="pw"
                    type="password"
                    autoComplete="new-password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="min 10 chars, letters and numbers"
                    required
                    data-testid="input-set-password"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw2">Confirm password</Label>
                  <Input
                    id="pw2"
                    type="password"
                    autoComplete="new-password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    required
                    data-testid="input-confirm-password"
                  />
                </div>
                {err && <p className="text-sm text-destructive">{err}</p>}
                <Button type="submit" className="w-full" disabled={busy} data-testid="button-set-password">
                  {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Set password and sign in
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
