import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');
const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8090),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:3010'),
  API_URL: z.string().url().default('http://localhost:8090'),
  CORS_ORIGINS: csv,
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'ENCRYPTION_KEY must be 32 bytes base64'),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  CHATWOOT_BASE_URL: z.string().url().default('https://app.aiingo.com'),
  CHATWOOT_WEBHOOK_SECRET: z.string().min(16),
  CHATWOOT_ALLOWED_IPS: csv,
  CHATWOOT_ATTACHMENT_HOSTS: csv,
  CHATWOOT_PLATFORM_TOKEN: z.string().optional(),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default('nextai'),
  AI_VISION_PROVIDER: z.string().default('mock'),
  AI_VISION_API_KEY: z.string().optional(),
  AI_STT_PROVIDER: z.string().default('mock'),
  AI_STT_API_KEY: z.string().optional(),
  AI_LLM_PROVIDER: z.string().default('mock'),
  AI_LLM_API_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  PROVISIONER_URL: z.string().optional(),
  PROVISIONER_SECRET: z.string().optional(),
  ADMIN_BOOTSTRAP_EMAIL: z.string().email().optional(),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  /** Use in-memory fakes for ERPNext/Chatwoot (local dev without external systems). */
  MOCK_EXTERNALS: bool,
  DOCS_PUBLIC: bool,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
export const resetEnvCache = (): void => {
  cached = undefined;
};
export const isProd = (): boolean => env().NODE_ENV === 'production';
