-- India pricing, per month excl. 18% GST: Base ₹799, Growth ₹1,999, Pro ₹4,999 (were placeholders 999 / 2499 / 5999).
-- Only plans still at the old placeholder are changed, so prices edited in Admin → Plans are kept.
UPDATE plans SET price_monthly = jsonb_set(price_monthly::jsonb, '{INR}', '799')
  WHERE code = 'base' AND (price_monthly::jsonb ->> 'INR')::numeric = 999;
UPDATE plans SET price_monthly = jsonb_set(price_monthly::jsonb, '{INR}', '1999')
  WHERE code = 'growth' AND (price_monthly::jsonb ->> 'INR')::numeric = 2499;
UPDATE plans SET price_monthly = jsonb_set(price_monthly::jsonb, '{INR}', '4999')
  WHERE code = 'pro' AND (price_monthly::jsonb ->> 'INR')::numeric = 5999;
