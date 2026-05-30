import { useState, useEffect } from 'react'

const COLORS = {
  ink: '#1A1A18',
  softText: '#4A4842',
  faint: '#7A6F63',
  blue: '#2196F3',
  border: '#D4CFC4',
  bg: '#FDFCF9',
  green: '#27AE60',
  amber: '#9A4D00',
  amberBg: '#FFF4E5',
  amberBorder: '#FFE0B2',
}

// ─── OFFER CONFIG — REVIEW BEFORE DEPLOYING ────────────────────────────
// This price IS the test. You're measuring who reaches for their wallet at
// THIS number, inside the priority window. Change these to set the offer.
const OFFER = {
  launchPrice: '$97',          // struck-through — the public price everyone else pays
  foundingPrice: '$49',        // founding rate, locked for life (board verdict 2026-05-30)
  billing: '/mo',              // '/mo' or ' one-time'
  seatsTotal: 20,              // real founding-seat cap
  priorityWindowMinutes: 5,    // minutes they have to lock priority once the form ends
}

// Decoy payment methods. These are buttons, not links. Clicking one records the
// intent signal and fires the disclosure modal. They NEVER redirect to a real
// processor and NEVER render a card field — that is the legal safety line.
const METHODS = [
  { id: 'card',       label: 'Pay with card' },
  { id: 'paypal',     label: 'PayPal' },
  { id: 'apple_pay',  label: 'Apple Pay' },
  { id: 'google_pay', label: 'Google Pay' },
]

function formatTime(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function Checkout({ email, name }) {
  const [showModal, setShowModal] = useState(false)

  // The priority window opens the moment this screen appears (i.e. the moment
  // they finish the form), resolved once at mount from localStorage so a refresh
  // can't reset it — the deadline is real, per applicant.
  const [deadline] = useState(() => {
    const key = `bg_priority_deadline_${email || 'anon'}`
    const now = Date.now()
    let d = Number(localStorage.getItem(key))
    if (!d || d < now) d = now + OFFER.priorityWindowMinutes * 60 * 1000
    return d
  })
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()))

  // Persist the deadline (write is the side effect) and tick the countdown.
  useEffect(() => {
    localStorage.setItem(`bg_priority_deadline_${email || 'anon'}`, String(deadline))
    const id = setInterval(() => {
      const r = deadline - Date.now()
      setRemaining(Math.max(0, r))
      if (r <= 0) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [email, deadline])

  const expired = remaining <= 0

  async function handlePick(method) {
    // Disclosure shows immediately and unconditionally on click.
    setShowModal(true)
    // Recording the signal is best-effort and never blocks the disclosure.
    try {
      await fetch('/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, method }),
      })
    } catch {
      /* signal is best-effort; the disclosure is already on screen */
    }
  }

  const firstName = name ? name.split(' ')[0] : 'there'

  return (
    <section style={{
      width: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', padding: '1rem 1rem 2.5rem',
    }}>
      <div style={{ width: '100%', maxWidth: 420 }}>

        <p style={badgeStyle}>You&rsquo;re compatible — claim your founding seat</p>

        <div style={cardStyle}>

          {/* Priority window countdown */}
          <div style={expired ? timerExpiredStyle : timerStyle}>
            {expired ? (
              'Priority window closed'
            ) : (
              <>
                <span aria-hidden="true">⏳</span>
                <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{formatTime(remaining)}</strong>
                <span>left to lock priority access</span>
              </>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <p style={{
              fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: COLORS.blue, margin: 0,
            }}>
              Founding creator
            </p>
            <span style={seatPillStyle}>{OFFER.seatsTotal} founding seats</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginTop: '0.7rem' }}>
            <span style={{ fontSize: '2.4rem', fontWeight: 800, color: COLORS.ink, letterSpacing: '-0.02em' }}>
              {OFFER.foundingPrice}
            </span>
            <span style={{ fontSize: '1rem', color: COLORS.faint, textDecoration: 'line-through' }}>
              {OFFER.launchPrice}
            </span>
            <span style={{ fontSize: '0.95rem', color: COLORS.softText }}>{OFFER.billing}</span>
          </div>

          <p style={{ fontSize: '0.82rem', color: COLORS.green, fontWeight: 600, margin: '0.4rem 0 0' }}>
            Locked for life at {OFFER.foundingPrice}{OFFER.billing} — everyone else pays {OFFER.launchPrice}{OFFER.billing}.
          </p>

          <ul style={listStyle}>
            {[
              'Early access before public launch',
              'Everything happens in front of you — no black box',
              'A direct line to shape what we build',
              'Founding price locked — it never goes up',
            ].map((item, i) => (
              <li key={i} style={liStyle}>
                <span style={checkStyle}>✓</span>
                {item}
              </li>
            ))}
          </ul>

          <div style={dueRowStyle}>
            <span>Due today</span>
            <span style={{ fontWeight: 800, color: COLORS.ink }}>{OFFER.foundingPrice}</span>
          </div>

          {expired ? (
            <div style={closedBoxStyle}>
              Your {OFFER.priorityWindowMinutes}-minute priority window has closed. You&rsquo;re still on the
              waitlist — we&rsquo;ll be in touch when founding access opens.
            </div>
          ) : (
            <>
              <p style={{
                fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em',
                textTransform: 'uppercase', color: COLORS.faint, margin: '0.25rem 0 0.75rem',
              }}>
                Choose how to pay
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                {METHODS.map(m => (
                  <button key={m.id} type="button" onClick={() => handlePick(m.id)} style={payBtnStyle}>
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <p style={{
          fontSize: '0.75rem', color: COLORS.faint, textAlign: 'center',
          marginTop: '0.9rem', fontWeight: 300, lineHeight: 1.5,
        }}>
          Cancel anytime · your founding price is locked for life.
        </p>
      </div>

      {showModal && (
        <DisclosureModal firstName={firstName} onClose={() => setShowModal(false)} />
      )}
    </section>
  )
}

function DisclosureModal({ firstName, onClose }) {
  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✋</div>
        <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: COLORS.ink, margin: '0 0 0.6rem', lineHeight: 1.3 }}>
          Hold on, {firstName} — this was a test.
        </h3>
        <p style={modalP}>
          You haven&rsquo;t been charged, and we never asked for a card. Brand Gita isn&rsquo;t open for purchase yet.
        </p>
        <p style={modalP}>
          We wanted to see who&rsquo;s genuinely ready — and you just showed us. Because you reached for your wallet,
          you&rsquo;re <strong style={{ color: COLORS.ink }}>first in line for one of {OFFER.seatsTotal} founding
          seats at half price</strong> the moment we open.
        </p>
        <p style={{ ...modalP, marginTop: '0.9rem' }}>
          We&rsquo;ll <strong style={{ color: COLORS.ink }}>reach out personally</strong> when founding access opens
          — keep an eye on your inbox.
        </p>
        <button type="button" onClick={onClose} style={modalBtn}>Got it</button>
      </div>
    </div>
  )
}

const badgeStyle = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.16em',
  textTransform: 'uppercase', color: COLORS.green,
  textAlign: 'center', marginBottom: '1rem',
}

const cardStyle = {
  background: COLORS.bg, border: `1.5px solid ${COLORS.border}`,
  borderRadius: 14, padding: '1.5rem 1.375rem',
}

const timerStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
  fontSize: '0.85rem', color: COLORS.amber, background: COLORS.amberBg,
  border: `1px solid ${COLORS.amberBorder}`, borderRadius: 9,
  padding: '0.55rem 0.75rem', marginBottom: '1.1rem', fontWeight: 500,
}

const timerExpiredStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: '0.85rem', color: COLORS.faint, background: '#F0EDE6',
  border: `1px solid ${COLORS.border}`, borderRadius: 9,
  padding: '0.55rem 0.75rem', marginBottom: '1.1rem', fontWeight: 500,
}

