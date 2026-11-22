-- Bill-entry limits per plan: Base 200, Growth 1000, Pro 5000 per month (was 100 / 500 / 2000).
-- Only plans still at the old default are changed, so values edited in Admin → Plans are kept.
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{ocrPagesPerMonth}', '200')
  WHERE code = 'base' AND (limits::jsonb ->> 'ocrPagesPerMonth')::int = 100;
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{ocrPagesPerMonth}', '1000')
  WHERE code = 'growth' AND (limits::jsonb ->> 'ocrPagesPerMonth')::int = 500;
UPDATE plans SET limits = jsonb_set(limits::jsonb, '{ocrPagesPerMonth}', '5000')
  WHERE code = 'pro' AND (limits::jsonb ->> 'ocrPagesPerMonth')::int = 2000;
