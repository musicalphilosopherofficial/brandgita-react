import { useEffect } from 'react'
import { motion, useAnimation } from 'framer-motion'

// Film strip tick marks
function FilmTicks({ count = 7 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-evenly', width: '100%', height: '100%' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ width: 2, height: 20, background: '#2196F3', borderRadius: 1, opacity: 0.7 }} />
      ))}
    </div>
  )
}

// Brand Gita icon
function BrandIcon({ size = 56 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <circle cx="24" cy="44" r="16" stroke="#2196F3" strokeWidth="2" fill="none" />
      <path d="M 7 39 A 22 22 0 0 1 50 31" stroke="#2196F3" strokeWidth="2" fill="none" />
      <path d="M 11 41 A 18 18 0 0 1 46 33" stroke="#2196F3" strokeWidth="2" fill="none" />
      <line x1="8"  y1="30" x2="12" y2="31" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="11" y1="22" x2="14" y2="25" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="18" y1="16" x2="20" y2="20" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="26" y1="14" x2="27" y2="18" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="35" y1="15" x2="35" y2="19" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="43" y1="20" x2="41" y2="23" stroke="#2196F3" strokeWidth="1.6" />
      <line x1="49" y1="28" x2="46" y2="30" stroke="#2196F3" strokeWidth="1.6" />
      <g transform="rotate(-26, 48, 26)">
        <circle cx="54" cy="14" r="5" stroke="#2196F3" strokeWidth="2.6" fill="none" />
        <circle cx="54" cy="30" r="5" stroke="#2196F3" strokeWidth="2.6" fill="none" />
        <line x1="50" y1="17" x2="38" y2="26" stroke="#2196F3" strokeWidth="2.6" />
        <line x1="50" y1="27" x2="38" y2="18" stroke="#2196F3" strokeWidth="2.6" />
      </g>
    </svg>
  )
}

// ── Scissors perpendicular to the film strip ──
// Scaled down: 28×48 viewBox. Pivot at (14,22) — sits at film-strip level.
function ScissorsSVG({ blade1Ctrl, blade2Ctrl }) {
  return (
    <svg width="28" height="48" viewBox="0 0 28 48" fill="none" aria-hidden="true">
      {/* Pivot screw */}
      <circle cx="14" cy="22" r="2" fill="#2196F3" opacity="0.55" />

      {/* Blade half 1: left handle → pivot → bottom-right tip */}
      <motion.g animate={blade1Ctrl} style={{ transformOrigin: '14px 22px' }}>
        <circle cx="5" cy="5" r="4" stroke="#2196F3" strokeWidth="1.8" fill="none" />
        <line x1="5" y1="9" x2="14" y2="22" stroke="#2196F3" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="14" y1="22" x2="22" y2="45" stroke="#2196F3" strokeWidth="1.8" strokeLinecap="round" />
      </motion.g>

      {/* Blade half 2: right handle → pivot → bottom-left tip */}
      <motion.g animate={blade2Ctrl} style={{ transformOrigin: '14px 22px' }}>
        <circle cx="23" cy="5" r="4" stroke="#2196F3" strokeWidth="1.8" fill="none" />
        <line x1="23" y1="9" x2="14" y2="22" stroke="#2196F3" strokeWidth="1.8" strokeLinecap="round" />
        <line x1="14" y1="22" x2="6" y2="45" stroke="#2196F3" strokeWidth="1.8" strokeLinecap="round" />
      </motion.g>
    </svg>
  )
}

// Hair-colour stripe colours
const STRIPE_COLORS = [
  'rgba(33,150,243,0.18)',
  'rgba(33,150,243,0.40)',
  'rgba(33,150,243,0.62)',
  'rgba(33,150,243,0.24)',
]

