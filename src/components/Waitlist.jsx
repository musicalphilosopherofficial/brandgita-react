import { useState, useRef } from 'react'
import Checkout from './Checkout'

// Generate a random session ID once per page load — ties all step events together
function makeSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Fire-and-forget step tracker — never blocks the UI
function trackStep(sessionId, step, value) {
  try {
    navigator.sendBeacon('/track', JSON.stringify({ session_id: sessionId, step, value }))
  } catch {
    /* best-effort — swallow silently */
  }
}

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
  const sessionId = useRef(makeSessionId()).current
  const [role, setRole] = useState(null)       // 'expert' | 'entrepreneur' | 'none'
  const [platform, setPlatform] = useState(null) // 'youtube' | 'instagram' | 'both'
  const [monetise, setMonetise] = useState(null) // 'monetising' | 'building'
  const [os, setOs] = useState(null)             // 'mac' | 'windows'
  const [mac, setMac] = useState(null)           // 'pro' | 'neo' | 'intel'
  const [winSetup, setWinSetup] = useState(null) // 'intel-nvidia' | 'amd-nvidia' | 'intel-qsv' | 'amd-unsupported'
  const [ram, setRam] = useState(null)           // '16gb-plus' | 'under-16gb'
  const [ai, setAi] = useState(null)             // 'claude' | 'gemini' | 'ollama' | 'openai' | 'none'

  const icpRejected = role === 'none' || platform === 'instagram'
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

  // Hardware step 1: chip/GPU qualified
  const chipQualified =
    (os === 'mac' && mac === 'pro') ||
    (os === 'windows' && winSetup !== null && winSetup !== 'amd-unsupported')

  // Hardware fully complete: chip qualified + RAM meets minimum
  const hardwareComplete = chipQualified && ram !== null && ram !== 'under-16gb'

  const aiComplete = ai !== null && ai !== 'none'

  async function handleSubmit(e) {
    e.preventDefault()
    if (!email) return
    const hardware = getHardwareValue()
    setStatus('loading')
    setErrorMsg('')
    trackStep(sessionId, 'submitted', email)
    try {
      const res = await fetch('/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name.trim() || undefined, hardware, role, platform, monetise, ram, ai }),
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
    // Email captured. Run the smoke test: qualified applicants hit the
    // founding-access checkout; clicking a payment method records intent.
    return <Checkout email={email} name={name} />
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
                label="Coach, consultant, or educator"
                sublabel="You teach or advise — courses, coaching, consulting, tutorials"
                selected={role === 'expert'}
                status={null}
                onClick={() => { setRole('expert'); trackStep(sessionId, 'role', 'expert') }}
              />
              <RadioCard
                label="Entrepreneur or founder"
                sublabel="Building a business around your personal brand and expertise"
                selected={role === 'entrepreneur'}
                status={null}
                onClick={() => { setRole('entrepreneur'); trackStep(sessionId, 'role', 'entrepreneur') }}
              />
              <RadioCard
                label="None of these"
                sublabel="I don't create content around my expertise"
                selected={role === 'none'}
                status={role === 'none' ? 'rejected' : null}
                onClick={() => { setRole('none'); trackStep(sessionId, 'role', 'none') }}
              />
            </div>
            {icpRejected && (
              <p style={rejectedMsgStyle}>
                Brand Gita is built for coaches, educators, and entrepreneurs who create expertise-based content on camera. It might not be the right fit right now — but if that changes, come back and apply.
              </p>
            )}
          </div>

          {/* Step 2: Platform */}
          {role !== null && !icpRejected && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Where do you publish video content?" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="YouTube"
                  sublabel="Long-form video — tutorials, interviews, deep dives"
                  selected={platform === 'youtube'}
                  status={null}
                  onClick={() => { setPlatform('youtube'); trackStep(sessionId, 'platform', 'youtube') }}
                />
                <RadioCard
                  label="Both YouTube and Instagram"
                  sublabel="Long-form on YouTube, repurposed to Reels and carousels"
                  selected={platform === 'both'}
                  status={null}
                  onClick={() => { setPlatform('both'); trackStep(sessionId, 'platform', 'both') }}
                />
                <RadioCard
                  label="Instagram only"
                  sublabel="Short-form only — no long-form YouTube"
                  selected={platform === 'instagram'}
                  status={platform === 'instagram' ? 'rejected' : null}
                  onClick={() => { setPlatform('instagram'); trackStep(sessionId, 'platform', 'instagram') }}
                />
              </div>
              {platform === 'instagram' && (
                <p style={rejectedMsgStyle}>
                  Brand Gita is built around long-form YouTube — it edits your videos and repurposes them into short-form. If you don&rsquo;t have a YouTube channel yet, come back when you do.
                </p>
              )}
            </div>
          )}

          {/* Step 3: Monetisation */}
          {role !== null && !icpRejected && platform !== null && platform !== 'instagram' && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Are you already making money from your content or expertise?" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Yes — I have an offer"
                  sublabel="Courses, coaching, consulting, community, or any paid product"
                  selected={monetise === 'monetising'}
                  status={null}
                  onClick={() => { setMonetise('monetising'); trackStep(sessionId, 'monetise', 'monetising') }}
                />
                <RadioCard
                  label="Not yet — building toward it"
                  sublabel="Growing my audience and developing my offer"
                  selected={monetise === 'building'}
                  status={null}
                  onClick={() => { setMonetise('building'); trackStep(sessionId, 'monetise', 'building') }}
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
                onClick={() => { setOs('mac'); setMac(null); setWinSetup(null); setRam(null); setAi(null); trackStep(sessionId, 'os', 'mac') }}
              />
              <RadioCard
                label="Windows"
                selected={os === 'windows'}
                status={null}
                onClick={() => { setOs('windows'); setMac(null); setWinSetup(null); setRam(null); setAi(null); trackStep(sessionId, 'os', 'windows') }}
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
                '④ Mac Neo (budget range) is also not supported — it uses an A18 Pro chip (Apple\'s iPhone processor), which doesn\'t have enough processing power for local video rendering.',
              ]} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="MacBook Air, MacBook Pro, Mac mini, iMac, Mac Studio or Mac Pro"
                  sublabel="Apple M series chip"
                  selected={mac === 'pro'}
                  status={mac === 'pro' ? 'accepted' : null}
                  onClick={() => { setMac('pro'); setRam(null); setAi(null); trackStep(sessionId, 'mac', 'pro') }}
                />
                <RadioCard
                  label="Mac Neo"
                  sublabel="Apple A18 Pro chip — budget range"
                  selected={mac === 'neo'}
                  status={mac === 'neo' ? 'rejected' : null}
                  onClick={() => { setMac('neo'); setRam(null); setAi(null); trackStep(sessionId, 'mac', 'neo') }}
                />
                <RadioCard
                  label="Intel Mac"
                  sublabel="Any Mac with an Intel processor"
                  selected={mac === 'intel'}
                  status={mac === 'intel' ? 'rejected' : null}
                  onClick={() => { setMac('intel'); setRam(null); setAi(null); trackStep(sessionId, 'mac', 'intel') }}
                />
              </div>
              {mac === 'neo' && (
                <p style={rejectedMsgStyle}>
                  The Mac Neo uses an A18 Pro chip (Apple&rsquo;s iPhone processor) — not suited for the heavy local video processing Brand Gita requires. You&rsquo;d need a MacBook Air or Pro (M series) at minimum.
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
                  onClick={() => { setWinSetup('intel-nvidia'); setRam(null); setAi(null); trackStep(sessionId, 'windows', 'intel-nvidia') }}
                />
                <RadioCard
                  label="AMD Ryzen 5, 7, or 9 + NVIDIA RTX"
                  sublabel="Recommended RTX 3060 or newer · Ryzen 5000 series or newer recommended"
                  selected={winSetup === 'amd-nvidia'}
                  status={winSetup === 'amd-nvidia' ? 'accepted' : null}
                  onClick={() => { setWinSetup('amd-nvidia'); setRam(null); setAi(null); trackStep(sessionId, 'windows', 'amd-nvidia') }}
                />
                <RadioCard
                  label="Intel Core i5, i7, or i9 — no NVIDIA GPU"
                  sublabel="No dedicated GPU, or with AMD Radeon — uses Intel Quick Sync (QSV)"
                  selected={winSetup === 'intel-qsv'}
                  status={winSetup === 'intel-qsv' ? 'accepted' : null}
                  onClick={() => { setWinSetup('intel-qsv'); setRam(null); setAi(null); trackStep(sessionId, 'windows', 'intel-qsv') }}
                />
                <RadioCard
                  label="AMD Ryzen — no NVIDIA GPU"
                  sublabel="AMD Radeon or no dedicated GPU"
                  selected={winSetup === 'amd-unsupported'}
                  status={winSetup === 'amd-unsupported' ? 'rejected' : null}
                  onClick={() => { setWinSetup('amd-unsupported'); setRam(null); setAi(null); trackStep(sessionId, 'windows', 'amd-unsupported') }}
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

          {/* Step 7: RAM — shown once chip/GPU qualifies */}
          {chipQualified && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="How much RAM does your machine have?" />
              <HowToCheck steps={[
                os === 'windows'
                  ? '① Go to Settings → System → About. Look for "Installed RAM".'
                  : '① Click the Apple  menu → About This Mac. Look for "Memory".',
                '② On Mac, this is unified memory — it is shared between CPU and GPU.',
                '③ On Windows, this is your system RAM — separate from GPU VRAM.',
              ].filter(Boolean)} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="16 GB or more"
                  selected={ram === '16gb-plus'}
                  status={ram === '16gb-plus' ? 'accepted' : null}
                  onClick={() => { setRam('16gb-plus'); setAi(null); trackStep(sessionId, 'ram', '16gb-plus') }}
                />
                <RadioCard
                  label="Less than 16 GB"
                  selected={ram === 'under-16gb'}
                  status={ram === 'under-16gb' ? 'rejected' : null}
                  onClick={() => { setRam('under-16gb'); setAi(null); trackStep(sessionId, 'ram', 'under-16gb') }}
                />
              </div>
              {ram === 'under-16gb' && (
                <p style={rejectedMsgStyle}>
                  Brand Gita requires a minimum of 16 GB of RAM to run local video processing and AI models side by side. You&rsquo;d need to upgrade before applying.
                </p>
              )}
            </div>
          )}

          {/* Step 8: AI — only shown when hardware is compatible */}
          {hardwareComplete && (
            <div style={{ marginBottom: '1.5rem' }}>
              <StepLabel text="Do you have an active AI subscription?" />
              <p style={{ fontSize: '0.8rem', color: COLORS.softText, fontWeight: 300, lineHeight: 1.55, marginBottom: '0.75rem', marginTop: '-0.25rem' }}>
                Brand Gita uses your own AI — you bring the key, we do the work.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <RadioCard
                  label="Claude (Anthropic)"
                  sublabel="Pro plan minimum · Max recommended"
                  selected={ai === 'claude'}
                  status={ai === 'claude' ? 'accepted' : null}
                  onClick={() => { setAi('claude'); trackStep(sessionId, 'ai', 'claude') }}
                />
                <RadioCard
                  label="ChatGPT / OpenAI"
                  sublabel="ChatGPT Plus, GPT-4, or OpenAI API"
                  selected={ai === 'openai'}
                  status={ai === 'openai' ? 'accepted' : null}
                  onClick={() => { setAi('openai'); trackStep(sessionId, 'ai', 'openai') }}
                />
                <RadioCard
                  label="Google Gemini"
                  sublabel="Free tier works · Gemini Advanced recommended"
                  selected={ai === 'gemini'}
                  status={ai === 'gemini' ? 'accepted' : null}
                  onClick={() => { setAi('gemini'); trackStep(sessionId, 'ai', 'gemini') }}
                />
                <RadioCard
                  label="Ollama (local, free)"
                  sublabel="AI running on your own machine — no subscription needed"
                  selected={ai === 'ollama'}
                  status={ai === 'ollama' ? 'accepted' : null}
                  onClick={() => { setAi('ollama'); trackStep(sessionId, 'ai', 'ollama') }}
                />
                <RadioCard
                  label="None — I don't have one"
                  sublabel="I haven't signed up for an AI service yet"
                  selected={ai === 'none'}
                  status={ai === 'none' ? 'rejected' : null}
                  onClick={() => { setAi('none'); trackStep(sessionId, 'ai', 'none') }}
                />
              </div>
              {ai === 'none' && (
                <p style={rejectedMsgStyle}>
                  Brand Gita requires your own AI subscription — it runs on your account, not ours. You&rsquo;ll need to sign up for Claude, ChatGPT, or Gemini (or run Ollama locally for free) before applying.
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
