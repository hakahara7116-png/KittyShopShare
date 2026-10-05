/** The adapter contract from the architecture doc. One implementation per payment provider. */
export interface CartRef { groupOrderId: string; cartId: string; attemptId: string }

export interface OnboardingLink { accountId: string; url: string }
export interface AccountStatus {
  accountId: string;
  status: 'pending' | 'restricted' | 'active';
  capabilities: { card_payments: boolean; payouts: boolean; delayed_capture: boolean; details_submitted: boolean };
}
export interface HostedCheckout { sessionId: string; url: string; expiresAt: Date }
export type CaptureResult = { ok: true; captureId: string } | { ok: false; error: string; retryable: boolean };

/** Provider events, normalized to Kitty's names. */
export type KittyEvent =
  | { type: 'account.updated'; account: AccountStatus }
  | { type: 'account.deauthorized'; accountId: string }
  | { type: 'checkout.authorized'; ref: Partial<CartRef>; authId: string; expiresAt: Date; brand: string | null; last4: string | null; amount: number }
  | { type: 'checkout.declined'; ref: Partial<CartRef>; authId: string | null; reason: string | null }
  | { type: 'checkout.expired'; ref: Partial<CartRef>; sessionId: string }
  | { type: 'authorization.expired'; ref: Partial<CartRef>; authId: string }
  | { type: 'authorization.voided'; ref: Partial<CartRef>; authId: string }
  | { type: 'capture.succeeded'; ref: Partial<CartRef>; authId: string; amount: number }
  | { type: 'refund.succeeded'; authId: string; amount: number }
  | { type: 'ignored' };

export interface VerifiedEvent { id: string; type: string; accountId: string | null; payload: unknown }

export interface PaymentProvider {
  key: 'stripe' | 'paypal' | 'adyen';
  createOnboardingLink(input: { existingAccountId: string | null; businessName: string; vendorId: string; returnUrl: string; refreshUrl: string }): Promise<OnboardingLink>;
  getAccountStatus(accountId: string): Promise<AccountStatus>;
  createHostedCheckout(input: {
    accountId: string; amount: number; currency: string; feeAmount: number; description: string;
    ref: CartRef; successUrl: string; cancelUrl: string; idempotencyKey: string;
  }): Promise<HostedCheckout>;
  capture(input: { accountId: string; authId: string; idempotencyKey: string }): Promise<CaptureResult>;
  void(input: { accountId: string; authId: string; idempotencyKey: string }): Promise<void>;
  refund(input: { accountId: string; authId: string; idempotencyKey: string }): Promise<{ refundId: string }>;
  /** What the provider currently says was captured minus refunded for this authorization (reconciliation). */
  netCollected(input: { accountId: string; authId: string }): Promise<number>;
  verifyWebhook(headers: Headers, rawBody: string): VerifiedEvent;
  normalizeEvent(event: VerifiedEvent): Promise<KittyEvent>;
}
