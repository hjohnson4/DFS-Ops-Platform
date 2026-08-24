import { supabaseAdmin, supabaseAnon } from "./supabase";

/**
 * Email notifications. Real delivery is wired at the notifications milestone
 * via a provider (Resend/SendGrid) using RESEND_API_KEY. Until then this logs
 * intended sends so the flow is verifiable without spamming anyone.
 */

type Kind = "needs_signoff" | "signed";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.EMAIL_FROM || "DFS Ops <onboarding@resend.dev>";

async function deliver(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[email:stub] would send to ${to} — "${subject}"`);
    return false; // not actually delivered yet
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!r.ok) {
      console.error("[email] send failed", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[email] send error", e);
    return false;
  }
}

export function emailConfigured(): boolean {
  return !!RESEND_API_KEY;
}

/**
 * Email suggested changes on a daily report back to the sender.
 * Returns true if actually delivered (Resend keyed), false if stubbed.
 */
export async function sendDailyReportChanges(ctx: {
  to: string;
  senderName?: string | null;
  subject?: string | null;
  reviewerName: string;
  changeNotes: string;
  reportDate?: string | null;
}): Promise<boolean> {
  const who = ctx.senderName ? `${ctx.senderName}` : "there";
  const re = ctx.subject ? `Re: ${ctx.subject}` : "Re: your daily report";
  const dateLine = ctx.reportDate ? ` (${ctx.reportDate})` : "";
  const html = `
    <p>Hi ${who},</p>
    <p><b>${ctx.reviewerName}</b> reviewed your daily report${dateLine} and is requesting some changes:</p>
    <blockquote style="border-left:3px solid #ccc;margin:0;padding:8px 12px;color:#333;white-space:pre-wrap;">${ctx.changeNotes}</blockquote>
    <p>Please update the report and resend. Thanks.</p>
    <p style="color:#888;font-size:12px;">Sent by DFS Ops</p>`;
  return deliver(ctx.to, `Changes requested — ${re}`, html);
}

export async function sendNotificationEmails(
  kind: Kind,
  ctx: { report: any; asset: any; signerName?: string },
) {
  const client = supabaseAdmin || supabaseAnon;
  const { report, asset } = ctx;

  if (kind === "needs_signoff") {
    // area managers in the asset's area who opted in
    const { data: mgrs } = await client
      .from("profiles")
      .select("id,email,name,role,area,active, notification_prefs(on_needs_signoff)")
      .eq("role", "area")
      .eq("area", asset.area)
      .eq("active", true);
    for (const m of mgrs || []) {
      const pref = (m as any).notification_prefs?.[0]?.on_needs_signoff ?? true;
      if (!pref) continue;
      await deliver(
        m.email,
        `Report needs your sign-off — ${asset.tag}`,
        `<p>A maintenance report on <b>${asset.tag}</b> (${asset.category}, ${asset.area}) needs your sign-off.</p>`,
      );
    }
  }

  if (kind === "signed") {
    // the supervisor who filed it, if opted in
    const { data: sup } = await client
      .from("profiles")
      .select("id,email,name, notification_prefs(on_signed)")
      .eq("id", report.supervisor_id)
      .single();
    if (sup) {
      const pref = (sup as any).notification_prefs?.[0]?.on_signed ?? true;
      if (pref)
        await deliver(
          sup.email,
          `Your report was signed off — ${asset.tag}`,
          `<p>Your maintenance report on <b>${asset.tag}</b> was signed off by ${ctx.signerName}.</p>`,
        );
    }
  }
}
