import { createHash } from "node:crypto";
import { Resend } from "resend";
import { errorMessage } from "@/lib/log";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend de-duplicates requests carrying the same key (safe retries). */
  idempotencyKey: string;
}

export type MailErrorKind = "auth" | "validation" | "rate_limit" | "recipient_not_allowed" | "server" | "network";

export class MailError extends Error {
  constructor(
    message: string,
    public readonly kind: MailErrorKind,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export interface Mailer {
  /** Resolves with the provider's delivery reference only when Resend accepted the message. */
  send(message: MailMessage): Promise<{ id: string }>;
}

/** Idempotency key = run identity + content hash: a retry of the same digest is de-duplicated by Resend. */
export function idempotencyKeyFor(runKey: string, subject: string, html: string): string {
  const hash = createHash("sha256").update(`${subject}\n${html}`).digest("hex").slice(0, 16);
  return `digest/${runKey}/${hash}`.slice(0, 256);
}

function classify(name: string, message: string, status: number | null): MailError {
  const text = `${name} ${message}`;
  if (status === 401 || status === 403 || /api_key|restricted_api_key|missing_api_key/i.test(name)) {
    if (/only send testing emails to your own email|verify a domain|not verified|domain is not/i.test(text)) {
      return new MailError(`Resend refused the recipient or sender: ${message}`, "recipient_not_allowed", status ?? undefined);
    }
    return new MailError(`Resend rejected the API key: ${message}`, "auth", status ?? undefined);
  }
  if (/only send testing emails to your own email|verify a domain|domain is not verified/i.test(text)) {
    return new MailError(`Resend refused the recipient or sender (verify a domain to send to others): ${message}`, "recipient_not_allowed", status ?? undefined);
  }
  if (status === 429 || /rate_limit/i.test(name)) return new MailError(`Resend rate limit: ${message}`, "rate_limit", status ?? undefined);
  if (status !== null && status >= 500) return new MailError(`Resend server error: ${message}`, "server", status);
  return new MailError(`Resend rejected the email: ${message}`, "validation", status ?? undefined);
}

export function createResendMailer(opts: { apiKey: string; from: string }): Mailer {
  const resend = new Resend(opts.apiKey);
  return {
    async send(message) {
      let result;
      try {
        result = await resend.emails.send(
          {
            from: opts.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
          },
          { idempotencyKey: message.idempotencyKey },
        );
      } catch (err) {
        throw new MailError(`Could not reach Resend: ${errorMessage(err)}`, "network");
      }
      if (result.error) throw classify(String(result.error.name), result.error.message, result.error.statusCode);
      if (!result.data?.id) throw new MailError("Resend did not return a message id; delivery cannot be confirmed.", "server");
      return { id: result.data.id };
    },
  };
}
