import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ShieldCheck } from "lucide-react";
import logoUrl from "@/assets/dfs-logo.png";

const PW_OK = /^(?=.*[A-Za-z])(?=.*[0-9]).{10,}$/;

/**
 * ChangePasswordForm — the shared form used both in Settings (change anytime)
 * and on the forced first-login screen. `onDone` runs after a successful
 * change (e.g. refresh auth state / navigate away).
 */
export default function ChangePassword() {
  // Default export exists so this module matches the same import shape as the
  // other page modules (Vite/Vercel resolve default page exports cleanly).
  return <ChangePasswordForm />;
}

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const nextOk = PW_OK.test(next);
  const matches = next === confirm;
  const canSubmit = current.length > 0 && nextOk && matches && !busy;

  async function submit() {
    setBusy(true);
    try {
      await apiRequest("POST", "/api/account/change-password", {
        currentPassword: current,
        newPassword: next,
      });
      toast({ title: "Password changed", description: "Your new password is now active." });
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone?.();
    } catch (e: any) {
      toast({ title: "Couldn't change password", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>Current password</Label>
        <Input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          data-testid="input-current-password"
        />
      </div>
      <div className="space-y-1.5">
        <Label>New password</Label>
        <Input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="min 10 chars, letters and numbers"
          autoComplete="new-password"
          data-testid="input-new-password"
        />
        {next.length > 0 && !nextOk && (
          <p className="text-xs text-destructive">
            Must be at least 10 characters and include a letter and a number.
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label>Confirm new password</Label>
        <Input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          data-testid="input-confirm-password"
        />
        {confirm.length > 0 && !matches && (
          <p className="text-xs text-destructive">Passwords don't match.</p>
        )}
      </div>
      <Button onClick={submit} disabled={!canSubmit} data-testid="button-change-password">
        {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Change password
      </Button>
    </div>
  );
}

/**
 * ForcedPasswordChange — full-screen gate shown when the signed-in user's
 * account is flagged must_change_password (set by an admin who created them
 * with a temporary password). They can't reach the rest of the app until they
 * set their own password. On success we refresh auth state, which clears the
 * flag and drops them into the app.
 */
export function ForcedPasswordChange() {
  const { profile, refresh, logout } = useAuth();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <img src={logoUrl} alt="DFS" className="h-12 w-auto mb-3" />
          <div className="flex items-center gap-1.5 text-sm font-medium text-primary">
            <ShieldCheck className="h-4 w-4" /> Set your password
          </div>
        </div>
        <div className="rounded-lg border border-card-border bg-card p-5">
          <p className="text-sm text-muted-foreground mb-4">
            Welcome{profile?.name ? `, ${profile.name.split(" ")[0]}` : ""}. For security,
            choose your own password before continuing. Enter the temporary password your
            administrator gave you, then pick a new one.
          </p>
          <ChangePasswordForm onDone={() => refresh()} />
          <button
            onClick={logout}
            className="mt-4 text-xs text-muted-foreground hover:text-foreground underline"
            data-testid="button-signout"
          >
            Sign out instead
          </button>
        </div>
      </div>
    </div>
  );
}
