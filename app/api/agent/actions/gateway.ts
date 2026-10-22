// Stand-in for a feature that is not part of this edition (publishing apps through a Cloudflare tunnel). The feature is off.

const unavailable = { success: false, error: 'The gateway (publishing apps through a tunnel) is not part of this edition' };

export async function list(_body: unknown, _auth: unknown): Promise<unknown> {
  return { services: [], lastUpdated: new Date(0).toISOString() };
}
export async function expose(_body: unknown, _auth: unknown): Promise<unknown> {
  return unavailable;
}
export async function remove(_body: unknown, _auth: unknown): Promise<unknown> {
  return unavailable;
}
export async function lock(_body: unknown, _auth: unknown): Promise<unknown> {
  return unavailable;
}
export async function unlock(_body: unknown, _auth: unknown): Promise<unknown> {
  return unavailable;
}
export async function status(_body: unknown, _auth: unknown): Promise<unknown> {
  return { tunnel: 'not available in this edition' };
}
