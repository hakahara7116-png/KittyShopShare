export function splitEvenly(total: number, n: number): number[] {
  const base = Math.floor(total / n), rem = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0)); // leftover cents go to the earliest carts
}
export const feeFor = (amount: number, bps: number) => Math.round((amount * bps) / 10000);
export type DeliveryMethod = 'doordash' | 'uber' | 'pickup';
export function deliveryOption(vendorDelivery: any, method: DeliveryMethod): { fee: number; label: string } | null {
  const o = vendorDelivery?.[method];
  if (!o?.on) return null;
  const label = method === 'doordash' ? 'DoorDash' : method === 'uber' ? 'Uber' : 'In-store pickup';
  return { fee: method === 'pickup' ? 0 : Math.max(0, Math.round(o.fee ?? 0)), label };
}
