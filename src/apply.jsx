import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Waitlist from './components/Waitlist'
import './index.css'

function ApplyPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#EBE7DB',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'flex-start',
      paddingTop: '3rem',
      paddingBottom: '3rem',
    }}>
      {/* Wordmark */}
      <a href="/" style={{
        fontSize: '1.125rem',
        fontWeight: 700,
        color: '#1A1A18',
        textDecoration: 'none',
        letterSpacing: '-0.01em',
        marginBottom: '2.5rem',
      }}>
        Brand Gita
      </a>

      {/* Form — full width on mobile, capped on desktop */}
      <div style={{ width: '100%', maxWidth: 480, padding: '0 1rem' }}>
        <Waitlist />
      </div>
    </div>
  )
}

createRoot(document.getElementById('apply-root')).render(
  <StrictMode>
    <ApplyPage />
  </StrictMode>
)
