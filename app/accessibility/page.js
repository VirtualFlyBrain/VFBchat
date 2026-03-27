export const metadata = {
  title: 'VFB Chat Accessibility Statement',
  description: 'Accessibility statement for VFB Chat'
}

export default function AccessibilityPage() {
  return (
    <main style={{
      minHeight: '100vh',
      backgroundColor: '#000',
      color: '#e0e0e0',
      padding: '32px 20px 48px',
      boxSizing: 'border-box'
    }}>
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>
        <h1 style={{ color: '#fff', marginTop: 0 }}>Accessibility Statement</h1>
        <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
          This accessibility statement applies to VFB Chat (<a href="https://chat.virtualflybrain.org" style={{ color: '#66d9ff' }}>chat.virtualflybrain.org</a>).
          This service is run by the Virtual Fly Brain project at the University of Edinburgh.
        </p>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Compliance Status</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            We aim to make this website accessible in accordance with the Public Sector Bodies
            (Websites and Mobile Applications) (No. 2) Accessibility Regulations 2018 and
            the Web Content Accessibility Guidelines (WCAG) 2.2 at Level AA.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            This website is partially compliant with the WCAG 2.2 Level AA standard.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>What We Do to Ensure Accessibility</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Full keyboard navigation throughout the chat interface</li>
            <li>Skip-to-content link for keyboard and screen reader users</li>
            <li>Proper ARIA landmarks and live regions for dynamic content</li>
            <li>Sufficient colour contrast ratios (minimum 4.5:1 for text)</li>
            <li>Visible focus indicators for interactive elements</li>
            <li>Semantic HTML structure with appropriate heading hierarchy</li>
            <li>Alternative text for images</li>
            <li>Accessible form inputs with associated labels</li>
            <li>No time-limited content</li>
            <li>No flashing content</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Known Limitations</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Network graph visualisations (SVG) convey information visually that may not be fully available to screen reader users, though graph titles and labels are provided as text.</li>
            <li>AI-generated content may occasionally produce complex formatting that is not optimally structured for assistive technology.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Feedback and Contact</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            If you encounter any accessibility barriers when using this website, please contact us:
          </p>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Email: <a href="mailto:data@virtualflybrain.org" style={{ color: '#66d9ff' }}>data@virtualflybrain.org</a></li>
          </ul>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            We aim to respond to accessibility feedback within 5 working days.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Enforcement Procedure</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            The Equality and Human Rights Commission (EHRC) is responsible for enforcing the
            Public Sector Bodies (Websites and Mobile Applications) (No. 2) Accessibility
            Regulations 2018. If you are not happy with how we respond to your complaint, contact
            the{' '}
            <a
              href="https://www.equalityadvisoryservice.com/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#66d9ff', textDecoration: 'underline' }}
            >
              Equality Advisory and Support Service (EASS)
            </a>.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Preparation of This Statement</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            This statement was prepared on 26 March 2026. It was last reviewed on 26 March 2026.
          </p>
        </section>

        <p style={{ marginTop: '28px' }}>
          <a href="/" style={{ color: '#66d9ff', textDecoration: 'underline' }}>Back to VFB Chat</a>
        </p>
      </div>
    </main>
  )
}
