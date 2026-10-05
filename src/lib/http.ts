export class HttpError extends Error {
  constructor(public status: number, message: string, public data?: Record<string, unknown>) { super(message); }
}
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
export const redirect = (location: string) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
export async function body<T = any>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, 'Expected a JSON body.'); }
}
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, ...(e.data ?? {}) }, e.status);
  console.error(e);
  return json({ error: 'Something went wrong. Try again.' }, 500);
}
export function assert(cond: unknown, status: number, message: string): asserts cond {
  if (!cond) throw new HttpError(status, message);
}
