const faqs = [
  {
    q: 'Who is this for?',
    a: "Entrepreneurs, coaches, and educators who do long-form YouTube — and find the whole production cycle exhausting. You've either spent hours editing yourself, handed it off to an editor who didn't quite get your style, or tried an AI tool that churned out something generic. The long-form edit drains you, and by the time it's done, repurposing it into Reels, Shorts, and carousels feels impossible. Brand Gita handles both — the long-form edit and the short-form repurposing — in your voice, not a template's.",
  },
  {
    q: 'Who is it not for?',
    a: "It's not for lifestyle vloggers, day-in-the-life creators, or anyone whose content is primarily entertainment. If you don't have a specific expertise or perspective you're trying to teach, Brand Gita doesn't have much to work with. It's also not for text-only content — it's built around video you recorded yourself.",
  },
  {
    q: 'Do you use your own AI or mine?',
    a: 'Yours. Brand Gita works with Claude, Google Gemini, and Ollama in V1 — no API keys to manage. For Claude, a Pro subscription is the minimum; Max is recommended for heavy editing sessions. For Gemini, a free Google account is enough to run the CLI; Gemini Advanced is recommended for heavier use. Ollama is free.',
  },
  {
    q: 'What is the brand interview?',
    a: 'A one-time onboarding session where Brand Gita learns your voice, aesthetic, and style. Every clip, carousel, and caption it produces after that is filtered through it. No re-briefing, ever.',
  },
  {
    q: 'What platforms does it publish to?',
    a: 'YouTube and Instagram in V1, directly — no third-party scheduler. TikTok and LinkedIn carousels are coming next.',
  },
  {
    q: 'What do I need to get started?',
    a: 'Your video, and at least one of: Claude Pro or higher, Google Gemini (free Google account or above), Ollama, or ChatGPT / OpenAI. Hardware requirements are on the application form.',
  },
  {
    q: 'When can I get access?',
    a: (
      <>
        <a href="/apply" style={{ color: '#2196F3' }}>Apply for founding access →</a>
      </>
    ),
  },
]

export default function FAQ() {
  return (
    <div style={{ width: '100%', marginBottom: '4rem' }}>
      {faqs.map((item, i) => (
        <div
          key={i}
          style={{
            borderTop: '1px solid #D0CBC0',
            borderBottom: i === faqs.length - 1 ? '1px solid #D0CBC0' : 'none',
            padding: '1.1rem 0',
          }}
        >
          <p style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1A1A18', marginBottom: '0.45rem' }}>
            {item.q}
          </p>
          <p style={{ fontSize: '0.85rem', fontWeight: 300, color: '#4A4842', lineHeight: 1.65 }}>
            {item.a}
          </p>
        </div>
      ))}
    </div>
  )
}
