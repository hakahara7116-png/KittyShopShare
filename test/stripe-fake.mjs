// Fake Stripe client: same method shapes the adapter uses, state kept in memory.
export const state = globalThis.__stripe ??= { accounts: {}, pis: {}, sessions: {}, failCaptureOn: null, calls: [], idem: {} };
const id = p => `${p}_${++globalThis.__n}`; globalThis.__n ??= 0;
function idem(opts, fn) { const k = opts?.idempotencyKey; if (k && state.idem[k]) return state.idem[k]; const r = fn(); if (k) state.idem[k] = r; return r; }
export default class Stripe {
  constructor() {
    this.accounts = {
      create: async (p, o) => idem(o, () => { const a = { id: id('acct'), charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: {} }; state.accounts[a.id] = a; return a; }),
      retrieve: async (aid) => state.accounts[aid],
    };
    this.accountLinks = { create: async (p) => ({ url: `https://connect.stripe.test/setup/${p.account}?return=${encodeURIComponent(p.return_url)}` }) };
    this.checkout = { sessions: { create: async (p, o) => idem(o, () => {
      state.calls.push(['session', o.stripeAccount, p.payment_intent_data.capture_method, p.payment_intent_data.application_fee_amount, p.line_items[0].price_data.unit_amount]);
      const pi = { id: id('pi'), amount: p.line_items[0].price_data.unit_amount, amount_capturable: 0, amount_received: 0, status: 'requires_payment_method', metadata: p.payment_intent_data.metadata, account: o.stripeAccount, refunded: 0 };
      state.pis[pi.id] = pi; const s = { id: id('cs'), url: `https://checkout.stripe.test/${pi.id}`, payment_intent: pi.id, metadata: p.metadata, success_url: p.success_url }; state.sessions[s.id] = s; return s; }) } };
    this.paymentIntents = {
      retrieve: async (pid) => { const pi = state.pis[pid]; return { ...pi, latest_charge: { amount_refunded: pi.refunded, payment_method_details: { card: { brand: 'visa', last4: '4242', capture_before: Math.floor(Date.now() / 1000) + 7 * 86400 } } } }; },
      capture: async (pid, _p, o) => idem(o, () => { state.calls.push(['capture', pid]); const pi = state.pis[pid];
        if (state.failCaptureOn === pid) { const e = new Error('Your card was declined.'); e.type = 'StripeCardError'; throw e; }
        pi.status = 'succeeded'; pi.amount_received = pi.amount; return { ...pi, latest_charge: 'ch_' + pid }; }),
      cancel: async (pid, p, o) => idem(o, () => { state.calls.push(['cancel', pid]); state.pis[pid].status = 'canceled'; return state.pis[pid]; }),
    };
    this.refunds = { create: async (p, o) => idem(o, () => { state.calls.push(['refund', p.payment_intent]); state.pis[p.payment_intent].refunded = state.pis[p.payment_intent].amount_received; return { id: id('re') }; }) };
    this.webhooks = { constructEvent: (raw, sig) => { if (sig !== 'valid') throw new Error('bad sig'); return JSON.parse(raw); } };
  }
}
// helpers to simulate the shopper completing checkout and Stripe sending events
export function authorize(pid) { const pi = state.pis[pid]; pi.status = 'requires_capture'; pi.amount_capturable = pi.amount; return pi; }
export function event(type, obj, account) { return { id: id('evt'), type, account, data: { object: obj } }; }
