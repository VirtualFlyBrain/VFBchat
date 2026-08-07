export const metadata = {
  title: 'VFB Chat Terms of Use',
  description: 'Acceptable use and terms of use for VFB Chat'
}

const linkStyle = { color: '#66d9ff' }
const sectionStyle = { marginTop: '28px' }
const headingStyle = { color: '#fff' }
const bodyStyle = { color: '#b8b8b8', lineHeight: 1.6 }
const listStyle = { lineHeight: 1.7 }

export default function TermsPage() {
  return (
    <main style={{
      minHeight: '100vh',
      backgroundColor: '#000',
      color: '#e0e0e0',
      padding: '32px 20px 48px',
      boxSizing: 'border-box'
    }}>
      <div style={{ maxWidth: '860px', margin: '0 auto' }}>
        <h1 style={{ color: '#fff', marginTop: 0 }}>Terms of Use for VFB Chat</h1>
        <p style={bodyStyle}>
          VFB Chat (<a href="https://chat.virtualflybrain.org" style={linkStyle}>chat.virtualflybrain.org</a>) is a
          free, public service operated by the Virtual Fly Brain project at the University of Edinburgh. By using it
          you accept these terms.
        </p>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>What This Service Is</h2>
          <p style={bodyStyle}>
            VFB Chat answers questions about <em>Drosophila</em> neuroanatomy, connectomics, gene expression and
            related data by querying Virtual Fly Brain&apos;s own databases and describing what they return.
            Language-model processing is provided by ELM, the University of Edinburgh&apos;s supported AI platform.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>What This Service Is Not</h2>
          <p style={bodyStyle}>
            VFB Chat is an aid to finding and understanding research data. It is <strong>not</strong> a source of
            medical, clinical, veterinary, legal or professional advice, and must not be used as one. It is not a
            substitute for reading the primary literature or the underlying data.
          </p>
          <p style={bodyStyle}>
            <strong>Answers are generated and may be wrong.</strong> Even though the service answers from Virtual Fly
            Brain&apos;s data rather than from the model&apos;s own knowledge, generated text can misstate or misplace
            what the data says. Verify anything you intend to rely on against the primary sources we link to. Do not
            cite VFB Chat as a source in publications — cite the underlying data, publications and identifiers it
            points you at.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Do Not Enter Personal or Confidential Information</h2>
          <p style={bodyStyle}>
            Do not type personal data, confidential information, unpublished data you are not free to share, or
            anything sensitive into VFB Chat. Your questions are sent to the ELM platform for processing. We do not
            store your questions or the answers as routine analytics, but you should treat anything you type as having
            left your control.
          </p>
          <p style={bodyStyle}>
            If you report a problem you may choose to attach the visible conversation so we can investigate. That is
            entirely optional, it applies only when you tell us an answer was unsatisfactory, and the attached
            conversation is deleted after 30 days. Check what you are attaching before you send it.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Acceptable Use</h2>
          <p style={bodyStyle}>
            You may use VFB Chat for research, teaching, learning and any other lawful purpose consistent with its
            subject matter. You must not:
          </p>
          <ul style={listStyle}>
            <li>attempt to make the service produce unlawful, harassing, defamatory or abusive content;</li>
            <li>attempt to circumvent its scope, its safety controls, its rate limits or its domain restrictions;</li>
            <li>
              attempt to extract data in bulk, or use the service as a substitute for Virtual Fly Brain&apos;s
              documented APIs and download routes — those exist, they are open, and they are better suited to it;
            </li>
            <li>use the service in a way that degrades it for others, including automated or high-volume querying;</li>
            <li>use it to generate content unrelated to Virtual Fly Brain&apos;s subject matter.</li>
          </ul>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Rate Limits</h2>
          <p style={bodyStyle}>
            Use is rate-limited per IP address to keep the service available and affordable for everyone. If you need
            higher-volume programmatic access, use <code>VFB_connect</code> or the VFB APIs, or contact us at{' '}
            <a href="mailto:data@virtualflybrain.org" style={linkStyle}>data@virtualflybrain.org</a>.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Availability</h2>
          <p style={bodyStyle}>
            This is a free research service provided as-is. We do not guarantee availability, accuracy, completeness or
            fitness for any particular purpose, and we may change, suspend or withdraw it at any time. To the extent
            permitted by law, the University of Edinburgh accepts no liability for any loss arising from use of, or
            reliance on, this service.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Data and Licensing</h2>
          <p style={bodyStyle}>
            The Virtual Fly Brain data this service describes is openly licensed. Attribution requirements for the
            underlying datasets, images and ontologies still apply when you reuse them — the service links you to the
            sources so you can attribute correctly. See{' '}
            <a href="https://virtualflybrain.org" style={linkStyle}>virtualflybrain.org</a> for licensing and citation
            guidance.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Privacy and Accessibility</h2>
          <p style={bodyStyle}>
            What we log and for how long is set out in the{' '}
            <a href="/privacy" style={linkStyle}>Privacy Notice</a>. Our{' '}
            <a href="/accessibility" style={linkStyle}>Accessibility Statement</a> explains how the service meets the
            Public Sector Bodies (Websites and Mobile Applications) (No. 2) Accessibility Regulations 2018 and how to
            report a barrier.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Contact</h2>
          <p style={bodyStyle}>
            <a href="mailto:data@virtualflybrain.org" style={linkStyle}>data@virtualflybrain.org</a>. For data
            protection matters, the University&apos;s Data Protection Officer at{' '}
            <a href="mailto:dpo@ed.ac.uk" style={linkStyle}>dpo@ed.ac.uk</a>.
          </p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Changes to These Terms</h2>
          <p style={bodyStyle}>
            We may update these terms. The current version is always the one published here.
          </p>
          <p style={{ ...bodyStyle, marginTop: '20px', fontStyle: 'italic' }}>Last updated: 7 August 2026</p>
        </section>
      </div>
    </main>
  )
}
