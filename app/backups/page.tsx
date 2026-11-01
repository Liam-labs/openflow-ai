import Link from 'next/link';

export default function BackupsPage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 py-12">
      <section className="glass-card w-full max-w-lg p-6 sm:p-8" aria-labelledby="backups-title">
        <h1 id="backups-title" className="text-xl font-semibold text-white mb-4">Backups are not available in this installation</h1>
        <p className="text-white/70 mb-6">This installation does not include the backup service. No backup has been created by this page.</p>
        <Link href="/operations" className="glass-button inline-block px-5 py-3 text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">Return to Systems</Link>
      </section>
    </main>
  );
}
