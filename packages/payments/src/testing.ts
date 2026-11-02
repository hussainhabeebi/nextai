import type { BillingEvent, CheckoutRequest, PaymentProvider } from './index.js';

/** Test double: webhook "signature" must equal `valid`; body is a JSON BillingEvent. */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  checkouts: CheckoutRequest[] = [];
  cancelled: string[] = [];
  private seq = 0;

  async createCustomer(input: { tenantId: string }) {
    return { customerId: `cus_${input.tenantId.slice(0, 8)}` };
  }
  async createCheckout(req: CheckoutRequest) {
    this.checkouts.push(req);
    return { url: `https://checkout.stripe.test/${++this.seq}`, sessionId: `cs_${this.seq}` };
  }
  async createPortalSession(customerId: string) {
    return { url: `https://billing.stripe.test/${customerId}` };
  }
  async cancel(subscriptionId: string) {
    this.cancelled.push(subscriptionId);
  }
  async handleWebhook(rawBody: Buffer | string, signature: string): Promise<BillingEvent> {
    if (signature !== 'valid') throw new Error('Invalid signature');
    const evt = JSON.parse(rawBody.toString()) as BillingEvent & { currentPeriodEnd?: string | Date };
    if ('currentPeriodEnd' in evt && typeof evt.currentPeriodEnd === 'string') evt.currentPeriodEnd = new Date(evt.currentPeriodEnd);
    return evt as BillingEvent;
  }
}
