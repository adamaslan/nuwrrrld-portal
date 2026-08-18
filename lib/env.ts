import { z } from "zod";

const envSchema = z.object({
  // Clerk (auth)
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),

  // Stripe
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  STRIPE_PRICE_MONTHLY: z.string().min(1),
  STRIPE_PRICE_ANNUAL: z.string().min(1),

  // AI providers
  OPENROUTER_API_KEY: z.string().min(1),

  // Database
  DATABASE_URL: z.string().url(),

  // Internal auth
  PORTAL_PUSH_SECRET: z.string().min(1),
  CRON_SECRET: z.string().min(1),
  IP_HASH_SECRET: z.string().min(1),

  // Optional
  MCP_BACKEND_URL: z.string().url().optional(),
  // Points at holdemfoldemapp's backend (holdemfoldem-api Cloud Run service),
  // deliberately separate from MCP_BACKEND_URL (gcp3-backend) — per-ticker
  // analysis and the batch /signals feed are two different upstream services.
  MCP_ANALYZE_URL: z.string().url().optional(),
  RESEND_API_KEY: z.string().optional(),
  DISCORD_FEEDBACK_WEBHOOK_URL: z.string().url().optional(),
  SIGNALS_ENGINE_URL: z.string().url().optional(),
  NULOGDASH_ADMIN_EMAILS: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
});

let _env: z.infer<typeof envSchema>;

function parseEnv(): z.infer<typeof envSchema> {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Missing or invalid environment variables:\n${missing}`);
  }
  _env = result.data;
  return _env;
}

export const env = new Proxy({} as z.infer<typeof envSchema>, {
  get(_target, key: string) {
    return parseEnv()[key as keyof z.infer<typeof envSchema>];
  },
});
