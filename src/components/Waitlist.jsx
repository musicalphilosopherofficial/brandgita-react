import { useState } from 'react'

// Hardware value mapping
// mac-apple-silicon | mac-intel | windows-nvidia | windows-cpu | linux

const COLORS = {
  cream: '#EBE7DB',
  ink: '#1A1A18',
  softText: '#4A4842',
  blue: '#2196F3',
  border: '#D4CFC4',
  borderFocus: '#2196F3',
  errorRed: '#C0392B',
  successGreen: '#27AE60',
}

const cardBase = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.875rem 1.125rem',
  border: `1.5px solid ${COLORS.border}`,
  borderRadius: 10,
  cursor: 'pointer',
  background: '#FDFCF9',
  transition: 'border-color 0.15s, background 0.15s',
  userSelect: 'none',
  width: '100%',
  textAlign: 'left',
}

function RadioCard({ label, sublabel, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...cardBase,
        borderColor: selected ? COLORS.blue : COLORS.border,
        background: selected ? '#EDF5FF' : '#FDFCF9',
      }}
    >
      {/* Custom radio dot */}
      <span style={{
        flexShrink: 0,
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: `2px solid ${selected ? COLORS.blue : COLORS.border}`,
        background: selected ? COLORS.blue : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 0.15s, background 0.15s',
      }}>
        {selected && (
          <span style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#fff',
            display: 'block',
          }} />
        )}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: '0.9375rem', fontWeight: 500, color: COLORS.ink }}>
          {label}
        </span>
        {sublabel && (
          <span style={{ fontSize: '0.8rem', color: COLORS.softText, fontWeight: 300 }}>
            {sublabel}
          </span>
        )}
      </span>
    </button>
  )
}

function StepLabel({ text }) {
  return (
    <p style={{
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: COLORS.blue,
      marginBottom: '0.75rem',
      marginTop: 0,
    }}>
      {text}
    </p>
  )
}

