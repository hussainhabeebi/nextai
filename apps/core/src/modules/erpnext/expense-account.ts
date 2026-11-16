import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { logger } from '../../lib/logger.js';
import { incrementUsage } from '../usage/usage.js';
import { erpContext, expenseLedgers, guessExpenseAccount, matchExpenseRule } from './mappers.js';

/**
 * Expense ledger for a typed or photographed expense, chosen from the company's real chart:
 * keyword rule → AI pick from the company's expense ledgers → Miscellaneous Expenses (last resort).
 * (Learned supplier mappings are applied by the callers before this.) Never throws: falls back to the plain guess.
 */
export async function chooseExpenseAccount(c: Container, tenant: Tenant, description: string): Promise<string> {
  const ctx = erpContext(tenant);
  let ledgers: string[] = [];
  try {
    ledgers = await expenseLedgers(c.erp(tenant), ctx, tenant.id);
  } catch (err) {
    logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'expense ledgers unavailable; using keyword guess');
  }
  if (ledgers.length === 0) return guessExpenseAccount(ctx, description);

  const rule = matchExpenseRule(ctx, description, ledgers);
  if (rule) return rule.account;

  if (c.ai.llm.chooseAccount && description.trim()) {
    try {
      const { account, usage } = await c.ai.llm.chooseAccount(description, ledgers, { country: tenant.country });
      await incrementUsage(c.prisma, tenant.id, { aiTokens: usage.tokens, aiCostMicros: usage.costMicros });
      if (account) return account;
    } catch (err) {
      logger.warn({ tenantId: tenant.id, err: (err as Error).message }, 'AI account choice failed');
    }
  }
  return guessExpenseAccount(ctx, description, ledgers); // Miscellaneous Expenses (or the chart's equivalent)
}
