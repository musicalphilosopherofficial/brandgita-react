export default function Footer() {
  const linkStyle = { color: '#9B9789', textDecoration: 'none' }
  return (
    <footer
      style={{
        width: '100%',
        borderTop: '1px solid #D0CBC0',
        paddingTop: '1.25rem',
        marginTop: '1rem',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '0.5rem 1.25rem',
        fontSize: '0.8rem',
        color: '#9B9789',
        paddingBottom: '2rem',
      }}
    >
      <span>© 2026 Brand Gita · Built by Utsav Trivedi in New Zealand</span>
      <a href="/privacy-policy" style={linkStyle}>Privacy</a>
      <a href="/terms" style={linkStyle}>Terms</a>
      <a href="/acceptable-use" style={linkStyle}>Acceptable Use</a>
      <a href="/cookie-policy" style={linkStyle}>Cookies</a>
      <a href="/data-deletion" style={linkStyle}>Data Deletion</a>
      <a href="mailto:support@brandgita.com" style={linkStyle}>support@brandgita.com</a>
    </footer>
  )
}
