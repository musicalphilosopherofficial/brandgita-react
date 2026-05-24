import './App.css'
import AnimatedBanner from './components/AnimatedBanner'
import Hero from './components/Hero'
import Features from './components/Features'
import FounderQuote from './components/FounderQuote'
import Comparison from './components/Comparison'
import Footer from './components/Footer'
import FAQ from './components/FAQ'

export default function App() {
  return (
    <div className="page">
      <AnimatedBanner />

      <Hero />

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
