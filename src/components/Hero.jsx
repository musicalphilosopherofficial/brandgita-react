export default function Hero() {
  return (
    <section style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '3.5rem' }}>

      <p style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: '#2196F3',
        textAlign: 'center',
        marginBottom: '1rem',
      }}>
        For entrepreneurs, coaches, and educators who do YouTube
      </p>

      <h1 style={{
        fontSize: 'clamp(1.6rem, 4vw, 2.5rem)',
        fontWeight: 700,
        lineHeight: 1.18,
        letterSpacing: '-0.02em',
        color: '#1A1A18',
        textAlign: 'center',
        marginBottom: '1.5rem',
        maxWidth: 720,
      }}>
        In 1 hour, turn your long-form content into 30 days of on-brand carousels, published on all social media platforms.
      </h1>

      <p style={{
        fontSize: '1rem',
        fontWeight: 300,
        lineHeight: 1.72,
        color: '#4A4842',
        textAlign: 'center',
        maxWidth: 580,
        marginBottom: 0,
      }}>
        You have real expertise and real stories to tell — and you want your content to prove it.
        <br /><br />
        Every AI tool you've tried strips your voice out and hands you something polished but generic.{' '}
        <strong style={{ fontWeight: 600, color: '#1A1A18' }}>Your feed ends up looking like everyone else's — and nobody stops scrolling.</strong>
        <br /><br />
        Brand Gita runs a one-time brand interview — then every carousel and caption it produces sounds and looks like you — not like the tool.{' '}
        <strong style={{ fontWeight: 600, color: '#1A1A18' }}>No prompting. Style profiles lock in your look. Just review and publish.</strong>
        <br /><br />
        Brand Gita publishes your finished videos and photo carousels to your own TikTok, Instagram and YouTube accounts, only when you review and confirm each post.
      </p>
    </section>
  )
}
