import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import logoUrl from "@/assets/dfs-logo.png";

function Logo() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Drilling Fluid Solutions">
      <img
        src={logoUrl}
        alt="DFS logo"
        className="h-10 w-10 shrink-0 object-contain"
      />
      <div className="leading-tight">
        <div className="font-semibold text-base tracking-tight">Drilling Fluid Solutions</div>
        <div className="text-[11px] text-muted-foreground -mt-0.5">
          Operations
        </div>
      </div>
    </div>
  );
}

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (e: any) {
      setErr(e.message || "Login failed");
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
          <h1 className="text-lg font-semibold mb-1">Sign in</h1>
          <p className="text-sm text-muted-foreground mb-5">
            Use the email and password your administrator set up for you.
          </p>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                data-testid="input-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                data-testid="input-password"
              />
            </div>
            {err && (
              <p className="text-sm text-destructive" data-testid="text-login-error">
                {err}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={busy}
              data-testid="button-login"
            >
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign in
            </Button>
          </form>
        </div>
        <p className="text-center text-xs text-muted-foreground mt-5">
          Drilling Fluid Solutions · West Texas · South Texas · North Louisiana
        </p>
      </div>
    </div>
  );
}
