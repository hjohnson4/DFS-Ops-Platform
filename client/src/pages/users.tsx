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
import { useToast } from "@/hooks/use-toast";
import { Loader2, UserPlus, ShieldAlert, Pencil } from "lucide-react";

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

  const { data: health } = useQuery<{ ok: boolean; adminReady: boolean }>({
    queryKey: ["/api/health"],
  });
  const { data: users, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/users"],
  });

  // form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("field");
  const [area, setArea] = useState<string>(AREAS[0]);

  const create = useMutation({
    mutationFn: async () => {
      const body: any = { name, email, password, role };
      if (role !== "admin") body.area = area;
      const res = await apiRequest("POST", "/api/users", body);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User created", description: `${name} can now sign in.` });
      setOpen(false);
      setName(""); setEmail(""); setPassword(""); setRole("field");
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
                <Label>Temporary password</Label>
                <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 10 chars, letters and numbers" data-testid="input-new-password" />
              </div>
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
                disabled={create.isPending || !name || !email || !/^(?=.*[A-Za-z])(?=.*[0-9]).{10,}$/.test(password)}
                data-testid="button-save-user"
              >
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create user
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
    </div>
  );
}
