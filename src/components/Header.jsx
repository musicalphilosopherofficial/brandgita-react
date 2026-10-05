export default function Header() {
  const link = { color: '#2196F3', textDecoration: 'none', fontSize: '0.85rem', fontWeight: 500 }
  return (
    <header
      style={{
        width: '100%',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem 1.5rem',
        padding: '0.9rem 0',
        marginBottom: '1.5rem',
        borderBottom: '1px solid #D0CBC0',
      }}
    >
      <a href="/" style={{ color: '#2196F3', textDecoration: 'none', fontWeight: 700, fontSize: '1.05rem', letterSpacing: '-0.01em', display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        <img src="/favicon.png" alt="" width="28" height="28" style={{ borderRadius: 6, display: 'block' }} />
        Brand Gita
      </a>
      <nav aria-label="Main" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1.25rem' }}>
        <a href="/#how-it-works" style={link}>How it works</a>
        <a href="/privacy-policy" style={link}>Privacy</a>
        <a href="/terms" style={link}>Terms</a>
        <a href="/data-deletion" style={link}>Data deletion</a>
        <a href="mailto:support@brandgita.com" style={link}>Contact</a>
      </nav>
    </header>
  )
}
