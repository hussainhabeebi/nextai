import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { StripeProvider, tenantStatusFor } from './index.js';

describe('payments', () => {
  it('maps subscription statuses to tenant status', () => {
    expect(tenantStatusFor('trialing')).toBe('trial');
    expect(tenantStatusFor('active')).toBe('active');
    expect(tenantStatusFor('past_due')).toBe('past_due');
    expect(tenantStatusFor('canceled')).toBe('suspended');
  });

  it('verifies stripe signatures and normalises events', async () => {
    const secret = 'whsec_test';
    const stripe = new Stripe('sk_test_x');
    const provider = new StripeProvider('sk_test_x', secret, stripe);
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', object: 'checkout.session', client_reference_id: 'tenant-1', customer: 'cus_1', subscription: 'sub_1', metadata: {} } },
    });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    const evt = await provider.handleWebhook(payload, header);
    expect(evt).toEqual({ kind: 'checkout_completed', eventId: 'evt_1', tenantId: 'tenant-1', customerId: 'cus_1', subscriptionId: 'sub_1' });
    await expect(provider.handleWebhook(payload, 't=1,v1=bad')).rejects.toThrow();
  });
});
