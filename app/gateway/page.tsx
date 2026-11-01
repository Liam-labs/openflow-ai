import Link from 'next/link';

export default function GatewayPage() {
  return <main className="max-w-2xl mx-auto px-6 py-16">
    <h1 className="text-2xl font-semibold mb-4">Gateway publishing is not available in this edition</h1>
    <p className="text-muted mb-6">This installation does not include publishing apps through Cloudflare tunnels. No service has been exposed by this page.</p>
    <Link href="/operations" className="text-accent underline">Return to Systems</Link>
  </main>;
}
