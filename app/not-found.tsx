export default function NotFound() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--df-bg)', color: 'var(--df-text)', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: '64px', fontWeight: 800, margin: '0 0 8px', opacity: 0.15 }}>404</h1>
        <p style={{ margin: '0 0 24px', color: 'var(--df-text-muted)' }}>Page not found</p>
        <a href="/" style={{ padding: '8px 20px', borderRadius: '8px', textDecoration: 'none',
          background: 'rgba(59,130,246,0.15)', color: 'var(--df-accent)',
          border: '1px solid rgba(59,130,246,0.3)' }}>
          Go home
        </a>
      </div>
    </div>
  );
}
