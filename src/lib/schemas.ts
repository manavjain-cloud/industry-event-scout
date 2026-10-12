import { z } from "zod";
import { isValidTimezone } from "@/lib/dates/tz";

const listItem = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min, `Each entry needs at least ${min} characters`)
    .max(max, `Each entry can be at most ${max} characters`)
    .refine((v) => !/[<>]/.test(v), "Angle brackets are not allowed");

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = v.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Validated input for PUT /api/preferences (runtime validation of user-controlled settings). */
export const preferencesInputSchema = z.object({
  recipientEmail: z
    .union([z.string().trim().email("Enter a valid email address").max(254), z.literal(""), z.null()])
    .transform((v) => (v ? v : null)),
  timezone: z.string().trim().refine(isValidTimezone, "Unknown timezone (use an IANA name such as Asia/Kolkata)"),
  focusAreas: z.array(listItem(2, 80)).min(1, "Add at least one focus area").max(12).transform(dedupeCaseInsensitive),
  cities: z.array(listItem(2, 60)).min(1, "Add at least one city").max(10).transform(dedupeCaseInsensitive),
  windowDays: z.number().int().min(7).max(60),
  maxDigestEvents: z.number().int().min(3).max(25),
  weeklyEnabled: z.boolean(),
});

export type PreferencesInput = z.infer<typeof preferencesInputSchema>;

export const loginInputSchema = z.object({ password: z.string().min(1).max(200) });
