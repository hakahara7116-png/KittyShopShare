export type CourierStatus = 'requested' | 'picked_up' | 'delivered' | 'failed' | 'cancelled';
export interface DeliveryRequest {
  externalId: string;                 // the cart id
  pickup: { name: string; address: string; phone: string };
  dropoff: { name: string; address: string; phone: string };
  description: string;
  valueCents: number;
}
export interface Courier {
  key: 'doordash' | 'uber';
  configured(): boolean;
  create(req: DeliveryRequest): Promise<{ externalId: string; trackingUrl: string | null; status: CourierStatus }>;
  status(externalId: string): Promise<CourierStatus>;
}
