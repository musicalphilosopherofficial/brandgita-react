import { useState } from 'react'

const COLORS = {
  ink: '#1A1A18',
  softText: '#4A4842',
  blue: '#2196F3',
  border: '#D4CFC4',
  errorRed: '#C0392B',
  successGreen: '#27AE60',
  accepted: { border: '#27AE60', bg: '#F0FDF4', dot: '#27AE60', badge: '#166534', badgeBg: '#DCFCE7' },
  rejected: { border: '#C0392B', bg: '#FEF2F2', dot: '#C0392B', badge: '#991B1B', badgeBg: '#FEE2E2' },
  neutral: { border: '#D4CFC4', bg: '#FDFCF9', dot: '#2196F3', dotBg: '#2196F3' },
}

// status: 'accepted' | 'rejected' | null
function RadioCard({ label, sublabel, selected, onClick, status }) {
  const scheme =
    selected && status === 'accepted' ? COLORS.accepted :
    selected && status === 'rejected' ? COLORS.rejected :
    COLORS.neutral

  const borderColor = selected ? scheme.border : COLORS.border
  const bgColor = selected
    ? (status === 'accepted' ? scheme.bg : status === 'rejected' ? scheme.bg : '#EDF5FF')
    : '#FDFCF9'
  const dotBorderColor = selected ? scheme.border ?? COLORS.blue : COLORS.border
  const dotBgColor = selected ? (scheme.dot ?? COLORS.blue) : 'transparent'

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.875rem 1.125rem',
        border: `1.5px solid ${borderColor}`,
        borderRadius: 10,
        cursor: 'pointer',
        background: bgColor,
        transition: 'border-color 0.15s, background 0.15s',
        userSelect: 'none',
        width: '100%',
        textAlign: 'left',
      }}
    >
      {/* Radio dot */}
      <span style={{
        flexShrink: 0,
        marginTop: 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        border: `2px solid ${dotBorderColor}`,
        background: selected ? dotBgColor : 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'border-color 0.15s, background 0.15s',
      }}>
        {selected && (
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', display: 'block' }} />
        )}
      </span>

      <span style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.9375rem', fontWeight: 500, color: COLORS.ink }}>
            {label}
          </span>
          {selected && status === 'accepted' && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: COLORS.accepted.badge,
              background: COLORS.accepted.badgeBg,
              padding: '2px 7px', borderRadius: 4,
            }}>
              ✓ Compatible
            </span>
          )}
          {selected && status === 'rejected' && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: COLORS.rejected.badge,
              background: COLORS.rejected.badgeBg,
              padding: '2px 7px', borderRadius: 4,
            }}>
              ✗ Not supported
            </span>
          )}
        </span>
        {sublabel && (
          <span style={{ fontSize: '0.8rem', color: COLORS.softText, fontWeight: 300, lineHeight: 1.4 }}>
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
      fontSize: 11, fontWeight: 700, letterSpacing: '0.18em',
      textTransform: 'uppercase', color: COLORS.blue,
      marginBottom: '0.75rem', marginTop: 0,
    }}>
      {text}
    </p>
  )
}