export default function Waitlist() {
  const [os, setOs] = useState(null)          // 'mac' | 'windows'
  const [chip, setChip] = useState(null)      // 'apple-silicon' | 'intel'
  const [gpu, setGpu] = useState(null)        // 'nvidia' | 'cpu'
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('idle') // 'idle' | 'loading' | 'success' | 'error'
  const [errorMsg, setErrorMsg] = useState('')

  function getHardwareValue() {
    if (os === 'mac') return chip === 'apple-silicon' ? 'mac-apple-silicon' : chip === 'intel' ? 'mac-intel' : null
    if (os === 'windows') return gpu === 'nvidia' ? 'windows-nvidia' : gpu === 'cpu' ? 'windows-cpu' : null
    return null
  }

  // Determine if the form is ready to show the email step
  const hardwareComplete =
    (os === 'mac' && chip !== null) ||
    (os === 'windows' && gpu !== null)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email) return

    const hardware = getHardwareValue()
    setStatus('loading')
    setErrorMsg('')

    try {
      const res = await fetch('/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name.trim() || undefined, hardware }),
      })
      const data = await res.json()
      if (!res.ok) {
        setErrorMsg(data.error || 'Something went wrong. Please try again.')
        setStatus('error')
      } else {
        setStatus('success')
      }
    } catch {
      setErrorMsg('Could not connect. Check your internet and try again.')
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <section style={sectionStyle}>
        <div style={containerStyle}>
          <p style={{
            fontSize: '1.0625rem',
            fontWeight: 600,
            color: COLORS.ink,
            textAlign: 'center',
            marginBottom: '0.5rem',
          }}>
            You&rsquo;re on the list.
          </p>
          <p style={{
            fontSize: '0.9rem',
            color: COLORS.softText,
            textAlign: 'center',
            fontWeight: 300,
            lineHeight: 1.6,
            maxWidth: 360,
            margin: '0 auto',
          }}>
            We&rsquo;ll reach out before founding creator applications open.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section style={sectionStyle}>

      <p style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: COLORS.blue,
        textAlign: 'center',
        marginBottom: '0.75rem',
      }}>
        Founding creator applications opening soon — spots limited
      </p>

      <h2 style={{
        fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)',
        fontWeight: 700,
        color: COLORS.ink,
        textAlign: 'center',
        marginBottom: '0.5rem',
        letterSpacing: '-0.01em',
        lineHeight: 1.25,
      }}>
        Join the waitlist
      </h2>

      <p style={{
        fontSize: '0.9rem',
        color: COLORS.softText,
        textAlign: 'center',
        fontWeight: 300,
        lineHeight: 1.6,
        marginBottom: '2rem',
      }}>
        Tell us your setup so we can confirm compatibility before you apply.
      </p>

      <div style={containerStyle}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Step 1: OS */}
          <div style={{ marginBottom: '1.5rem' }}>
            <StepLabel text="Your operating system" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <RadioCard
                label="Mac"
                selected={os === 'mac'}
                onClick={() => { setOs('mac'); setGpu(null) }}
              />
              <RadioCard
                label="Windows"
                selected={os === 'windows'}
                onClick={() => { setOs('windows'); setChip(null) }}
              />
            </div>
          </div>

          {/* Step 2a: Mac chip */}
          {os === 'mac' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Your chip" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Apple Silicon"
                  sublabel="M1, M2, M3, or M4"
                  selected={chip === 'apple-silicon'}
                  onClick={() => setChip('apple-silicon')}
                />
                <RadioCard
                  label="Intel Mac"
                  selected={chip === 'intel'}
                  onClick={() => setChip('intel')}
                />
              </div>
            </div>
          )}

          {/* Step 2b: Windows GPU */}
          {os === 'windows' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Your GPU" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="NVIDIA GPU"
                  sublabel="RTX / GTX series"
                  selected={gpu === 'nvidia'}
                  onClick={() => setGpu('nvidia')}
                />
                <RadioCard
                  label="No dedicated GPU"
                  sublabel="Integrated graphics or AMD"
                  selected={gpu === 'cpu'}
                  onClick={() => setGpu('cpu')}
                />
              </div>
            </div>
          )}

          {/* Step 3: Email */}
          {hardwareComplete && (
            <div style={{ marginBottom: '1.25rem' }}>
              <StepLabel text="Your details" />

              <input
                type="text"
                placeholder="First name (optional)"
                value={name}
                onChange={e => setName(e.target.value)}
                style={inputStyle}
                autoComplete="given-name"
              />

              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                style={{ ...inputStyle, marginTop: '0.625rem' }}
                autoComplete="email"
              />

              {status === 'error' && errorMsg && (
                <p style={{
                  fontSize: '0.85rem',
                  color: COLORS.errorRed,
                  marginTop: '0.625rem',
                  marginBottom: 0,
                  fontWeight: 400,
                }}>
                  {errorMsg}
                </p>
              )}

              <button
                type="submit"
                disabled={!email || status === 'loading'}
                style={{
                  ...submitButtonStyle,
                  opacity: (!email || status === 'loading') ? 0.55 : 1,
                  cursor: (!email || status === 'loading') ? 'not-allowed' : 'pointer',
                }}
              >
                {status === 'loading' ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                    <Spinner />
                    Submitting…
                  </span>
                ) : 'Join the waitlist'}
              </button>

              <p style={{
                fontSize: '0.775rem',
                color: COLORS.softText,
                textAlign: 'center',
                marginTop: '0.75rem',
                marginBottom: 0,
                fontWeight: 300,
              }}>
                No spam. We&rsquo;ll only contact you about your application.
              </p>
            </div>
          )}

        </form>
      </div>
    </section>
  )
}

function Spinner() {
  return (
    <span style={{
      display: 'inline-block',
      width: 14,
      height: 14,
      border: '2px solid rgba(255,255,255,0.35)',
      borderTopColor: '#fff',
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }} />
  )
}

// Shared styles
const sectionStyle = {
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  padding: '2rem 1rem 2.5rem',
}

const containerStyle = {
  width: '100%',
  maxWidth: 440,
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '0.75rem 1rem',
  fontSize: '0.9375rem',
  fontWeight: 400,
  color: '#1A1A18',
  background: '#FDFCF9',
  border: '1.5px solid #D4CFC4',
  borderRadius: 8,
  outline: 'none',
  fontFamily: 'inherit',
  display: 'block',
}

const submitButtonStyle = {
  marginTop: '1rem',
  width: '100%',
  padding: '0.875rem 1rem',
  fontSize: '0.9375rem',
  fontWeight: 600,
  color: '#fff',
  background: '#2196F3',
  border: 'none',
  borderRadius: 8,
  fontFamily: 'inherit',
  letterSpacing: '0.01em',
  transition: 'opacity 0.15s',
}
