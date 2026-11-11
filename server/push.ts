// Phone alerts (web push) for the area board.
//
// Works on Android (Chrome) and on iPhone when DFS Ops is opened from the
// Home Screen icon (iOS 16.4 or newer). No outside service or monthly fee: the
// phone maker's push service (Apple / Google) delivers the alert.
//
// The signing keys ("VAPID" keys) are created automatically the first time
// they're needed and saved in the board_push_config table, so nothing has to be
// added in Vercel. If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set in Vercel
// they're used instead.
import webpush from "web-push";
import { supabaseAnon, supabaseAdmin } from "./supabase";

const db = () => supabaseAdmin || supabaseAnon;

type Keys = { publicKey: string; privateKey: string; subject: string };
let cached: Keys | null = null;

function subject(): string {
  const s = (process.env.VAPID_SUBJECT || "").trim();
  if (s) return s;
  const g = (process.env.GMAIL_USER || "").trim();
  return `mailto:${g || "dfsdailyreports@gmail.com"}`;
}

/** Signing keys, or null if the push tables haven't been set up yet. */
export async function getPushKeys(): Promise<Keys | null> {
  if (cached) return cached;
  const envPub = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const envPriv = (process.env.VAPID_PRIVATE_KEY || "").trim();
  if (envPub && envPriv) return (cached = { publicKey: envPub, privateKey: envPriv, subject: subject() });

  const read = async () => {
    const { data, error } = await db().from("board_push_config").select("public_key,private_key").eq("id", 1).maybeSingle();
    if (error) return { err: error.message } as const;
    return { row: data as any } as const;
  };
  let r = await read();
  if ("err" in r) return null;
  if (!r.row) {
    const k = webpush.generateVAPIDKeys();
    // If two requests race, the second insert fails on the primary key and we
    // just read back whichever one won.
    await db().from("board_push_config").insert({ id: 1, public_key: k.publicKey, private_key: k.privateKey });
    r = await read();
    if ("err" in r || !r.row) return null;
  }
  return (cached = { publicKey: r.row.public_key, privateKey: r.row.private_key, subject: subject() });
}

export type PushMessage = { title: string; body: string; url?: string; tag?: string };

/**
 * Send an alert to every phone/computer the given people turned alerts on for.
 * Never throws. Subscriptions the push service says are gone are removed.
 */
export async function sendPush(userIds: (string | null | undefined)[], msg: PushMessage): Promise<{ sent: number; failed: number }> {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  const out = { sent: 0, failed: 0 };
  if (!ids.length) return out;
  try {
    const keys = await getPushKeys();
    if (!keys) return out;
    const { data: subs } = await db()
      .from("board_push_subscriptions")
      .select("id,user_id,endpoint,p256dh,auth")
      .in("user_id", ids);
    if (!subs?.length) return out;
    const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "/#/board", tag: msg.tag });
    await Promise.all(
      (subs as any[]).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: 60 * 60 * 24,
            urgency: "high",
            timeout: 8000,
            vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          });
          out.sent++;
          await db().from("board_push_subscriptions").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id);
        } catch (e: any) {
          out.failed++;
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await db().from("board_push_subscriptions").delete().eq("id", s.id);
          }
        }
      }),
    );
  } catch {
    /* alerts are best-effort */
  }
  return out;
}
