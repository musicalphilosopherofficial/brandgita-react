import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './premium.css'
import Premium from './Premium'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Premium />
  </StrictMode>,
)
