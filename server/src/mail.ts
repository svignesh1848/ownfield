// Optional email: only when SMTP_HOST is set and the optional "nodemailer" package is installed.
// Nothing is sent otherwise (no new mail service is added here).
export type MailResult = "sent" | "no-smtp" | "no-nodemailer" | "failed";

export async function sendMailIfConfigured(to: string, subject: string, text: string): Promise<MailResult> {
  if (!process.env.SMTP_HOST || !to) return "no-smtp";
  let nm: any;
  try { nm = await import(/* optional */ "nodemailer" as string); } catch { return "no-nodemailer"; }
  try {
    const t = (nm.default || nm).createTransport({
      host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "1",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    return "sent";
  } catch (e: any) {
    console.error("mail failed:", e.message);
    return "failed";
  }
}
