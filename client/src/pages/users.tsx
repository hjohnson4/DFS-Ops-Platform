import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  ROLES,
  ROLE_LABELS,
  AREAS,
  type Profile,
  type Role,
} from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UserPlus, ShieldAlert, Pencil, Send, RefreshCw, Copy, KeyRound } from "lucide-react";

const ROLE_TONE: Record<Role, string> = {
  admin: "bg-primary/10 text-primary",
  area: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  super: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  field: "bg-muted text-muted-foreground",
};

export default function UsersPage() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  // Edit dialog state: which user is being edited + the draft role/area.
  const [editing, setEditing] = useState<Profile | null>(null);
  const [editRole, setEditRole] = useState<Role>("field");
  const [editArea, setEditArea] = useState<string>(AREAS[0]);

  function openEdit(u: Profile) {
    setEditing(u);
    setEditRole(u.role);
    // Admins have no area; default the picker to a valid choice so the select
    // isn't empty if the role is switched away from admin.
    setEditArea((u.area as string) || AREAS[0]);
  }

  const { data: health } = useQuery<{ ok: boolean; adminReady: boolean; emailReady?: boolean }>({
    queryKey: ["/api/health"],
  });
  const { data: users, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/users"],
  });

  // form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // "invite" = email them a set-password link; "password" = admin sets one now.
  // Default to "password": the admin creates credentials and shares them (email
  // invites are dormant unless an email provider is configured).
  const [mode, setMode] = useState<"invite" | "password">("password");
  // When true (password mode), the new user must change their password on first
  // login. Recommended when the admin picks a temporary password to share.
  const [requireChange, setRequireChange] = useState(true);
  const [role, setRole] = useState<Role>("field");
  const [area, setArea] = useState<string>(AREAS[0]);

  // Generate a strong, readable temporary password (>=10 chars, letters+digits).
  function generatePassword() {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O to avoid confusion
    const lower = "abcdefghijkmnpqrstuvwxyz"; // no l
    const digits = "23456789"; // no 0/1
    const all = upper + lower + digits;
    const pick = (set: string) => set[Math.floor(Math.random() * set.length)];
    // Guarantee the mix, then fill to 12 and shuffle.
    let chars = [pick(upper), pick(lower), pick(digits), pick(digits)];
    while (chars.length < 12) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    setPassword(chars.join(""));
  }

  async function copyCredentials() {
    const appUrl = window.location.origin + window.location.pathname + "#/";
    const text =
      `DFS Ops login\n` +
      `URL: ${appUrl}\n` +
      `Email: ${email}\n` +
      `Temporary password: ${password}\n` +
      (requireChange ? `You'll be asked to set your own password on first login.` : ``);
    try {
      await navigator.clipboard.writeText(text.trim());
      toast({ title: "Copied", description: "Login details copied to clipboard." });
    } catch {
      toast({
        title: "Couldn't copy automatically",
        description: "Select and copy the password field manually.",
        variant: "destructive",
      });
    }
  }

  const create = useMutation({
    mutationFn: async () => {
      const body: any = { name, email, mode, role };
      if (mode === "password") {
        body.password = password;
        body.requirePasswordChange = requireChange;
      }
      if (role !== "admin") body.area = area;
      const res = await apiRequest("POST", "/api/users", body);
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      if (mode === "invite") {
        toast({
          title: data?.invited ? "Invite sent" : "User created",
          description: data?.invited
            ? `${name} was emailed a link to set their password.`
            : `${name} was created. ${data?.inviteError || "Email delivery isn't confirmed — you may need to set a password for them."}`,
        });
      } else {
        toast({ title: "User created", description: `${name} can now sign in.` });
      }
      setOpen(false);
      setName(""); setEmail(""); setPassword(""); setRole("field"); setMode("password"); setRequireChange(true);
    },
    onError: (e: any) =>
      toast({ title: "Could not create user", description: e.message, variant: "destructive" }),
  });

  const toggleActive = useMutation({
    mutationFn: async (u: Profile) => {
      const res = await apiRequest("PATCH", `/api/users/${u.id}`, { active: !u.active });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/users"] }),
  });

  // Track which user's invite is currently being resent (to show a spinner on
  // just that row's button).
  const [resendingId, setResendingId] = useState<string | null>(null);
  const resendInvite = useMutation({
    mutationFn: async (u: Profile) => {
      setResendingId(u.id);
      const res = await apiRequest("POST", `/api/users/${u.id}/resend-invite`);
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Invite sent",
        description: `A new set-password link was emailed to ${data?.email || "the user"}.`,
      });
    },
    onError: (e: any) =>
      toast({ title: "Could not send invite", description: e.message, variant: "destructive" }),
    onSettled: () => setResendingId(null),
  });

  // Admin password reset. On success we surface the generated temporary
  // password in a dialog (with Copy) so the admin can hand it to the user.
  const [resetResult, setResetResult] = useState<{ email: string; password: string } | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const resetPassword = useMutation({
    mutationFn: async (u: Profile) => {
      setResettingId(u.id);
      const res = await apiRequest("POST", `/api/users/${u.id}/reset-password`);
      return res.json();
    },
    onSuccess: (data: any) => {
      setResetResult({ email: data.email, password: data.temporaryPassword });
    },
    onError: (e: any) =>
      toast({ title: "Could not reset password", description: e.message, variant: "destructive" }),
    onSettled: () => setResettingId(null),
  });

  // Robust copy: try the async Clipboard API, then fall back to a hidden
  // textarea + execCommand("copy"), which works when navigator.clipboard is
  // unavailable or blocked (older browsers, some embedded/secure contexts).
  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through to legacy path
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  async function copyResetPassword() {
    if (!resetResult) return;
    const ok = await copyText(resetResult.password);
    toast(
      ok
        ? { title: "Password copied", description: "Paste it wherever you need it." }
        : {
            title: "Couldn't copy automatically",
            description: "Tap the password field to select it, then copy manually.",
            variant: "destructive",
          },
    );
  }

  async function copyResetCredentials() {
    if (!resetResult) return;
    const appUrl = window.location.origin + window.location.pathname + "#/";
    const text =
      `DFS Ops login\n` +
      `URL: ${appUrl}\n` +
      `Email: ${resetResult.email}\n` +
      `Temporary password: ${resetResult.password}\n` +
      `You'll be asked to set your own password on first login.`;
    const ok = await copyText(text.trim());
    toast(
      ok
        ? { title: "Copied", description: "Login details copied to clipboard." }
        : {
            title: "Couldn't copy automatically",
            description: "Tap the password field to select it, then copy manually.",
            variant: "destructive",
          },
    );
  }

  const updateUser = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      // Admins are company-wide: clear the area when the role is admin,
      // otherwise send the selected area (matches the create flow).
      const body: { role: Role; area: string | null } = {
        role: editRole,
        area: editRole === "admin" ? null : editArea,
      };
      const res = await apiRequest("PATCH", `/api/users/${editing.id}`, body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({
        title: "User updated",
        description: `${editing?.name}'s position and area were saved.`,
      });
      setEditing(null);
    },
    onError: (e: any) =>
      toast({
        title: "Could not update user",
        description: e.message,
        variant: "destructive",
      }),
  });

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold">Manage Users</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              data-testid="button-add-user"
              disabled={!!health && !health.adminReady}
              title={
                health && !health.adminReady
                  ? "Account creation activates once the service role key is set in the deployment environment."
                  : undefined
              }
            >
              <UserPlus className="mr-2 h-4 w-4" /> Add user
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a new user</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Full name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="input-name" />
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="input-new-email" />
              </div>
              <div className="space-y-1.5">
                <Label>How should they get access?</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as "invite" | "password")}>
                  <SelectTrigger data-testid="select-mode"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="password">Set a password now (share it with them)</SelectItem>
                    <SelectItem value="invite" disabled={!!health && !health.emailReady}>
                      Email an invite (they set their own password){health && !health.emailReady ? " — needs email setup" : ""}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {mode === "password" && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Temporary password</Label>
                    <div className="flex gap-2">
                      <Input
                        type="text"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="min 10 chars, letters and numbers"
                        data-testid="input-new-password"
                        className="font-mono"
                      />
                      <Button type="button" variant="outline" onClick={generatePassword} data-testid="button-generate-password">
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Generate
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={copyCredentials}
                        disabled={!email || !password}
                        title={!email || !password ? "Enter an email and password first" : "Copy login details to share"}
                        data-testid="button-copy-credentials"
                      >
                        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Share the email and this password with the employee. “Copy” puts the
                      login URL, email, and password on your clipboard.
                    </p>
                  </div>
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <Checkbox
                      checked={requireChange}
                      onCheckedChange={(v) => setRequireChange(v === true)}
                      data-testid="checkbox-require-change"
                      className="mt-0.5"
                    />
                    <span className="text-sm">
                      Require them to set their own password on first login
                      <span className="block text-xs text-muted-foreground">
                        Recommended — the temporary password only works once, then they choose their own.
                      </span>
                    </span>
                  </label>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                    <SelectTrigger data-testid="select-role"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Area</Label>
                  <Select value={area} onValueChange={setArea} disabled={role === "admin"}>
                    <SelectTrigger data-testid="select-area"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {AREAS.map((a) => (
                        <SelectItem key={a} value={a}>{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => create.mutate()}
                disabled={
                  create.isPending ||
                  !name ||
                  !email ||
                  (mode === "password" &&
                    !/^(?=.*[A-Za-z])(?=.*[0-9]).{10,}$/.test(password))
                }
                data-testid="button-save-user"
              >
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {mode === "invite" ? "Send invite" : "Create user"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <p className="text-sm text-muted-foreground mb-5">
        Only admins can create accounts. Each account's email is also its notification address.
      </p>

      {health && !health.adminReady && (
        <div className="mb-5 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
          <div>
            <span className="font-medium">Account creation is in preview mode.</span>{" "}
            Creating real login accounts activates once the service role key is set in the
            deployment environment (a one-time step at Vercel deploy). You can explore the
            interface now.
          </div>
        </div>
      )}

      <div className="rounded-lg border border-card-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="text-left">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Area</th>
              <th className="px-4 py-2.5 font-medium">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {users && users.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">No users yet. Add the first account.</td></tr>
            )}
            {users?.map((u) => (
              <tr key={u.id} className="border-t border-card-border" data-testid={`row-user-${u.id}`}>
                <td className="px-4 py-2.5 font-medium">{u.name}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{u.email}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${ROLE_TONE[u.role]}`}>
                    {ROLE_LABELS[u.role]}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">{u.area || "—"}</td>
                <td className="px-4 py-2.5">
                  <span className={u.active ? "text-emerald-600" : "text-muted-foreground"}>
                    {u.active ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(u)} data-testid={`button-edit-${u.id}`}>
                    <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => resendInvite.mutate(u)}
                    disabled={resendingId === u.id || (health && (!health.adminReady || !health.emailReady))}
                    title={
                      health && !health.emailReady
                        ? "Email isn't configured yet, so invites can't be sent."
                        : "Email a fresh set-password link to this user"
                    }
                    data-testid={`button-resend-${u.id}`}
                  >
                    {resendingId === u.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Resend invite
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => resetPassword.mutate(u)}
                    disabled={resettingId === u.id || (health && !health.adminReady)}
                    title="Set a new temporary password for this user to share"
                    data-testid={`button-reset-${u.id}`}
                  >
                    {resettingId === u.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Reset password
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => toggleActive.mutate(u)} data-testid={`button-toggle-${u.id}`}>
                    {u.active ? "Deactivate" : "Reactivate"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Edit position + area */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Change this user's position and the area they're assigned to.
              Admins have company-wide access, so no area is required.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Position</Label>
                <Select value={editRole} onValueChange={(v) => setEditRole(v as Role)}>
                  <SelectTrigger data-testid="select-edit-role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Area</Label>
                <Select value={editArea} onValueChange={setEditArea} disabled={editRole === "admin"}>
                  <SelectTrigger data-testid="select-edit-area"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AREAS.map((a) => (
                      <SelectItem key={a} value={a}>{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {editRole === "admin" && (
              <p className="text-xs text-muted-foreground">
                Admins aren't tied to an area — this user's area will be cleared.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} data-testid="button-cancel-edit">
              Cancel
            </Button>
            <Button
              onClick={() => updateUser.mutate()}
              disabled={updateUser.isPending}
              data-testid="button-save-edit"
            >
              {updateUser.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset-password result: show the new temporary password + Copy */}
      <Dialog open={!!resetResult} onOpenChange={(o) => !o && setResetResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Share these details with{" "}
              <span className="font-medium text-foreground">{resetResult?.email}</span>. They'll be
              asked to set their own password the next time they sign in.
            </p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={resetResult?.password ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-base tracking-wide"
                data-testid="input-reset-password"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copyResetPassword}
                data-testid="button-reset-copy-password"
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This password is shown once. Copy it now — it can't be retrieved later.
              You can also tap the field to select it.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetResult(null)} data-testid="button-reset-done">
              Done
            </Button>
            <Button onClick={copyResetCredentials} data-testid="button-reset-copy">
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copy login details
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
