// The AI notice and policy links, in one place.
//
// This text used to exist only inside app/page.js, so /privacy, /accessibility
// and /terms — the three pages a reviewer, an assessor or a screen-reader user is
// most likely to land on directly — carried no AI notice and no way back to the
// other two except a "Back to VFB Chat" link.
//
// That is item 12 in 17-code-remediation-required.md. It matters beyond tidiness:
// the accessibility statement is a public conformance claim under the Public
// Sector Bodies (Websites and Mobile Applications) (No. 2) Accessibility
// Regulations 2018, and a page making that claim should itself be navigable to
// its siblings. The AI notice is the disclosure the DPIA describes users as
// receiving; a user who arrives at /privacy from a search engine was not
// receiving it.
//
// Deliberately one component rather than copied markup: the notice states a
// retention period and describes what is logged, so it is a governed artefact.
// Copies drift, and a drifted copy of this text is a false statement about
// processing rather than a cosmetic inconsistency.

const LINK = { color: '#66d9ff', textDecoration: 'underline' }

/**
 * @param {object} props
 * @param {'app'|'page'} [props.variant] - 'app' matches the chat layout's flex
 *   column; 'page' adds breathing room for a scrolling document.
 */
export default function SiteFooter({ variant = 'page' }) {
  const isApp = variant === 'app'
  return (
    <footer
      style={{
        marginTop: isApp ? '12px' : '40px',
        padding: isApp ? '8px 12px' : '12px 14px',
        backgroundColor: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: '4px',
        fontSize: '0.75em',
        color: '#aaa',
        lineHeight: '1.5',
        flexShrink: 0
      }}
    >
      <strong>AI Response Notice:</strong> This tool provides AI-generated information based on Virtual
      Fly Brain data.{' '}
      Always verify critical information with primary sources. We log limited technical and usage data,
      including IP addresses for abuse prevention, and retain raw security logs for up to 30 days.{' '}
      We do not store full chat content for routine analytics, except when you explicitly attach a
      conversation while reporting a problem for short-term investigation. See our{' '}
      <a href="/privacy" style={LINK}>Privacy Notice</a>{' | '}
      <a href="/accessibility" style={LINK}>Accessibility Statement</a>{' | '}
      <a href="/terms" style={LINK}>Terms of Use</a>.
    </footer>
  )
}
