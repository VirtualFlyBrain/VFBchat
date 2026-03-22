export const metadata = {
  title: 'VFB Chat Privacy Notice',
  description: 'Additional privacy information for VFB Chat'
}

export default function PrivacyPage() {
  return (
    <main style={{
      minHeight: '100vh',
      backgroundColor: '#000',
      color: '#e0e0e0',
      padding: '32px 20px 48px',
      boxSizing: 'border-box'
    }}>
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>
        <h1 style={{ color: '#fff', marginTop: 0 }}>VFB Chat Privacy Notice</h1>
        <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
          VFB Chat is a public-facing AI-assisted interface to Virtual Fly Brain data.
        </p>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>What We Collect</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>IP address for rate limiting, security, and abuse prevention.</li>
            <li>Limited technical and usage metadata such as timestamps, response time, response length, tool usage counts, and blocked-domain audit events.</li>
            <li>Optional structured user feedback such as thumbs up/down and fixed reason codes.</li>
            <li>If you explicitly choose to attach a conversation while reporting a problem, we collect that visible chat transcript for investigation.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>What We Do Not Collect By Default</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>We do not require user accounts or logins.</li>
            <li>We do not store full free-text chat queries or full AI responses as routine analytics.</li>
            <li>We do not store user feedback comments as free text.</li>
            <li>We do not attach a conversation transcript to feedback unless you explicitly choose to do so.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>How We Use This Information</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>To protect the service from abuse and ensure availability through rate limiting and security monitoring.</li>
            <li>To understand usage at an aggregated level and improve the service.</li>
            <li>To measure usefulness with optional structured feedback.</li>
            <li>To investigate reported problems when a user explicitly attaches a conversation transcript.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Data Sharing</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>AI processing is performed via the University-supported ELM platform.</li>
            <li>Google Analytics may be used for aggregated service metrics without sending user free-text chat content.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Retention</h2>
          <ul style={{ lineHeight: 1.7 }}>
            <li>Raw security and abuse-prevention logs, including IP addresses, are retained for up to 30 days and then deleted.</li>
            <li>Aggregated institutional usage statistics, structured service metrics, and structured user feedback are retained for up to 26 months.</li>
            <li>Conversation transcripts attached to problem reports are stored separately and retained for up to 30 days.</li>
          </ul>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Your Rights and Contact</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            For the main Virtual Fly Brain website privacy notice and broader policy information, see{' '}
            <a
              href="https://www.virtualflybrain.org/about/privacy/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#66d9ff', textDecoration: 'underline' }}
            >
              the main VFB Privacy Notice
            </a>.
          </p>
          <div style={{
            marginTop: '14px',
            padding: '16px',
            backgroundColor: '#0f0f0f',
            border: '1px solid #222',
            borderRadius: '8px'
          }}>
            <p style={{ marginTop: 0, marginBottom: '10px', color: '#fff', fontWeight: 600 }}>
              Official privacy contacts
            </p>
            <p style={{ margin: '0 0 8px 0', color: '#b8b8b8', lineHeight: 1.6 }}>
              Data Protection Officer
              <br />
              University of Edinburgh
              <br />
              Old College
              <br />
              South Bridge
              <br />
              Edinburgh EH8 9YL
              <br />
              Email: <a href="mailto:dpo@ed.ac.uk" style={{ color: '#66d9ff' }}>dpo@ed.ac.uk</a>
            </p>
            <p style={{ margin: 0, color: '#b8b8b8', lineHeight: 1.6 }}>
              VFB Project Team
              <br />
              Email: <a href="mailto:data@virtualflybrain.org" style={{ color: '#66d9ff' }}>data@virtualflybrain.org</a>
            </p>
          </div>
        </section>
      </div>
    </main>
  )
}
