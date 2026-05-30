const STEPS = [
  {
    number: '01',
    title: 'Brand interview',
    body: 'Answer questions about your voice, style, and audience. Done once — every piece of content inherits it forever.',
  },
  {
    number: '02',
    title: 'Shoot your video',
    body: 'Record normally. No script. No teleprompter. No second shooting schedule for short-form. Just talk.',
  },
  {
    number: '03',
    title: 'Review with Brand Gita',
    body: 'Everything happens in front of you. Have a conversation, review changes — no prompting needed if you don\'t want to.',
  },
  {
    number: '04',
    title: 'Publish',
    body: 'Long-form edited, clips cut, carousels built, captions written — published direct to YouTube and Instagram.',
  },
]

export default function HowItWorks() {
  return (
    <div style={{ width: '100%', marginBottom: '4rem' }}>

      {/* Desktop: horizontal row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 0,
        position: 'relative',
      }}>
        {/* Connector line */}
        <div style={{
          position: 'absolute',
          top: 18,
          left: 'calc(12.5% + 1px)',
          right: 'calc(12.5% + 1px)',
          height: 1,
          background: '#D4CFC4',
          zIndex: 0,
        }} />

        {STEPS.map((step, i) => (
          <div key={i} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center',
            padding: '0 1rem',
            position: 'relative',
            zIndex: 1,
          }}>
            {/* Step dot */}
            <div style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: '#2196F3',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '1rem',
              flexShrink: 0,
            }}>
              <span style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#fff',
                letterSpacing: '0.05em',
              }}>
                {step.number}
              </span>
            </div>

            <p style={{
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#1A1A18',
              marginBottom: '0.4rem',
              lineHeight: 1.25,
            }}>
              {step.title}
            </p>

            <p style={{
              fontSize: '0.8rem',
              fontWeight: 300,
              color: '#6E6B62',
              lineHeight: 1.55,
              maxWidth: 180,
            }}>
              {step.body}
            </p>
          </div>
        ))}
      </div>

      {/* Mobile: vertical stack */}
      <style>{`
        @media (max-width: 600px) {
          .how-it-works-grid { grid-template-columns: 1fr !important; }
          .how-it-works-line { display: none !important; }
          .how-it-works-step { flex-direction: row !important; text-align: left !important; align-items: flex-start !important; padding: 0 0 1.5rem 0 !important; }
          .how-it-works-step p { max-width: none !important; }
        }
      `}</style>
    </div>
  )
}
