-- Align plan codes with the published pricing (Base / Growth / Pro).
ALTER TYPE "PlanCode" RENAME VALUE 'starter' TO 'base';
ALTER TYPE "PlanCode" RENAME VALUE 'business' TO 'growth';
UPDATE plans SET name = 'Base' WHERE code = 'base';
UPDATE plans SET name = 'Growth' WHERE code = 'growth';
