// Text messages (SMS) through Twilio. Stays OFF until these are set in Vercel:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and either
//   TWILIO_MESSAGING_SERVICE_SID (preferred) or TWILIO_FROM (+1XXXXXXXXXX).
// US texting also needs the Twilio number registered (A2P 10DLC or a verified
// toll-free number) or carriers will block the messages.
const SID = (process.env.TWILIO_ACCOUNT_SID || "").trim();
const TOKEN = (process.env.TWILIO_AUTH_TOKEN || "").trim();
const SERVICE = (process.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
const FROM = (process.env.TWILIO_FROM || "").trim();

export function smsConfigured(): boolean {
  return !!(SID && TOKEN && (SERVICE || FROM));
}

/** Turn what people type (432-555-1234, (432) 555 1234, +1 432…) into +14325551234. */
export function normalizeUsPhone(raw: string | null | undefined): string | null {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export async function sendSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!smsConfigured()) return { ok: false, error: "Text messages aren't set up yet." };
  const phone = normalizeUsPhone(to);
  if (!phone) return { ok: false, error: "That isn't a 10-digit US phone number." };
  const form = new URLSearchParams({ To: phone, Body: body.slice(0, 600) });
  if (SERVICE) form.set("MessagingServiceSid", SERVICE);
  else form.set("From", FROM);
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (r.ok) return { ok: true };
    const j: any = await r.json().catch(() => ({}));
    console.error("[sms] send failed", r.status, j?.message);
    return { ok: false, error: j?.message ? `Twilio: ${String(j.message).slice(0, 160)}` : `Twilio error ${r.status}` };
  } catch (e: any) {
    console.error("[sms] send failed", e?.message || e);
    return { ok: false, error: "Couldn't reach Twilio." };
  }
}
