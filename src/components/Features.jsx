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
    title: 'Video processing',
    desc: 'Background noise removed, silences cut, audio cleaned up — ready to publish.',
  },
  {
    title: 'Short-form video',
    desc: 'Vertical clips cut and branded from your long-form video.',
  },
  {
    title: 'Instagram carousels',
    desc: 'On-brand slides built from your content — no Canva required.',
  },
  {
    title: 'Captions',
    desc: 'Word-by-word captions styled to your brand.',
  },
  {
    title: 'Direct publishing',
    desc: 'Publish to YouTube and Instagram — no third-party scheduler.',
  },
  {
    title: 'Thumbnails',
    desc: 'On-brand thumbnail generated for every video — no design tool required.',
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
          TikTok publishing &nbsp;·&nbsp; LinkedIn carousels &nbsp;·&nbsp; Analytics &amp; coaching layer &nbsp;·&nbsp; Motion graphic reels
        </span>
      </div>
    </div>
  )
}
