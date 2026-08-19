import SiteFooter from '../SiteFooter'
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
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            The service is built to meet the following, and each is checked automatically on every
            change &mdash; see &ldquo;How we tested this service&rdquo; below.
          </p>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Keyboard navigation throughout the chat interface</li>
            <li>Skip-to-content link for keyboard and screen reader users</li>
            <li>ARIA landmarks, and a live region for content that arrives as it is generated</li>
            <li>Sufficient colour contrast ratios (minimum 4.5:1 for text)</li>
            <li>Visible focus indicators for interactive elements</li>
            <li>Semantic HTML structure with appropriate heading hierarchy</li>
            <li>Alternative text on images</li>
            <li>Form inputs with associated labels</li>
            <li>No time-limited content</li>
            <li>No flashing content</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Known Limitations</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Network graph visualisations (SVG) convey information visually that may not be fully available to screen reader users, though graph titles and labels are provided as text.</li>
            <li>AI-generated content may occasionally produce complex formatting that is not optimally structured for assistive technology.</li>
            <li>
              Alternative text for images in an answer is derived from Virtual Fly Brain&rsquo;s own
              data, so it names the structure shown rather than describing the image. Automated
              checking confirms that alternative text is present; it cannot confirm that it is
              useful, and that has not yet been assessed by a person.
            </li>
            <li>
              Announcement of an answer as it is generated has not been verified with a screen
              reader. The interface uses a live region for this, but whether the announcement is
              timely and not repetitive is not something automated checking can establish.
            </li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>What We Have Not Yet Tested</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            We would rather say what has not been checked than imply that it has. The following are
            outstanding, and we expect to complete them before the service is publicly launched:
          </p>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Testing with screen readers (JAWS, NVDA and VoiceOver) by a person</li>
            <li>Testing with voice recognition software</li>
            <li>Reflow and readability at 400% zoom with a long answer containing tables</li>
            <li>Whether generated link text and alternative text make sense out of context</li>
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
          <h2 style={{ color: '#fff' }}>How We Tested This Service</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Every page of this service &mdash; the chat interface, this statement, the privacy
            notice and the terms of use &mdash; is tested automatically against WCAG 2.2 Level AA
            using axe-core, driven through a real browser. The chat interface is tested twice: once
            as it first loads, and once with an answer displayed, so that the answer text, result
            tables, image gallery, citations, response identifier and feedback controls are covered
            rather than only the empty page. The test runs on every proposed change to the service
            and a change is not accepted while any violation is outstanding.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Automated testing of this kind detects somewhere between a third and a half of WCAG
            issues. It is a floor rather than a certificate: judgements about focus order,
            meaningful sequence, error identification and the usefulness of alternative text still
            require a person, which is why the section above says what has not yet been tested.
            Testing was carried out by the Virtual Fly Brain team at the University of Edinburgh.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Preparation of This Statement</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            This statement was first prepared on 26 March 2026 and was last reviewed on 19 August
            2026. We review it at least every 12 months, and whenever the service changes in a way
            that affects the statements made here.
          </p>
        </section>

        <p style={{ marginTop: '28px' }}>
          <a href="/" style={{ color: '#66d9ff', textDecoration: 'underline' }}>Back to VFB Chat</a>
        </p>
        <SiteFooter />
      </div>
    </main>
  )
}
