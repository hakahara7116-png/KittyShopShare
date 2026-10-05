import { doordash } from './doordash.js';
import type { Courier } from './types.js';
import { uber } from './uber.js';

export const couriers: Record<string, Courier> = { doordash, uber };
