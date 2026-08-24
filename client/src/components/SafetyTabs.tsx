import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type {
  JsaReportWithLinks,
  CertRosterEntry,
  RigUpReportWithLinks,
} from "@shared/schema";
import { certStatusOf } from "@shared/schema";
import { Mail, HardHat, BadgeCheck, UserCircle } from "lucide-react";

// Sub-tab strip for the Safety / JSAs area. The sidebar now has a single
// "Safety / JSAs" entry; these tabs let the user switch between the two JSA
// sources without separate nav items.
const TABS = [
  { href: "/jsa-intake", label: "JSA Intake", icon: Mail, match: "/jsa-intake" },
  { href: "/rig-up-reports", label: "Rig-up Reports", icon: HardHat, match: "/rig-up-reports" },
  { href: "/certifications", label: "Certifications", icon: BadgeCheck, match: "/certifications" },
  { href: "/employee-profiles", label: "Employee Profiles", icon: UserCircle, match: "/employee-profiles" },
];

export function SafetyTabs() {
  const [loc] = useLocation();
  // Count of emailed JSAs that still need attention (unmatched or awaiting
  // sign-off), shown as a badge on the Emailed Intake tab.
  const { data: intake } = useQuery<JsaReportWithLinks[]>({
    queryKey: ["/api/jsa-intake"],
  });
  const openIntake = (intake || []).filter(
    (j) => j.status === "Needs job match" || j.status === "Pending sign-off",
  ).length;
  // Count of expired certifications across the roster, shown on the
  // Certifications tab so lapsed compliance is visible at a glance.
  const { data: roster } = useQuery<CertRosterEntry[]>({
    queryKey: ["/api/certifications"],
  });
  const expiredCerts = (roster || []).reduce(
    (n, entry) =>
      n +
      entry.certs.filter((c) => certStatusOf(c.expiry_date) === "Expired")
        .length,
    0,
  );
  // Count of rig-up reports still awaiting an area manager's sign-off.
  const { data: rigUps } = useQuery<RigUpReportWithLinks[]>({
    queryKey: ["/api/rig-up-reports"],
  });
  const pendingRigUps = (rigUps || []).filter(
    (r) => r.status === "Pending sign-off",
  ).length;
  const badgeFor = (href: string) =>
    href === "/jsa-intake"
      ? openIntake
      : href === "/rig-up-reports"
        ? pendingRigUps
        : href === "/certifications"
          ? expiredCerts
          : 0;
  return (
    <div className="mb-5 flex items-center gap-1 border-b border-card-border overflow-x-auto no-scrollbar">
      {TABS.map((t) => {
        const active = loc === t.match || loc.startsWith(t.match + "/");
        const Icon = t.icon;
        return (
          <Link key={t.href} href={t.href}>
            <a
              className={`-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-${t.label.toLowerCase().replace(/\s/g, "-")}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
              {badgeFor(t.href) > 0 && (
                <span
                  className={`ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1 text-xs font-semibold ${
                    t.href === "/certifications"
                      ? "bg-red-500/20 text-red-700 dark:text-red-400"
                      : "bg-amber-500/20 text-amber-700 dark:text-amber-400"
                  }`}
                  data-testid={`badge-${
                    t.href === "/certifications"
                      ? "expired-certs"
                      : t.href === "/rig-up-reports"
                        ? "pending-rig-ups"
                        : "open-intake"
                  }`}
                >
                  {badgeFor(t.href)}
                </span>
              )}
            </a>
          </Link>
        );
      })}
    </div>
  );
}
