// Stand-in for a feature that is not part of this edition (publishing apps through a Cloudflare tunnel). The feature is off.

import { NextResponse } from 'next/server';

const body = { success: false, error: 'The gateway (publishing apps through a tunnel) is not part of this edition' };

export async function GET() {
  return NextResponse.json(body, { status: 501 });
}

export async function POST() {
  return NextResponse.json(body, { status: 501 });
}
