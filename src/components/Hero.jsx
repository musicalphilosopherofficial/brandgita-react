const BLOCK_STYLE = {
  background: '#F4F0E8',
  border: '1px solid #D8D3C8',
  borderRadius: 6,
  padding: '1rem 1.1rem',
  textAlign: 'left',
}

const BLOCKS = [
  {
    title: 'Real moments, real stories',
    body: 'Your vacations, personal moments and life highlights — all the footage you already have — turned into personal story carousels.',
  },
  {
    title: 'Expertise that teaches',
    body: 'Education slides built from your ideas and long-form content.',
  },
  {
    title: 'Trust in the age of AI',
    body: 'People trust what feels real. Authentic stories and genuine expertise build that trust.',
  },
  {
    title: 'Traffic that comes back to you',
    body: 'Every post is built so people want to click through — to your offer page, lead magnet or VSL.',
  },
]

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
        Turn your raw ideas and long-form content into 30 days of on-brand carousels, published on every social platform.
      </h1>

      <p style={{
        fontSize: '1.05rem',
        fontWeight: 300,
        lineHeight: 1.65,
        color: '#4A4842',
        textAlign: 'center',
        maxWidth: 560,
        marginBottom: '0.6rem',
      }}>
        Turn the moments you&rsquo;ve lived and the expertise you&rsquo;ve built into carousels that look like you.
      </p>
      <p style={{
        fontSize: '0.95rem',
        fontWeight: 300,
        lineHeight: 1.65,
        color: '#6E6B62',
        textAlign: 'center',
        maxWidth: 560,
        marginBottom: '2rem',
      }}>
        Brand Gita publishes your finished videos and photo carousels to your own TikTok, Instagram and YouTube accounts, only when you review and confirm each post.
      </p>

      <div style={{
        width: '100%',
        maxWidth: 760,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: '0.75rem',
      }}>
        {BLOCKS.map((b) => (
          <div key={b.title} style={BLOCK_STYLE}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#1A1A18', marginBottom: '0.3rem', letterSpacing: '-0.01em' }}>{b.title}</h3>
            <p style={{ fontSize: '0.85rem', fontWeight: 300, lineHeight: 1.55, color: '#4A4842', margin: 0 }}>{b.body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
