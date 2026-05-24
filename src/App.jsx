import './App.css'
import AnimatedBanner from './components/AnimatedBanner'
import Hero from './components/Hero'
import Features from './components/Features'
import FounderQuote from './components/FounderQuote'
import Comparison from './components/Comparison'
import Footer from './components/Footer'
import FAQ from './components/FAQ'

function ApplyCTA() {
  return (
    <section style={{
      width: '100%', display: 'flex', flexDirection: 'column',
      alignItems: 'center', padding: '2rem 1rem 2.5rem',
    }}>
      <p style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '0.2em',
        textTransform: 'uppercase', color: '#2196F3',
        textAlign: 'center', marginBottom: '0.75rem',
      }}>
        Founding creator applications
      </p>
      <h2 style={{
        fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)', fontWeight: 700,
        color: '#1A1A18', textAlign: 'center', marginBottom: '0.5rem',
        letterSpacing: '-0.01em', lineHeight: 1.25,
      }}>
        Get in early. Get in free.
      </h2>
      <p style={{
        fontSize: '0.9rem', color: '#4A4842', textAlign: 'center',
        fontWeight: 300, lineHeight: 1.6, marginBottom: '1.5rem', maxWidth: 420,
      }}>
        Early applicants get founding access — full product, no cost, in exchange for honest feedback.
      </p>
      <a
        href="/apply"
        style={{
          display: 'inline-block',
          padding: '0.875rem 2rem',
          fontSize: '0.9375rem', fontWeight: 600, color: '#fff',
          background: '#2196F3', borderRadius: 8, textDecoration: 'none',
          letterSpacing: '0.01em',
        }}
      >
        Apply for founding access →
      </a>
    </section>
  )
}

export default function App() {
  return (
    <div className="page">
      <AnimatedBanner />

      <Hero />

      <ApplyCTA />

      <hr className="page-divider" />

      <p className="section-label">What's included</p>
      <Features />

      <hr className="page-divider" />

      <p className="section-label">Why Brand Gita?</p>
      <Comparison />

      <FounderQuote />

      <hr className="page-divider" />

      <p className="section-label">Frequently asked questions</p>
      <FAQ />

      <Footer />
    </div>
  )
}
