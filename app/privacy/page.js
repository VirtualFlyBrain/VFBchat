import SiteFooter from '../SiteFooter'
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
          <h2 style={{ color: '#fff' }}>Who is responsible for your data</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            The <strong>University of Edinburgh</strong> is the data controller for the personal data
            described in this notice. The University is registered with the Information
            Commissioner&rsquo;s Office under registration number Z6426984. VFB Chat is operated by the
            Virtual Fly Brain project in the School of Informatics.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Our lawful basis</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            We process this data in the performance of a <strong>task carried out in the public
            interest</strong> (UK GDPR Article 6(1)(e)). That task is the University&rsquo;s statutory
            function in research and the advancement of learning, under which it operates Virtual Fly
            Brain as an open research resource for the international research community. We process
            only the minimum technical data needed to run that resource securely and to show how much
            it is used.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Where you choose to attach a conversation to a problem report, we rely on your{' '}
            <strong>consent</strong> for that transcript. You do not have to attach one, and you can
            ask us to delete it at any time.
          </p>
        </section>

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
            <li>We do not store full free-text chat queries or full AI responses as routine analytics. Your question is
                sent to ELM to be answered, and ELM keeps its own record of it &mdash; see &ldquo;Where your question goes&rdquo; below.</li>
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
          <h2 style={{ color: '#fff' }}>Where your question goes</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            To answer you, we send your question and the data we retrieved from Virtual Fly Brain to ELM, the
            University of Edinburgh&rsquo;s own AI platform. We do not store your question or the answer. ELM does log
            prompts and interactions, for a maximum of two years, and its privacy notice explains that:{' '}
            <a href="https://elm.edina.ac.uk/site/privacy-policy" style={{ color: '#66d9ff' }}>
              elm.edina.ac.uk/site/privacy-policy
            </a>.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Because this service has no accounts and no login, ELM holds no information that identifies you &mdash; the
            request reaches it under Virtual Fly Brain&rsquo;s own credentials. Your question is held on University of
            Edinburgh infrastructure, is not shared with any third party, and is not used to train anyone&rsquo;s AI
            models. Individual prompts are not routinely read; ELM examines them only in exceptional circumstances,
            for safeguarding or legal compliance.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            To find published papers, the service may also search PubMed (US National Library of
            Medicine) and bioRxiv. What is sent to them is a search term built from the Virtual Fly
            Brain terms your question resolved to &mdash; not your question, and nothing that
            identifies you.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Please still avoid typing personal information into your question. We ask this because it is good practice,
            not because we can see it.
          </p>
        </section>

        <section style={{ marginTop: '28px' }}>
          <h2 style={{ color: '#fff' }}>Analytics</h2>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            We use Google Analytics to count how the service is used: how long answers take, which broad topic a
            question fell into, which tools ran, and whether the answer succeeded. These measurements are sent from our
            server, not from your browser, so we set no cookies and store nothing on your device, and Google does not
            receive your IP address &mdash; only ours. Each measurement carries a one-off random identifier that is
            never reused, so your requests cannot be linked to one another. No question text and no answer text is ever
            included.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            Google Analytics is operated by Google LLC in the United States, under the UK Extension to the EU&ndash;US
            Data Privacy Framework.
          </p>
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
            Under data protection law you have the right to:
          </p>
          <ul style={{ lineHeight: 1.7 }}>
            <li><strong>Access</strong> &mdash; ask for a copy of the personal data we hold about you</li>
            <li><strong>Rectification</strong> &mdash; ask us to correct data that is inaccurate</li>
            <li><strong>Erasure</strong> &mdash; ask us to delete data we hold about you</li>
            <li><strong>Restriction</strong> &mdash; ask us to limit how we use it</li>
            <li><strong>Objection</strong> &mdash; object to our processing it</li>
            <li><strong>Portability</strong> &mdash; where it applies, receive it in a structured, machine-readable form</li>
            <li><strong>Withdraw consent</strong> &mdash; where we rely on consent, which for this service means a conversation you attached to a problem report</li>
          </ul>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            <strong>How to exercise them.</strong> Every answer carries a response ID, shown beneath it.
            We hold no account and no name for you, so that ID is the only way we can find the records
            relating to a particular exchange &mdash; quote it when you ask what we hold, or ask for it
            to be deleted. Because we hold nothing that identifies you, there will be cases where we
            cannot locate any data for a request; where that happens we will say so.
          </p>
          <p style={{ color: '#b8b8b8', lineHeight: 1.6 }}>
            <strong>If you are unhappy with how we have handled your data</strong>, please contact the
            University&rsquo;s Data Protection Officer using the details below. You also have the right
            to complain to the UK supervisory authority, the{' '}
            <a
              href="https://ico.org.uk/make-a-complaint/"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#66d9ff', textDecoration: 'underline' }}
            >
              Information Commissioner&rsquo;s Office
            </a>, at any time.
          </p>
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
        <SiteFooter />
      </div>
    </main>
  )
}