const seatPillStyle = {
  fontSize: 11, fontWeight: 600, color: COLORS.amber,
  background: COLORS.amberBg, border: `1px solid ${COLORS.amberBorder}`,
  borderRadius: 999, padding: '3px 9px', whiteSpace: 'nowrap',
}

const listStyle = {
  listStyle: 'none', padding: 0, margin: '1.125rem 0 1.25rem',
  display: 'flex', flexDirection: 'column', gap: '0.55rem',
}

const liStyle = {
  fontSize: '0.875rem', color: COLORS.softText, fontWeight: 400,
  lineHeight: 1.4, display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
}

const checkStyle = {
  flexShrink: 0, color: COLORS.green, fontWeight: 700,
  fontSize: '0.9rem', lineHeight: 1.4,
}

const dueRowStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  fontSize: '0.9rem', color: COLORS.softText, fontWeight: 500,
  padding: '0.75rem 0', borderTop: `1px solid ${COLORS.border}`, marginTop: '0.25rem',
}

const closedBoxStyle = {
  fontSize: '0.875rem', color: COLORS.softText, lineHeight: 1.6, fontWeight: 300,
  background: '#F5F2EC', border: `1px solid ${COLORS.border}`,
  borderRadius: 9, padding: '0.9rem 1rem', marginTop: '0.25rem',
}

const payBtnStyle = {
  width: '100%', padding: '0.875rem 1rem', fontSize: '0.9375rem',
  fontWeight: 600, color: COLORS.ink, background: '#fff',
  border: `1.5px solid ${COLORS.border}`, borderRadius: 9,
  cursor: 'pointer', fontFamily: 'inherit', transition: 'border-color 0.15s, background 0.15s',
}

const overlayStyle = {
  position: 'fixed', inset: 0, background: 'rgba(26,26,24,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '1.5rem', zIndex: 1000,
}

const modalStyle = {
  background: COLORS.bg, borderRadius: 16, padding: '2rem 1.75rem',
  maxWidth: 400, width: '100%', textAlign: 'left',
  boxShadow: '0 12px 48px rgba(0,0,0,0.25)',
}

const modalP = {
  fontSize: '0.9rem', color: COLORS.softText, lineHeight: 1.6,
  fontWeight: 300, margin: '0 0 0.6rem',
}

const modalBtn = {
  marginTop: '1.25rem', width: '100%', padding: '0.875rem 1rem',
  fontSize: '0.9375rem', fontWeight: 600, color: '#fff',
  background: COLORS.blue, border: 'none', borderRadius: 9,
  cursor: 'pointer', fontFamily: 'inherit',
}