export default function AnimatedBanner() {
  const filmCtrl         = useAnimation()
  const scissorsCtrl     = useAnimation()
  const blade1Ctrl       = useAnimation()
  const blade2Ctrl       = useAnimation()
  const filmLeftCtrl     = useAnimation()
  const filmRightCtrl    = useAnimation()
  // Three output cards
  const shortCardCtrl    = useAnimation()   // 9:16 portrait
  const longCardCtrl     = useAnimation()   // 16:9 landscape
  const carouselCardCtrl = useAnimation()   // 1:1 square
  const stripe1Ctrl      = useAnimation()
  const stripe2Ctrl      = useAnimation()
  const stripe3Ctrl      = useAnimation()
  const stripe4Ctrl      = useAnimation()
  const logoCtrl         = useAnimation()

  useEffect(() => {
    const delay = (ms) => new Promise((res) => setTimeout(res, ms))

    async function resetAll() {
      filmCtrl.set({ x: -340, opacity: 0, scale: 1 })
      scissorsCtrl.set({ opacity: 0, y: -36 })
      blade1Ctrl.set({ rotate: 0 })
      blade2Ctrl.set({ rotate: 0 })
      filmLeftCtrl.set({ x: 0, rotate: 0 })
      filmRightCtrl.set({ x: 0, rotate: 0 })
      shortCardCtrl.set({ opacity: 0, scale: 0.82 })
      longCardCtrl.set({ opacity: 0, scale: 0.82 })
      carouselCardCtrl.set({ opacity: 0, scale: 0.82 })
      stripe1Ctrl.set({ scaleX: 0 })
      stripe2Ctrl.set({ scaleX: 0 })
      stripe3Ctrl.set({ scaleX: 0 })
      stripe4Ctrl.set({ scaleX: 0 })
      logoCtrl.set({ opacity: 0, scale: 0.88 })
    }

    async function runSequence() {
      // Phase 1 — film strip slides in
      await filmCtrl.start({
        x: 0, opacity: 1,
        transition: { duration: 0.6, ease: 'easeOut' },
      })

      // Phase 2 — scissors appear above the strip, blades closed
      blade1Ctrl.set({ rotate: 0 })
      blade2Ctrl.set({ rotate: 0 })
      await scissorsCtrl.start({
        opacity: 1, y: -36,
        transition: { duration: 0.35, ease: 'easeOut' },
      })

      // Blades animate open (viewer sees the opening motion)
      blade1Ctrl.start({ rotate: 28, transition: { duration: 0.38, ease: 'easeOut' } })
      await blade2Ctrl.start({ rotate: -28, transition: { duration: 0.38, ease: 'easeOut' } })

      // Brief pause so viewer sees open scissors above the strip
      await delay(220)

      // Phase 3 — descend onto the strip with blades open
      await scissorsCtrl.start({
        y: 0,
        transition: { duration: 0.45, ease: 'easeIn' },
      })

      // Phase 4a — scissors snap shut (CUT) — await before film reacts
      blade1Ctrl.start({ rotate: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.6, 1] } })
      await blade2Ctrl.start({ rotate: 0, transition: { duration: 0.18, ease: [0.4, 0, 0.6, 1] } })

      // Tiny beat — the moment of the cut
      await delay(60)

      // Phase 4b — cut ends droop DOWN (gravity), outer edges stay put
      filmLeftCtrl.start({ x: -6, rotate: 22, transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] } })
      await filmRightCtrl.start({ x: 6, rotate: -22, transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] } })

      // Hold so viewer sees the drooped/cut strip before transition
      await delay(320)

      // Phase 5a — scissors fade out, all three cards appear
      scissorsCtrl.start({ opacity: 0, y: 0, transition: { duration: 0.25 } })
      filmCtrl.start({ opacity: 0, transition: { duration: 0.25 } })

      shortCardCtrl.start({
        opacity: 1, scale: 1,
        transition: { duration: 0.38, ease: 'easeOut' },
      })
      longCardCtrl.start({
        opacity: 1, scale: 1,
        transition: { duration: 0.38, ease: 'easeOut', delay: 0.08 },
      })
      await carouselCardCtrl.start({
        opacity: 1, scale: 1,
        transition: { duration: 0.38, ease: 'easeOut', delay: 0.16 },
      })

      // Phase 5b — hair-colour stripes sweep onto carousel card
      await delay(100)
      await stripe1Ctrl.start({ scaleX: 1, transition: { duration: 0.26, ease: 'easeOut' } })
      await stripe2Ctrl.start({ scaleX: 1, transition: { duration: 0.26, ease: 'easeOut' } })
      await stripe3Ctrl.start({ scaleX: 1, transition: { duration: 0.26, ease: 'easeOut' } })
      await stripe4Ctrl.start({ scaleX: 1, transition: { duration: 0.26, ease: 'easeOut' } })

      // Hold — viewer reads all three outputs
      await delay(1800)

      // Phase 6 — cards out, logo springs in
      shortCardCtrl.start({ opacity: 0, scale: 0.85, transition: { duration: 0.28 } })
      longCardCtrl.start({ opacity: 0, scale: 0.85, transition: { duration: 0.28 } })
      carouselCardCtrl.start({ opacity: 0, scale: 0.85, transition: { duration: 0.28 } })
      await logoCtrl.start({
        opacity: 1, scale: 1,
        transition: { duration: 0.6, type: 'spring', stiffness: 200, damping: 22, delay: 0.12 },
      })
    }

    async function loop() {
      while (true) {
        await resetAll()
        await runSequence()
        await delay(2200)
        await logoCtrl.start({ opacity: 0, transition: { duration: 0.4 } })
        await delay(150)
      }
    }

    loop()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      marginBottom: '2.5rem',
      minHeight: 140,
      position: 'relative',
    }}>
      <div style={{ position: 'relative', width: '100%', height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {/* ── Film strip — two independent halves that split and bend at cut ── */}
        <motion.div
          initial={{ x: -340, opacity: 0 }}
          animate={filmCtrl}
          style={{
            position: 'absolute',
            width: 320,
            height: 36,
            display: 'flex',
          }}
        >
          {/* Left half — pivots at outer left edge, cut end falls down */}
          <motion.div
            animate={filmLeftCtrl}
            style={{
              width: '50%', height: '100%',
              border: '1.5px solid #2196F3',
              borderRight: 'none',
              borderRadius: '4px 0 0 4px',
              background: '#EBE7DB',
              display: 'flex', alignItems: 'center',
              transformOrigin: 'left center',
            }}
          >
            <FilmTicks count={4} />
          </motion.div>
          {/* Right half — pivots at outer right edge, cut end falls down */}
          <motion.div
            animate={filmRightCtrl}
            style={{
              width: '50%', height: '100%',
              border: '1.5px solid #2196F3',
              borderLeft: 'none',
              borderRadius: '0 4px 4px 0',
              background: '#EBE7DB',
              display: 'flex', alignItems: 'center',
              transformOrigin: 'right center',
            }}
          >
            <FilmTicks count={4} />
          </motion.div>
        </motion.div>

        {/* ── Scissors — starts above strip, descends to cut ── */}
        <motion.div
          initial={{ opacity: 0, y: -36 }}
          animate={scissorsCtrl}
          style={{ position: 'absolute', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <ScissorsSVG blade1Ctrl={blade1Ctrl} blade2Ctrl={blade2Ctrl} />
        </motion.div>

        {/* ── Short-form card — 9:16 portrait ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.82, x: 0 }}
          animate={shortCardCtrl}
          style={{
            position: 'absolute',
            x: 0,
            width: 42,
            height: 76,
            border: '1.5px solid #2196F3',
            borderRadius: 6,
            background: '#F4F0E8',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            transformOrigin: 'center',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <polygon points="3,2 11,6.5 3,11" fill="#2196F3" opacity="0.75" />
          </svg>
          <span style={{ fontSize: 6, fontWeight: 700, letterSpacing: '0.07em', color: '#2196F3', textAlign: 'center', lineHeight: 1.35 }}>
            SHORT<br/>FORM<br/><span style={{ opacity: 0.6 }}>9:16</span>
          </span>
          {/* Platform icons */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 2 }}>
            {/* Instagram */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-label="Instagram">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" stroke="#2196F3" strokeWidth="2" fill="none" opacity="0.8"/>
              <circle cx="12" cy="12" r="4.5" stroke="#2196F3" strokeWidth="2" fill="none" opacity="0.8"/>
              <circle cx="17.5" cy="6.5" r="1.2" fill="#2196F3" opacity="0.8"/>
            </svg>
            {/* TikTok */}
            <svg width="10" height="11" viewBox="0 0 24 26" fill="none" aria-label="TikTok">
              <path d="M17 1c.5 3 2.5 5 5 5.5v4c-1.8 0-3.5-.5-5-1.5V18c0 4.4-3.6 8-8 8S1 22.4 1 18s3.6-8 8-8c.5 0 1 0 1.5.1V14c-.5-.1-1-.1-1.5-.1-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4V1h4z"
                stroke="#2196F3" strokeWidth="1.8" fill="none" strokeLinejoin="round" opacity="0.8"/>
            </svg>
          </div>
        </motion.div>

        {/* ── Long-form card — 16:9 landscape ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.82, x: -114 }}
          animate={longCardCtrl}
          style={{
            position: 'absolute',
            x: -114,
            width: 76,
            height: 44,
            border: '1.5px solid #2196F3',
            borderRadius: 6,
            background: '#F4F0E8',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
            transformOrigin: 'center',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <polygon points="3,2 11,6.5 3,11" fill="#2196F3" opacity="0.75" />
          </svg>
          <span style={{ fontSize: 6, fontWeight: 700, letterSpacing: '0.07em', color: '#2196F3', textAlign: 'center', lineHeight: 1.35 }}>
            LONG FORM<br/><span style={{ opacity: 0.6 }}>16:9</span>
          </span>
        </motion.div>

        {/* ── Carousel card — 1:1 square with hair-colour stripes ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.82, x: 109 }}
          animate={carouselCardCtrl}
          style={{
            position: 'absolute',
            x: 109,
            width: 66,
            height: 66,
            border: '1.5px solid #2196F3',
            borderRadius: 6,
            background: '#F4F0E8',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            transformOrigin: 'center',
          }}
        >
          <div style={{
            fontSize: 6, fontWeight: 700, letterSpacing: '0.08em', color: '#2196F3',
            textAlign: 'center', padding: '4px 0 2px', flexShrink: 0,
          }}>
            CAROUSEL · 1:1
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '2px 4px 4px' }}>
            {[stripe1Ctrl, stripe2Ctrl, stripe3Ctrl, stripe4Ctrl].map((ctrl, i) => (
              <div key={i} style={{ flex: 1, borderRadius: 2, overflow: 'hidden', background: 'rgba(33,150,243,0.08)' }}>
                <motion.div
                  initial={{ scaleX: 0 }}
                  animate={ctrl}
                  style={{
                    width: '100%', height: '100%',
                    background: STRIPE_COLORS[i],
                    borderRadius: 2,
                    transformOrigin: 'left center',
                  }}
                />
              </div>
            ))}
          </div>
        </motion.div>

        {/* ── Final logo ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.88 }}
          animate={logoCtrl}
          style={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: '1rem' }}
        >
          <BrandIcon size={56} />
          <div style={{ width: 1, height: 52, background: '#D0CBC0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: '1.75rem', fontWeight: 700, color: '#2196F3', letterSpacing: '-0.02em', lineHeight: 1.1 }}>
              BrandGita
            </span>
            <span style={{ fontSize: '0.62rem', fontWeight: 600, letterSpacing: '0.16em', color: '#1A1A18', textTransform: 'uppercase' }}>
              Your Brand's Personal Stylist
            </span>
          </div>
        </motion.div>

      </div>
    </div>
  )
}
