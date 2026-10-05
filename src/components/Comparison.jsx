function B({ children }) {
  return <strong style={{ color: '#1A1A18', fontWeight: 700 }}>{children}</strong>
}

function ListItem({ children }) {
  return (
    <li style={{
      fontSize: '0.8rem',
      fontWeight: 300,
      color: '#6E6B62',
      lineHeight: 1.5,
      padding: '0.28rem 0',
      borderTop: '1px solid #E8E3D8',
      listStyle: 'none',
    }}>
      {children}
    </li>
  )
}

const COL_BASE = {
  background: '#F4F0E8',
  border: '1px solid #D8D3C8',
  borderRadius: 6,
  padding: '1rem',
}

const COL_HIGHLIGHT = {
  ...COL_BASE,
  border: '1px solid #2196F3',
}

export default function Comparison() {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '0.6rem',
      width: '100%',
      marginBottom: '2.75rem',
    }}>

      {/* With Brand Gita */}
      <div style={COL_HIGHLIGHT}>
        <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#2196F3', marginBottom: '0.2rem' }}>With Brand Gita</p>
        <p style={{ fontSize: '0.72rem', fontWeight: 400, color: '#9B9789', marginBottom: '0.75rem', lineHeight: 1.4 }}>
          One interview. Every piece of content, forever.
        </p>
        <ul style={{ margin: 0, padding: 0 }}>
          <ListItem><B>No design skills needed</B></ListItem>
          <ListItem>Brand voice captured in a <B>one-time interview</B> — <B>every carousel inherits it, no re-briefing, ever</B></ListItem>
          <ListItem><B>Style profiles lock in your look</B> — every new post follows it</ListItem>
          <ListItem><B>Raw ideas and long-form</B> become <B>30 days of content</B></ListItem>
          <ListItem><B>Content bank</B> keeps every idea — your content plans are made from it</ListItem>
          <ListItem>Recommends what to post — <B>you always have the final say</B></ListItem>
          <ListItem>Carousels, captions — <B>all on-brand</B></ListItem>
          <ListItem>Your own photos and videos, <B>turned into personal story carousels</B></ListItem>
          <ListItem><B>No manual uploads</B> — <B>auto schedules and publishes to all your social platforms</B>, one tap to go live</ListItem>
        </ul>
      </div>

      {/* Without it */}
      <div style={COL_BASE}>
        <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#1A1A18', marginBottom: '0.2rem' }}>Without it</p>
        <p style={{ fontSize: '0.72rem', fontWeight: 400, color: '#9B9789', marginBottom: '0.75rem', lineHeight: 1.4 }}>
          Every other tool, workflow, or workaround
        </p>
        <ul style={{ margin: 0, padding: 0 }}>
          <li style={{ fontSize: '0.8rem', fontWeight: 300, color: '#6E6B62', lineHeight: 1.5, padding: '0.28rem 0', listStyle: 'none' }}>
            <B>Generic output</B> — sounds like the tool, not like you
          </li>
          <ListItem><B>Hours spent editing and repurposing</B> — or hours of prompting — same result</ListItem>
          <ListItem>Output <B>looks like everyone else</B> no matter what you try</ListItem>
          <ListItem><B>One video in, one post out</B> — repurposing is a separate job</ListItem>
          <ListItem><B>Ideas scattered</B> across notes, chats and screenshots</ListItem>
          <ListItem><B>Rebuild your preferences</B> from scratch every session</ListItem>
          <ListItem><B>Design, export, re-upload, publish</B> — four steps, every time</ListItem>
          <ListItem><B>Hiring editors and freelancers</B> — train them, they leave, start over</ListItem>
        </ul>
      </div>

    </div>
  )
}
