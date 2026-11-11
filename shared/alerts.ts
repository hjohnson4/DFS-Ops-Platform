// Phone alert types people can switch on/off in Settings → Task alerts.
// `roles` = who sees the switch; `on` = who has it on until they change it.
export type AlertRole = "admin" | "area" | "super" | "field";
export type AlertKind =
  | "board"
  | "daily_report"
  | "report_action"
  | "changes_requested"
  | "service_signoff"
  | "service_signed"
  | "service_charge"
  | "ticket_approval";

export const ALERT_KINDS: {
  key: AlertKind;
  label: string;
  desc: string;
  roles: AlertRole[];
  on: AlertRole[];
}[] = [
  {
    key: "board",
    label: "Area Board",
    desc: "A task is assigned to you, your request is done, someone comments on your task or replies to your post, or a manager pins a post.",
    roles: ["admin", "area", "super"],
    on: ["admin", "area", "super"],
  },
  {
    key: "daily_report",
    label: "Daily report received",
    desc: "A new or corrected daily report comes in for your area. Says if it's missing data.",
    roles: ["admin", "area", "super"],
    on: ["area"],
  },
  {
    key: "report_action",
    label: "Report needs a job match or correction approved",
    desc: "A report didn't match a job, or a corrected workbook arrived for a report that was already signed off.",
    roles: ["admin", "area"],
    on: ["admin", "area"],
  },
  {
    key: "changes_requested",
    label: "Changes requested on my report or JSA",
    desc: "A reviewer sent your daily report or JSA back to fix.",
    roles: ["admin", "area", "super"],
    on: ["admin", "area", "super"],
  },
  {
    key: "service_signoff",
    label: "Service report needs my sign-off",
    desc: "A supervisor filed a service report in your area.",
    roles: ["admin", "area"],
    on: ["area"],
  },
  {
    key: "service_signed",
    label: "My service report was signed off",
    desc: "An Area Manager signed off a service report you filed.",
    roles: ["area", "super"],
    on: ["super"],
  },
  {
    key: "service_charge",
    label: "Service charge logged",
    desc: "Someone logs a service charge on a job in your area.",
    roles: ["admin", "area", "super"],
    on: [],
  },
  {
    key: "ticket_approval",
    label: "Field ticket ready for approval",
    desc: "A field ticket is closed and waiting for an Admin to approve it.",
    roles: ["admin"],
    on: ["admin"],
  },
];

/** Is this alert on for someone with this role and saved choices? */
export function alertOn(kind: AlertKind, role: string, saved: Record<string, boolean> | null | undefined): boolean {
  const def = ALERT_KINDS.find((k) => k.key === kind);
  if (!def || !def.roles.includes(role as AlertRole)) return false;
  const v = saved?.[kind];
  return typeof v === "boolean" ? v : def.on.includes(role as AlertRole);
}
