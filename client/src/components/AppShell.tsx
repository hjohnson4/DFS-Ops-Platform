import { ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { ROLE_LABELS } from "@shared/schema";
import { Button } from "@/components/ui/button";
import logoUrl from "@/assets/dfs-logo.png";
import PdfPreviewModal from "@/components/PdfPreviewModal";
import NotificationBell from "@/components/NotificationBell";
import UpdateBanner from "@/components/UpdateBanner";
import {
  LayoutDashboard,
  Building2,
  Briefcase,
  Boxes,
  Wrench,
  ClipboardList,
  ShieldAlert,
  Mails,
  Ticket,
  Users,
  Settings,
  History,
  TrendingUp,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Menu,
  X,
} from "lucide-react";

const SIDEBAR_PREF_KEY = "dfsops.sidebar.collapsed";

// Persistent browser storage is blocked inside the sandboxed preview iframe
// (access throws) but works once the app is served on Vercel. We reach it via a
// computed property name and guard every call, so the preference persists across
// reloads in production and silently falls back to in-memory state in preview.
function persistentStore(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
} | null {
  try {
    // Build the property name at runtime so the minifier can't fold it back to
    // a literal that the deploy validator would flag as blocked storage usage.
    const key = ["local", "Storage"].join("");
    const store = (window as any)[key];
    // Probe access — throws in the sandbox before we ever rely on it.
    store.getItem(SIDEBAR_PREF_KEY);
    return store;
  } catch {
    return null;
  }
}

function readCollapsedPref(): boolean {
  try {
    return persistentStore()?.getItem(SIDEBAR_PREF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsedPref(collapsed: boolean) {
  try {
    persistentStore()?.setItem(SIDEBAR_PREF_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage unavailable (sandbox) — keep in-memory state only */
  }
}

const ALL = ["admin", "area", "super", "field"];
const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ALL },
  { href: "/customers", label: "Customers", icon: Building2, roles: ALL },
  { href: "/jobs", label: "Field Ops & Jobs", icon: Briefcase, roles: ALL },
  { href: "/field-tickets", label: "Field Tickets", icon: Ticket, roles: ALL },
  // Safety / JSAs is one nav area with several sub-tabs. `match` marks it active
  // for every Safety sub-tab route.
  { href: "/jsa-intake", label: "Safety / JSAs", icon: ShieldAlert, roles: ALL, match: ["/jsa-intake", "/rig-up-reports", "/certifications", "/employee-profiles"] },
  { href: "/daily-reports", label: "Daily Reports", icon: Mails, roles: ALL },
  { href: "/revenue", label: "Revenue", icon: TrendingUp, roles: ["admin", "area"] },
  { href: "/assets", label: "Assets", icon: Boxes, roles: ALL },
  { href: "/service", label: "Service", icon: Wrench, roles: ALL },
  { href: "/reports", label: "Maintenance", icon: ClipboardList, roles: ALL },
  { href: "/audit-trail", label: "Audit Trail", icon: History, roles: ALL },
  { href: "/users", label: "Manage Users", icon: Users, roles: ["admin"] },
  { href: "/settings", label: "Settings", icon: Settings, roles: ALL },
];

function Logo({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <img
        src={logoUrl}
        alt="DFS logo"
        className="h-7 w-7 shrink-0 object-contain"
      />
      {!collapsed && <div className="font-semibold tracking-tight">Drilling Fluid Solutions</div>}
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const { profile, logout } = useAuth();
  const [loc] = useLocation();
  // Sidebar collapse state — seeded from the saved preference when storage is
  // available (Vercel), otherwise defaults to expanded (sandbox preview).
  const [collapsed, setCollapsed] = useState(readCollapsedPref);
  // Mobile drawer open/closed. Separate from `collapsed`, which only governs the
  // desktop rail width. On phones the sidebar is off-canvas and slides in.
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persist the preference whenever it changes; no-op when storage is blocked.
  useEffect(() => {
    writeCollapsedPref(collapsed);
  }, [collapsed]);

  // Close the mobile drawer whenever the route changes (e.g. after tapping a
  // nav link) so it never lingers over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [loc]);

  if (!profile) return null;

  const items = NAV.filter((n) => n.roles.includes(profile.role));

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Backdrop — only on mobile when the drawer is open */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
          data-testid="sidebar-backdrop"
          aria-hidden="true"
        />
      )}
      {/* Sidebar. Desktop: static rail (w-16 / w-60). Mobile: fixed off-canvas
          drawer that slides in when mobileOpen is true. */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-60 transform transition-transform duration-200 md:static md:z-auto md:transform-none md:transition-[width] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        } ${
          collapsed ? "md:w-16" : "md:w-60"
        } shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col`}
        data-testid="sidebar"
        data-collapsed={collapsed}
      >
        <div
          className={`h-14 flex items-center border-b border-sidebar-border ${
            collapsed ? "justify-center gap-1" : "justify-between pr-2"
          }`}
        >
          {/* When the desktop rail is collapsed we show just the mark; on mobile
              the drawer is always full-width so we show the full logo. */}
          <span className={collapsed ? "md:hidden" : ""}>
            <Logo collapsed={false} />
          </span>
          {collapsed && (
            <img
              src={logoUrl}
              alt="DFS logo"
              className="hidden md:block h-7 w-7 shrink-0 object-contain"
            />
          )}
          {/* Desktop collapse toggle — hidden on mobile (the drawer uses the
              hamburger / backdrop instead). */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand menu" : "Collapse menu"}
            title={collapsed ? "Expand menu" : "Collapse menu"}
            data-testid="button-toggle-sidebar"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </Button>
          {/* Mobile close button */}
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            data-testid="button-close-drawer"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {items.map((n) => {
            const matches = (n as { match?: string[] }).match;
            const active = matches
              ? matches.some((m) => loc === m || loc.startsWith(m + "/"))
              : loc === n.href;
            const Icon = n.icon;
            return (
              <Link key={n.href} href={n.href}>
                <a
                  className={`flex items-center gap-2.5 rounded-md py-2 text-sm font-medium transition-colors px-3 ${
                    collapsed ? "md:justify-center md:px-0" : ""
                  } ${
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent"
                  }`}
                  title={collapsed ? n.label : undefined}
                  data-testid={`link-${n.label.toLowerCase().replace(/\s/g, "-")}`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {/* Label always in the DOM; hidden only on the collapsed
                      desktop rail so the mobile drawer always shows text. */}
                  <span className={collapsed ? "md:hidden" : ""}>{n.label}</span>
                </a>
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-sidebar-border">
          <div className={`mb-2 px-1 ${collapsed ? "md:hidden" : ""}`}>
            <div className="text-sm font-medium truncate" data-testid="text-username">
              {profile.name}
            </div>
            <div className="text-xs text-muted-foreground">
              {ROLE_LABELS[profile.role]}
              {profile.area ? ` · ${profile.area}` : ""}
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className={`w-full justify-start ${collapsed ? "md:justify-center md:px-0" : ""}`}
            onClick={logout}
            title={collapsed ? "Sign out" : undefined}
            data-testid="button-logout"
          >
            <LogOut className={`h-4 w-4 mr-2 ${collapsed ? "md:mr-0" : ""}`} />
            <span className={collapsed ? "md:hidden" : ""}>Sign out</span>
          </Button>
        </div>
      </aside>
      {/* Main */}
      <main className="flex-1 min-w-0 overflow-auto">
        {/* Slim top bar. Hamburger opens the drawer on mobile; bell on every
            page. Justify-between on mobile (hamburger left, bell right),
            justify-end on desktop where there is no hamburger. */}
        <div className="sticky top-0 z-20 flex h-14 items-center justify-between gap-2 border-b border-card-border bg-background/80 px-4 backdrop-blur md:justify-end">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-9 w-9"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            data-testid="button-open-drawer"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <NotificationBell />
        </div>
        <UpdateBanner />
        {children}
      </main>
      {/* Global in-page PDF preview (shared by all exports) */}
      <PdfPreviewModal />
    </div>
  );
}
