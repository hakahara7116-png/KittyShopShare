import Stripe from 'stripe';
import { env } from '../env.js';
import type { AccountStatus, CartRef, KittyEvent, PaymentProvider, VerifiedEvent } from './types.js';

let client: Stripe | null = null;
const stripe = () => (client ??= new Stripe(env('STRIPE_SECRET_KEY'), { maxNetworkRetries: 2, appInfo: { name: 'Kitty' } }));

const DEFAULT_AUTH_WINDOW_MS = 7 * 24 * 3600 * 1000;
const refOf = (md: Stripe.Metadata | null | undefined): Partial<CartRef> => ({
  groupOrderId: md?.group_order_id, cartId: md?.cart_id, attemptId: md?.attempt_id,
});
function accountStatus(a: Stripe.Account): AccountStatus {
  const active = !!a.charges_enabled && !!a.payouts_enabled;
  return {
    accountId: a.id,
    status: active ? 'active' : a.requirements?.disabled_reason ? 'restricted' : 'pending',
    capabilities: { card_payments: !!a.charges_enabled, payouts: !!a.payouts_enabled, delayed_capture: !!a.charges_enabled, details_submitted: !!a.details_submitted },
  };
}
const retryable = (e: any) => ['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'].includes(e?.type);

/**
 * Stripe Connect with Standard accounts and direct charges: the vendor is merchant of record,
 * Kitty creates Checkout Sessions on the vendor's account (Stripe-Account header) with manual capture
 * and takes an application fee. Verify field names against Stripe's current API reference before going live.
 */
export const stripeProvider: PaymentProvider = {
  key: 'stripe',

  async createOnboardingLink({ existingAccountId, businessName, vendorId, returnUrl, refreshUrl }) {
    const accountId = existingAccountId ?? (await stripe().accounts.create({
      type: 'standard', business_profile: { name: businessName }, metadata: { kitty_vendor_id: vendorId },
    }, { idempotencyKey: `kitty-account-${vendorId}` })).id;
    const link = await stripe().accountLinks.create({ account: accountId, type: 'account_onboarding', return_url: returnUrl, refresh_url: refreshUrl });
    return { accountId, url: link.url };
  },

  async getAccountStatus(accountId) {
    return accountStatus(await stripe().accounts.retrieve(accountId));
  },

  async createHostedCheckout({ accountId, amount, currency, feeAmount, description, ref, successUrl, cancelUrl, idempotencyKey }) {
    const metadata = { group_order_id: ref.groupOrderId, cart_id: ref.cartId, attempt_id: ref.attemptId };
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000); // Stripe requires at least 30 minutes
    const s = await stripe().checkout.sessions.create({
      mode: 'payment', // payment methods come from the vendor's Dashboard settings; keep only ones that support manual capture
      line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: description } } }],
      payment_intent_data: { capture_method: 'manual', application_fee_amount: feeAmount, metadata },
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
    }, { stripeAccount: accountId, idempotencyKey });
    return { sessionId: s.id, url: s.url!, expiresAt };
  },

  async capture({ accountId, authId, idempotencyKey }) {
    try {
      const pi = await stripe().paymentIntents.capture(authId, {}, { stripeAccount: accountId, idempotencyKey });
      return { ok: true, captureId: typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id ?? pi.id };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'capture failed', retryable: retryable(e) };
    }
  },

  async void({ accountId, authId, idempotencyKey }) {
    try {
      await stripe().paymentIntents.cancel(authId, { cancellation_reason: 'requested_by_customer' }, { stripeAccount: accountId, idempotencyKey });
    } catch (e: any) {
      if (e?.code === 'payment_intent_unexpected_state') return; // already canceled or expired
      throw e;
    }
  },

  async refund({ accountId, authId, idempotencyKey }) {
    const r = await stripe().refunds.create({ payment_intent: authId, refund_application_fee: true }, { stripeAccount: accountId, idempotencyKey });
    return { refundId: r.id };
  },

  async netCollected({ accountId, authId }) {
    const pi = await stripe().paymentIntents.retrieve(authId, { expand: ['latest_charge'] }, { stripeAccount: accountId });
    const ch = pi.latest_charge as Stripe.Charge | null;
    return (pi.amount_received ?? 0) - (ch?.amount_refunded ?? 0);
  },

  verifyWebhook(headers, rawBody) {
    const sig = headers.get('stripe-signature');
    if (!sig) throw new Error('missing signature');
    const secrets = [process.env.STRIPE_CONNECT_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET].filter(Boolean) as string[];
    for (const secret of secrets) {
      try {
        const ev = stripe().webhooks.constructEvent(rawBody, sig, secret);
        return { id: ev.id, type: ev.type, accountId: ev.account ?? null, payload: ev };
      } catch { /* try the next secret */ }
    }
    throw new Error('bad signature');
  },

  async normalizeEvent(e: VerifiedEvent): Promise<KittyEvent> {
    const ev = e.payload as Stripe.Event;
    const obj: any = ev.data.object;
    switch (ev.type) {
      case 'account.updated':
        return { type: 'account.updated', account: accountStatus(obj as Stripe.Account) };
      case 'account.application.deauthorized':
        return { type: 'account.deauthorized', accountId: e.accountId ?? '' };
      case 'payment_intent.amount_capturable_updated': {
        // Re-read the PaymentIntent for card details and the exact authorization expiry.
        const pi = await stripe().paymentIntents.retrieve(obj.id, { expand: ['latest_charge'] }, { stripeAccount: e.accountId! });
        const card = (pi.latest_charge as Stripe.Charge | null)?.payment_method_details?.card;
        const expiresAt = card?.capture_before ? new Date(card.capture_before * 1000) : new Date(Date.now() + DEFAULT_AUTH_WINDOW_MS);
        return { type: 'checkout.authorized', ref: refOf(pi.metadata), authId: pi.id, expiresAt, brand: card?.brand ?? null, last4: card?.last4 ?? null, amount: pi.amount_capturable };
      }
      case 'payment_intent.payment_failed':
        return { type: 'checkout.declined', ref: refOf(obj.metadata), authId: obj.id, reason: obj.last_payment_error?.message ?? null };
      case 'payment_intent.canceled':
        return obj.cancellation_reason === 'automatic'
          ? { type: 'authorization.expired', ref: refOf(obj.metadata), authId: obj.id }
          : { type: 'authorization.voided', ref: refOf(obj.metadata), authId: obj.id };
      case 'payment_intent.succeeded':
        return { type: 'capture.succeeded', ref: refOf(obj.metadata), authId: obj.id, amount: obj.amount_received };
      case 'charge.refunded':
        return { type: 'refund.succeeded', authId: obj.payment_intent, amount: obj.amount_refunded };
      case 'checkout.session.expired':
        return { type: 'checkout.expired', ref: refOf(obj.metadata), sessionId: obj.id };
      default:
        return { type: 'ignored' };
    }
  },
};
