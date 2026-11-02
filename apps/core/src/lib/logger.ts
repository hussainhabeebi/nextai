import pino, { type LoggerOptions } from 'pino';

/** Paths that must never reach logs (PII + secrets). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers.api_access_token',
  'req.headers["stripe-signature"]',
  'req.headers["x-chatwoot-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.totp',
  '*.totpSecretEnc',
  '*.code',
  '*.apiKey',
  '*.apiSecret',
  '*.erpApiKeyEnc',
  '*.erpApiSecretEnc',
  '*.cwBotTokenEnc',
  '*.botToken',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.phone',
  '*.email',
];

export function loggerOptions(level = process.env.LOG_LEVEL ?? 'info'): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: process.env.SERVICE_NAME ?? 'core' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export const logger = pino(loggerOptions());
