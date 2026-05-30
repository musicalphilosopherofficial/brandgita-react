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
        Turn a single video into a week of content — edited and styled to who you are.
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
        You show up on camera because you have something real to say — and you want your content to prove it.
        <br /><br />
        Every AI tool you've tried strips your voice out and hands you something polished but generic.{' '}
        <strong style={{ fontWeight: 600, color: '#1A1A18' }}>Hours of editing. Same generic look. No life, no flavour.</strong>
        <br /><br />
        Brand Gita runs a one-time brand interview — then every clip, carousel, and caption it produces sounds and looks like you — not like the tool.{' '}
        <strong style={{ fontWeight: 600, color: '#1A1A18' }}>No prompting. No templates. Just review and publish.</strong>
      </p>
    </section>
  )
}
