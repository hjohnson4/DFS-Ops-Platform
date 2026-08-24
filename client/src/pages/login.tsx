import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
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

  // Forgot-password panel state.
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotBusy, setForgotBusy] = useState(false);
  // null = not submitted; "email" = a link was/would be sent; "admin" = email
  // isn't configured, tell them to contact an admin for a reset.
  const [forgotResult, setForgotResult] = useState<null | "email" | "admin">(null);

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

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotBusy(true);
    setForgotResult(null);
    try {
      const res = await apiRequest("POST", "/api/auth/forgot-password", {
        email: forgotEmail.trim(),
      });
      const data = await res.json();
      setForgotResult(data.emailEnabled ? "email" : "admin");
    } catch {
      // Never reveal errors that could confirm/deny an account; default to the
      // generic "contact your admin" guidance, which always applies.
      setForgotResult("admin");
    } finally {
      setForgotBusy(false);
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

          <div className="mt-4 border-t border-card-border pt-4">
            {!showForgot ? (
              <button
                type="button"
                onClick={() => {
                  setShowForgot(true);
                  setForgotEmail(email);
                  setForgotResult(null);
                }}
                className="text-sm text-primary hover:underline"
                data-testid="button-forgot-open"
              >
                Forgot password?
              </button>
            ) : (
              <form onSubmit={submitForgot} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="forgot-email">Reset your password</Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@company.com"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    required
                    data-testid="input-forgot-email"
                  />
                </div>
                {forgotResult === "email" && (
                  <p className="text-sm text-muted-foreground" data-testid="text-forgot-result">
                    If that email matches an account, we've sent a link to reset your password. Check
                    your inbox (and spam folder).
                  </p>
                )}
                {forgotResult === "admin" && (
                  <p className="text-sm text-muted-foreground" data-testid="text-forgot-result">
                    Email-based resets aren't enabled yet. Ask your administrator to reset your
                    password — they can generate a new temporary one for you from the Users page.
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={forgotBusy}
                    data-testid="button-forgot-submit"
                  >
                    {forgotBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Send reset link
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowForgot(false);
                      setForgotResult(null);
                    }}
                    data-testid="button-forgot-cancel"
                  >
                    Back to sign in
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
        <p className="text-center text-xs text-muted-foreground mt-5">
          Drilling Fluid Solutions · West Texas · South Texas · North Louisiana
        </p>
      </div>
    </div>
  );
}
