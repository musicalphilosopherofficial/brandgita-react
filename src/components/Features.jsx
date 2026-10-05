const CARD_STYLE = {
  background: '#F4F0E8',
  border: '1px solid #D8D3C8',
  borderRadius: 6,
  padding: '0.75rem 1rem',
}

const features = [
  {
    title: 'Brand interview',
    desc: 'One interview. Your brand on file — no re-briefing, ever.',
  },
  {
    title: 'Style profiles',
    desc: 'Save your favourite carousel look, and every new post follows it.',
  },
  {
    title: 'Carousels',
    desc: 'On-brand slides built from your content — no Canva required.',
  },
  {
    title: 'Content bank',
    desc: 'Every idea stored in one place — your content plans are made from it.',
  },
  {
    title: 'Education asset carousels',
    desc: 'Turn your expertise into diagram-supported carousels.',
  },
  {
    title: 'Life-moment carousels',
    desc: 'Your photos and videos from your life, turned into personal story carousels.',
  },
  {
    title: 'Captions',
    desc: 'Captions written in your voice for every post.',
  },
  {
    title: 'Direct publishing',
    desc: 'Publish to all your social platforms — no third-party scheduler.',
  },
]

export default function Features() {
  return (
    <div style={{ width: '100%' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '0.6rem',
        marginBottom: '0.6rem',
      }}>
        {features.map((f) => (
          <div key={f.title} style={CARD_STYLE}>
            <p style={{ fontWeight: 600, fontSize: '0.875rem', color: '#1A1A18', marginBottom: '0.2rem' }}>
              {f.title}
            </p>
            <p style={{ fontSize: '0.8rem', color: '#6E6B62', fontWeight: 300, lineHeight: 1.45 }}>{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Coming soon */}
      <div style={{
        ...CARD_STYLE,
        border: '1px dashed #C8C3B8',
        background: '#F4F0E8',
        display: 'flex',
        alignItems: 'baseline',
        gap: '0.6rem',
        marginBottom: '4rem',
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#9B9789', whiteSpace: 'nowrap', flexShrink: 0 }}>
          Coming soon
        </span>
        <span style={{ fontSize: '0.8rem', fontWeight: 300, color: '#6E6B62', lineHeight: 1.5 }}>
          Video editing &amp; short-form clips &nbsp;·&nbsp; Reels style profiles &nbsp;·&nbsp; Video publishing &nbsp;·&nbsp; Thumbnails &nbsp;·&nbsp; LinkedIn carousels &nbsp;·&nbsp; Newsletter &nbsp;·&nbsp; Analytics
        </span>
      </div>
    </div>
  )
}
