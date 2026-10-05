import { HttpError } from '../http.js';
import { stripeProvider } from './stripe.js';
import type { PaymentProvider } from './types.js';

// PayPal and Adyen adapters implement the same interface; add them here when built.
const providers: Record<string, PaymentProvider> = { stripe: stripeProvider };

export function provider(key: string): PaymentProvider {
  const p = providers[key];
  if (!p) throw new HttpError(400, `Payment provider "${key}" isn't available yet.`);
  return p;
}
export const availableProviders = () => Object.keys(providers);
