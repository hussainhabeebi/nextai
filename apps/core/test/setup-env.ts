process.env.NODE_ENV = 'test';
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
process.env.JWT_SECRET ??= 'test-jwt-secret-test-jwt-secret-1234567890';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-test-refresh-secret-123';
process.env.CHATWOOT_WEBHOOK_SECRET ??= 'test-chatwoot-secret-0123456789';
process.env.CHATWOOT_ALLOWED_IPS ??= '127.0.0.1';
process.env.ADMIN_BOOTSTRAP_PASSWORD ??= 'admin-password-123';
process.env.LOG_LEVEL = 'silent';
