import { z } from "zod";

const timestamp = z.number().finite().min(0).max(8640000000000000);
export const authIndexSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
export const healthSchema = z.enum([
  "unknown",
  "active",
  "pending",
  "refreshing",
  "error",
  "disabled",
]);
export const reasonSchema = z.enum([
  "unknown",
  "credential_quota",
  "quota",
  "cloudflare_challenge",
  "model_not_supported",
  "invalid_grant",
  "unauthorized",
  "payment_required",
  "not_found",
  "transient_error",
]);
const windowSchema = z.object({
  limitId: z.string().max(256),
  label: z.string().max(80),
  usedPercent: z.number().finite().min(0).max(100).nullable(),
  minutes: z.number().finite().positive().nullable(),
  resetAt: timestamp.nullable(),
  description: z.string().max(240).optional(),
});
const observationSchema = z.object({
  observedAt: timestamp.nullable(),
  windows: z.array(windowSchema).max(24),
  activeLimit: z.string().max(80).nullable(),
  limits: z
    .array(
      z.object({
        id: z.string().max(256),
        name: z.string().max(80),
        allowed: z.boolean().nullable(),
        limitReached: z.boolean().nullable(),
      }),
    )
    .max(24),
  credits: z
    .object({
      hasCredits: z.boolean().nullable(),
      unlimited: z.boolean().nullable(),
      balance: z.number().finite().min(0).nullable(),
    })
    .nullable(),
});
export const bankSchema = z.object({
  available: z.number().int().nonnegative().nullable(),
  applicable: z.number().int().nonnegative().nullable(),
  expiries: z.array(timestamp).max(100),
  error: z.string().max(160).nullable(),
});
const liveSchema = z.object({
  status: z.enum(["fresh", "error", "unsupported"]),
  attemptedAt: timestamp,
  error: z.string().max(160).nullable(),
  observation: observationSchema.nullable(),
  bank: bankSchema.nullable(),
});
export const actionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("set-disabled"), accountId: authIndexSchema, disabled: z.boolean() })
    .strict(),
  z.object({ kind: z.literal("refresh-auth"), accountId: authIndexSchema }).strict(),
  z.object({ kind: z.literal("consume-reset"), accountId: authIndexSchema }).strict(),
]);
export type Action = z.infer<typeof actionSchema>;
export const actionResultSchema = z.object({
  status: z.enum(["success", "success-refresh-failed", "uncertain", "rejected", "busy"]),
  message: z.string().max(240),
});
export type ActionResult = z.infer<typeof actionResultSchema>;
export const snapshotSchema = z.object({
  fetchedAt: timestamp,
  omitted: z.number().int().min(0),
  accounts: z
    .array(
      z.object({
        id: authIndexSchema,
        name: z.string().max(80),
        provider: z.string().max(32),
        health: healthSchema,
        disabled: z.boolean().nullable(),
        unavailable: z.boolean().nullable(),
        observation: observationSchema,
        live: liveSchema.optional(),
        actions: z
          .object({ status: z.boolean(), refreshAuth: z.boolean(), bankReset: z.boolean() })
          .optional(),
        models: z
          .array(
            z.object({
              name: z.string().max(80),
              observation: observationSchema,
            }),
          )
          .max(24),
        cooldowns: z
          .array(
            z.object({
              scope: z.enum(["credential", "model"]),
              model: z.string().max(80).nullable(),
              reason: reasonSchema,
              retryAt: timestamp,
            }),
          )
          .max(24)
          .nullable(),
        retryAt: timestamp.nullable(),
        detailsOmitted: z.boolean(),
      }),
    )
    .max(300),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Account = Snapshot["accounts"][number];
export type Observation = Account["observation"];
export type QuotaWindow = Observation["windows"][number];
export function hasQuotaSignals(observation: Observation): boolean {
  return (
    observation.windows.some((window) => window.usedPercent !== null) ||
    observation.limits.some((limit) => limit.allowed !== null || limit.limitReached !== null) ||
    observation.credits !== null
  );
}