function HowToCheck({ steps }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginBottom: '0.875rem', marginTop: '-0.25rem' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '0.8rem', color: COLORS.blue, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: '0.3rem',
        }}
      >
        <span style={{
          display: 'inline-block', fontSize: 10,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 0.15s',
        }}>▶</span>
        {open ? 'Hide' : 'Not sure? How to check'}
      </button>
      {open && (
        <div style={{
          marginTop: '0.625rem', padding: '0.75rem 1rem',
          background: '#F5F2EC', borderRadius: 8,
          border: '1px solid #E2DDD4',
        }}>
          {steps.map((step, i) => (
            <p key={i} style={{
              margin: i === 0 ? 0 : '0.5rem 0 0',
              fontSize: '0.8125rem', color: COLORS.softText,
              lineHeight: 1.5, fontWeight: 300,
            }}>
              {step}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Waitlist() {
  const [role, setRole] = useState(null)       // 'coach' | 'educator' | 'entrepreneur' | 'none'
  const [platform, setPlatform] = useState(null) // 'youtube' | 'instagram' | 'both' | 'starting'
  const [monetise, setMonetise] = useState(null) // 'courses' | 'coaching' | 'community' | 'building'
  const [os, setOs] = useState(null)             // 'mac' | 'windows'
  const [mac, setMac] = useState(null)           // 'pro' | 'neo' | 'intel'
  const [winSetup, setWinSetup] = useState(null) // 'intel-nvidia' | 'amd-nvidia' | 'intel-qsv' | 'amd-unsupported'
  const [ai, setAi] = useState(null)             // 'claude' | 'gemini' | 'ollama' | 'openai-only'

  const icpRejected = role === 'none'
  const icpComplete = role !== null && !icpRejected && platform !== null && monetise !== null
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState('idle')
  const [errorMsg, setErrorMsg] = useState('')

  function getHardwareValue() {
    if (os === 'mac' && mac === 'pro') return 'mac-apple-silicon'
    if (os === 'windows' && winSetup === 'intel-nvidia') return 'windows-intel-nvidia'
    if (os === 'windows' && winSetup === 'intel-qsv') return 'windows-intel-qsv'
    if (os === 'windows' && winSetup === 'amd-nvidia') return 'windows-amd-nvidia'
    return null
  }

  const hardwareComplete =
    (os === 'mac' && mac === 'pro') ||
    (os === 'windows' && winSetup !== null && winSetup !== 'amd-unsupported')

  const aiComplete = ai !== null && ai !== 'openai-only'

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
        body: JSON.stringify({ email, name: name.trim() || undefined, hardware, role, platform, monetise, ai }),
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
          <p style={{ fontSize: '1.0625rem', fontWeight: 600, color: COLORS.ink, textAlign: 'center', marginBottom: '0.5rem' }}>
            You&rsquo;re on the list.
          </p>
          <p style={{ fontSize: '0.9rem', color: COLORS.softText, textAlign: 'center', fontWeight: 300, lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>
            We&rsquo;ll reach out when founding creator access opens.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section style={sectionStyle}>

      <p style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.2em',
        textTransform: 'uppercase', color: COLORS.blue,
        textAlign: 'center', marginBottom: '0.75rem',
      }}>
        Founding creator applications
      </p>

      <h2 style={{
        fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)', fontWeight: 700,
        color: COLORS.ink, textAlign: 'center', marginBottom: '0.5rem',
        letterSpacing: '-0.01em', lineHeight: 1.25,
      }}>
        Get in early. Get in free.
      </h2>

      <p style={{
        fontSize: '0.9rem', color: COLORS.softText, textAlign: 'center',
        fontWeight: 300, lineHeight: 1.6, marginBottom: '2rem',
      }}>
        Early applicants get founding access — full product, no cost, in exchange for honest feedback.
        Select your setup below to see if you&rsquo;re compatible.
      </p>

      <div style={containerStyle}>
        <form onSubmit={handleSubmit} noValidate>

          {/* Step 1: Role */}
          <div style={{ marginBottom: '1.5rem' }}>
            <StepLabel text="What best describes you?" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <RadioCard
                label="Coach or consultant"
                sublabel="1:1 or group coaching, consulting services"
                selected={role === 'coach'}
                status={null}
                onClick={() => setRole('coach')}
              />
              <RadioCard
                label="Educator or course creator"
                sublabel="Online courses, tutorials, teaching content"
                selected={role === 'educator'}
                status={null}
                onClick={() => setRole('educator')}
              />
              <RadioCard
                label="Entrepreneur or founder"
                sublabel="Building a business around your personal brand"
                selected={role === 'entrepreneur'}
                status={null}
                onClick={() => setRole('entrepreneur')}
              />
              <RadioCard
                label="None of these"
                sublabel="I don't create content around my expertise"
                selected={role === 'none'}
                status={role === 'none' ? 'rejected' : null}
                onClick={() => setRole('none')}
              />
            </div>
            {icpRejected && (
              <p style={rejectedMsgStyle}>
                Brand Gita is built specifically for coaches, educators, and entrepreneurs who show up on camera to share their expertise. It might not be the right fit right now — but if that changes, come back and apply.
              </p>
            )}
          </div>

          {/* Step 2: Platform */}
          {role !== null && !icpRejected && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Where do you share your expertise?" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="YouTube"
                  sublabel="Long-form video — tutorials, vlogs, interviews"
                  selected={platform === 'youtube'}
                  status={null}
                  onClick={() => setPlatform('youtube')}
                />
                <RadioCard
                  label="Instagram"
                  sublabel="Reels, carousels, stories"
                  selected={platform === 'instagram'}
                  status={null}
                  onClick={() => setPlatform('instagram')}
                />
                <RadioCard
                  label="Both YouTube and Instagram"
                  sublabel="Multi-platform — repurposing long-form into short-form"
                  selected={platform === 'both'}
                  status={null}
                  onClick={() => setPlatform('both')}
                />
                <RadioCard
                  label="Just getting started"
                  sublabel="Building toward publishing video content"
                  selected={platform === 'starting'}
                  status={null}
                  onClick={() => setPlatform('starting')}
                />
              </div>
            </div>
          )}

          {/* Step 3: Monetisation */}
          {role !== null && !icpRejected && platform !== null && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="How do you monetise your expertise?" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Courses or digital products"
                  sublabel="Online courses, templates, digital downloads"
                  selected={monetise === 'courses'}
                  status={null}
                  onClick={() => setMonetise('courses')}
                />
                <RadioCard
                  label="Coaching or consulting"
                  sublabel="1:1 sessions, group programmes, retainers"
                  selected={monetise === 'coaching'}
                  status={null}
                  onClick={() => setMonetise('coaching')}
                />
                <RadioCard
                  label="Community or membership"
                  sublabel="Paid community, membership site, subscription"
                  selected={monetise === 'community'}
                  status={null}
                  onClick={() => setMonetise('community')}
                />
                <RadioCard
                  label="Still building toward it"
                  sublabel="Growing my audience before monetising"
                  selected={monetise === 'building'}
                  status={null}
                  onClick={() => setMonetise('building')}
                />
              </div>
            </div>
          )}

          {/* Step 4: OS — only shown after ICP complete */}
          {icpComplete && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Your operating system" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <RadioCard
                label="Mac"
                selected={os === 'mac'}
                status={null}
                onClick={() => { setOs('mac'); setMac(null); setWinSetup(null); setAi(null) }}
              />
              <RadioCard
                label="Windows"
                selected={os === 'windows'}
                status={null}
                onClick={() => { setOs('windows'); setMac(null); setWinSetup(null); setAi(null) }}
              />
            </div>
          </div>
          )} {/* end icpComplete */}

          {/* Step 5: Mac model */}
          {icpComplete && os === 'mac' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Your Mac" />
              <HowToCheck steps={[
                '① Click the Apple  menu (top-left) → About This Mac.',
                '② Look for the "Chip" line. If it says M1, M2, M3, or M4 — you\'re compatible.',
                '③ If it says "Intel Core" → Intel Macs are not supported. Brand Gita requires Apple Silicon.',
                '④ Mac Neo (budget range) is also not supported — it doesn\'t have enough processing power for local video rendering.',
              ]} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="MacBook Air, MacBook Pro, Mac mini, iMac, Mac Studio or Mac Pro"
                  sublabel="Apple M series chip"
                  selected={mac === 'pro'}
                  status={mac === 'pro' ? 'accepted' : null}
                  onClick={() => setMac('pro')}
                />
                <RadioCard
                  label="Mac Neo"
                  sublabel="Apple M series chip — budget range"
                  selected={mac === 'neo'}
                  status={mac === 'neo' ? 'rejected' : null}
                  onClick={() => setMac('neo')}
                />
                <RadioCard
                  label="Intel Mac"
                  sublabel="Any Mac with an Intel processor"
                  selected={mac === 'intel'}
                  status={mac === 'intel' ? 'rejected' : null}
                  onClick={() => setMac('intel')}
                />
              </div>
              {mac === 'neo' && (
                <p style={rejectedMsgStyle}>
                  The Mac Neo is a budget-range machine not suited for the heavy local video processing Brand Gita requires. You&rsquo;d need a MacBook Air or Pro (M series) at minimum.
                </p>
              )}
              {mac === 'intel' && (
                <p style={rejectedMsgStyle}>
                  Intel Macs aren&rsquo;t supported — Brand Gita requires Apple Silicon. If you upgrade to an M series Mac, come back and apply.
                </p>
              )}
            </div>
          )}

          {/* Step 6: Windows setup (CPU + GPU combined) */}
          {icpComplete && os === 'windows' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Your setup" />
              <HowToCheck steps={[
                '① Processor: press Windows key + Pause/Break, or go to Settings → System → About. Look for the "Processor" line.',
                '② Graphics: press Ctrl + Shift + Esc → Task Manager → Performance tab → click GPU. The GPU name shows top-right.',
                '③ Intel tiers: i5, i7, i9 — higher = more powerful. Generation = first two digits after the dash (i7-12700H = 12th gen). 12th gen or newer recommended.',
                '④ AMD tiers: Ryzen 5, 7, 9 — higher = more powerful. Series = first digit of the 4-digit model number (Ryzen 7 5800H = 5000 series, Ryzen 7 7700X = 7000 series). 5000 series or newer recommended.',
                '⑤ No dedicated GPU, or have AMD Radeon with Intel CPU? Select the third option — Brand Gita uses Intel Quick Sync instead.',
              ]} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Intel Core i5, i7, or i9 + NVIDIA RTX"
                  sublabel="Recommended RTX 3060 or newer · Intel 12th gen or newer recommended"
                  selected={winSetup === 'intel-nvidia'}
                  status={winSetup === 'intel-nvidia' ? 'accepted' : null}
                  onClick={() => setWinSetup('intel-nvidia')}
                />
                <RadioCard
                  label="AMD Ryzen 5, 7, or 9 + NVIDIA RTX"
                  sublabel="Recommended RTX 3060 or newer · Ryzen 5000 series or newer recommended"
                  selected={winSetup === 'amd-nvidia'}
                  status={winSetup === 'amd-nvidia' ? 'accepted' : null}
                  onClick={() => setWinSetup('amd-nvidia')}
                />
                <RadioCard
                  label="Intel Core i5, i7, or i9 — no NVIDIA GPU"
                  sublabel="No dedicated GPU, or with AMD Radeon — uses Intel Quick Sync (QSV)"
                  selected={winSetup === 'intel-qsv'}
                  status={winSetup === 'intel-qsv' ? 'accepted' : null}
                  onClick={() => setWinSetup('intel-qsv')}
                />
                <RadioCard
                  label="AMD Ryzen — no NVIDIA GPU"
                  sublabel="AMD Radeon or no dedicated GPU"
                  selected={winSetup === 'amd-unsupported'}
                  status={winSetup === 'amd-unsupported' ? 'rejected' : null}
                  onClick={() => setWinSetup('amd-unsupported')}
                />
              </div>
              {winSetup === 'amd-unsupported' && (
                <p style={rejectedMsgStyle}>
                  AMD Radeon isn&rsquo;t supported in the current beta — Brand Gita requires an NVIDIA RTX GPU on AMD Ryzen systems.
                  We&rsquo;ll add AMD GPU support in a future release.
                </p>
              )}
            </div>
          )}

          {/* Step 7: AI — only shown when hardware is compatible */}
          {hardwareComplete && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Which AI do you have access to?" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Claude"
                  sublabel="Minimum: Pro · Recommended: Max"
                  selected={ai === 'claude'}
                  status={ai === 'claude' ? 'accepted' : null}
                  onClick={() => setAi('claude')}
                />
                <RadioCard
                  label="Google Gemini"
                  sublabel="Free tier works · Recommended: Gemini Advanced"
                  selected={ai === 'gemini'}
                  status={ai === 'gemini' ? 'accepted' : null}
                  onClick={() => setAi('gemini')}
                />
                <RadioCard
                  label="Ollama"
                  sublabel="Free — open-source models running locally on your machine"
                  selected={ai === 'ollama'}
                  status={ai === 'ollama' ? 'accepted' : null}
                  onClick={() => setAi('ollama')}
                />
                <RadioCard
                  label="ChatGPT / OpenAI only"
                  sublabel="No Claude, Gemini, or Ollama access"
                  selected={ai === 'openai-only'}
                  status={ai === 'openai-only' ? 'rejected' : null}
                  onClick={() => setAi('openai-only')}
                />
              </div>
              {ai === 'openai-only' && (
                <p style={rejectedMsgStyle}>
                  Brand Gita works with Claude, Gemini, and Ollama — ChatGPT and OpenAI aren&rsquo;t supported in the current beta. OpenAI support is on the roadmap. In the meantime, Claude and Gemini both have free tiers — sign up for one and come back to apply.
                </p>
              )}
            </div>
          )}

          {/* Email step — only shown when hardware + AI are both compatible */}
          {hardwareComplete && aiComplete && (
            <div style={{ marginBottom: '1.25rem' }}>
              <StepLabel text="Your details" />

              <input
                type="text"
                placeholder="First name"
                value={name}
                onChange={e => setName(e.target.value)}
                required
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
                <p style={{ fontSize: '0.85rem', color: COLORS.errorRed, marginTop: '0.625rem', marginBottom: 0 }}>
                  {errorMsg}
                </p>
              )}

              <button
                type="submit"
                disabled={!email || !name.trim() || status === 'loading'}
                style={{
                  ...submitButtonStyle,
                  opacity: (!email || !name.trim() || status === 'loading') ? 0.55 : 1,
                  cursor: (!email || !name.trim() || status === 'loading') ? 'not-allowed' : 'pointer',
                }}
              >
                {status === 'loading' ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                    <Spinner />
                    Submitting…
                  </span>
                ) : 'Apply for founding access'}
              </button>

              <p style={{ fontSize: '0.775rem', color: COLORS.softText, textAlign: 'center', marginTop: '0.75rem', marginBottom: 0, fontWeight: 300 }}>
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
      display: 'inline-block', width: 14, height: 14,
      border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  )
}

const sectionStyle = {
  width: '100%', display: 'flex', flexDirection: 'column',
  alignItems: 'center', padding: '2rem 1rem 2.5rem',
}

const containerStyle = { width: '100%', maxWidth: 440 }

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '0.75rem 1rem',
  fontSize: '0.9375rem', fontWeight: 400, color: '#1A1A18',
  background: '#FDFCF9', border: '1.5px solid #D4CFC4', borderRadius: 8,
  outline: 'none', fontFamily: 'inherit', display: 'block',
}

const submitButtonStyle = {
  marginTop: '1rem', width: '100%', padding: '0.875rem 1rem',
  fontSize: '0.9375rem', fontWeight: 600, color: '#fff',
  background: '#2196F3', border: 'none', borderRadius: 8,
  fontFamily: 'inherit', letterSpacing: '0.01em', transition: 'opacity 0.15s',
}

const rejectedMsgStyle = {
  marginTop: '0.875rem', fontSize: '0.85rem', color: '#7A6F63',
  lineHeight: 1.6, background: '#F9F3F3', border: '1px solid #E8D0D0',
  borderRadius: 8, padding: '0.75rem 1rem',
}
