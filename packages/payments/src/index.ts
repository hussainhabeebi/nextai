import Stripe from 'stripe';

export type ProviderName = 'stripe' | 'razorpay';

export interface CheckoutRequest {
  tenantId: string;
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  trialDays?: number;
}

/** Provider-neutral billing event produced from a verified webhook. */
export type BillingEvent =
  | { kind: 'checkout_completed'; eventId: string; tenantId?: string; customerId: string; subscriptionId?: string }
  | {
      kind: 'subscription_updated';
      eventId: string;
      tenantId?: string;
      customerId: string;
      subscriptionId: string;
      status: string; // trialing | active | past_due | canceled | unpaid | incomplete ...
      priceId?: string;
      currentPeriodEnd?: Date;
      cancelAtPeriodEnd: boolean;
    }
  | { kind: 'subscription_deleted'; eventId: string; customerId: string; subscriptionId: string }
  | { kind: 'invoice_paid'; eventId: string; customerId: string; subscriptionId?: string }
  | { kind: 'invoice_payment_failed'; eventId: string; customerId: string; subscriptionId?: string }
  | { kind: 'ignored'; eventId: string; type: string };

export interface PaymentProvider {
  readonly name: ProviderName;
  createCustomer(input: { tenantId: string; name: string; email?: string; phone?: string }): Promise<{ customerId: string }>;
  createCheckout(req: CheckoutRequest): Promise<{ url: string; sessionId: string }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  cancel(subscriptionId: string, atPeriodEnd?: boolean): Promise<void>;
  /** Verify signature and normalise. Throws on invalid signature. */
  handleWebhook(rawBody: Buffer | string, signature: string): Promise<BillingEvent>;
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
    client?: Stripe,
  ) {
    this.stripe = client ?? new Stripe(secretKey, { typescript: true });
  }

  async createCustomer(input: { tenantId: string; name: string; email?: string; phone?: string }) {
    const c = await this.stripe.customers.create(
      { name: input.name, email: input.email, phone: input.phone, metadata: { tenant_id: input.tenantId } },
      { idempotencyKey: `customer-${input.tenantId}` },
    );
    return { customerId: c.id };
  }

  async createCheckout(req: CheckoutRequest) {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: req.customerId,
      client_reference_id: req.tenantId,
      line_items: [{ price: req.priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: req.trialDays,
        metadata: { tenant_id: req.tenantId },
      },
      metadata: { tenant_id: req.tenantId },
      success_url: req.successUrl,
      cancel_url: req.cancelUrl,
      allow_promotion_codes: true,
    });
    if (!session.url) throw new Error('Stripe checkout session has no URL');
    return { url: session.url, sessionId: session.id };
  }

  async createPortalSession(customerId: string, returnUrl: string) {
    const s = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { url: s.url };
  }

  async cancel(subscriptionId: string, atPeriodEnd = true) {
    if (atPeriodEnd) await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
    else await this.stripe.subscriptions.cancel(subscriptionId);
  }

  async handleWebhook(rawBody: Buffer | string, signature: string): Promise<BillingEvent> {
    const evt = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    return normalizeStripeEvent(evt);
  }
}

const idOf = (v: string | { id: string } | null | undefined): string | undefined =>
  typeof v === 'string' ? v : v?.id;

export function normalizeStripeEvent(evt: Stripe.Event): BillingEvent {
  switch (evt.type) {
    case 'checkout.session.completed': {
      const s = evt.data.object;
      return {
        kind: 'checkout_completed',
        eventId: evt.id,
        tenantId: s.client_reference_id ?? s.metadata?.tenant_id,
        customerId: idOf(s.customer) ?? '',
        subscriptionId: idOf(s.subscription),
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = evt.data.object;
      const item = sub.items.data[0];
      const periodEnd = (item as unknown as { current_period_end?: number })?.current_period_end ??
        (sub as unknown as { current_period_end?: number }).current_period_end;
      return {
        kind: 'subscription_updated',
        eventId: evt.id,
        tenantId: sub.metadata?.tenant_id,
        customerId: idOf(sub.customer) ?? '',
        subscriptionId: sub.id,
        status: sub.status,
        priceId: item?.price.id,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
      };
    }
    case 'customer.subscription.deleted': {
      const sub = evt.data.object;
      return { kind: 'subscription_deleted', eventId: evt.id, customerId: idOf(sub.customer) ?? '', subscriptionId: sub.id };
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const inv = evt.data.object as Stripe.Invoice & { subscription?: string | { id: string } | null };
      const subId =
        idOf(inv.subscription) ??
        idOf((inv as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent?.subscription_details?.subscription);
      return {
        kind: evt.type === 'invoice.paid' ? 'invoice_paid' : 'invoice_payment_failed',
        eventId: evt.id,
        customerId: idOf(inv.customer) ?? '',
        subscriptionId: subId,
      };
    }
    default:
      return { kind: 'ignored', eventId: evt.id, type: evt.type };
  }
}

/**
 * Razorpay (India) – stub. Implement with Razorpay Subscriptions API + webhook HMAC (X-Razorpay-Signature).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  private nope(): never {
    throw new Error('RazorpayProvider is not implemented yet');
  }
  createCustomer(): Promise<{ customerId: string }> {
    return Promise.reject(this.nope());
  }
  createCheckout(): Promise<{ url: string; sessionId: string }> {
    return Promise.reject(this.nope());
  }
  createPortalSession(): Promise<{ url: string }> {
    return Promise.reject(this.nope());
  }
  cancel(): Promise<void> {
    return Promise.reject(this.nope());
  }
  handleWebhook(): Promise<BillingEvent> {
    return Promise.reject(this.nope());
  }
}

/** Map a provider subscription status to the tenant lifecycle status. */
export function tenantStatusFor(subStatus: string): 'trial' | 'active' | 'past_due' | 'suspended' {
  switch (subStatus) {
    case 'trialing':
      return 'trial';
    case 'active':
      return 'active';
    case 'past_due':
    case 'incomplete':
      return 'past_due';
    default:
      return 'suspended'; // canceled, unpaid, incomplete_expired, paused
  }
}
