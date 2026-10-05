export function env(name: string, required = true): string {
  const v = process.env[name];
  if ((v === undefined || v === '') && required) throw new Error(`Missing environment variable ${name}`);
  return v ?? '';
}
export const isLocalDev = () => process.env.NETLIFY_DEV === 'true' || process.env.CONTEXT === 'dev';
export const feeBps = () => Number(process.env.PLATFORM_FEE_BPS ?? 300);
