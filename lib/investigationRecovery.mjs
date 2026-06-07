// Investigation-mode recovery (pure logic).
//
// When a VFB tool returns requires_user_selection / investigation_mode (an
// endpoint resolved to broad anatomy rather than a neuron class), the weak model
// tends to re-issue the same query and dead-stop. Rather than rely on the
// system-prompt instruction it ignores, the harness replaces that bulky tool
// output with a compact directive carrying the candidate classes and the focus
// description, so the model answers from gathered evidence instead of looping.
//
// Pure helpers only (offline-testable); the wiring + parseToolOutputPayload live
// in app/api/chat/route.js. Gated by VFB_STRUCTURED_TOOLCALLS. See report §11.B.

export function isInvestigationOutput(parsed) {
  return !!parsed && (parsed.requires_user_selection === true || parsed.investigation_mode === true)
}

/** Collect candidate neuron-class "label id" strings from an investigation payload. */
export function extractInvestigationCandidates(parsed, max = 12) {
  const out = []
  const pushFrom = (arr) => {
    if (!Array.isArray(arr)) return
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue
      const id = c.id || c.short_form || c.shortForm || c.class_id
      const label = c.label || c.name || c.symbol
      const text = [label, id].filter(Boolean).join(' ').trim()
      if (text) out.push(text)
    }
  }
  pushFrom(parsed?.candidate_classes)
  pushFrom(parsed?.candidates)
  if (Array.isArray(parsed?.selections_needed)) {
    for (const s of parsed.selections_needed) pushFrom(s?.candidates)
  }
  return [...new Set(out)].slice(0, max)
}

/**
 * Build a compact directive to replace an investigation-mode tool output.
 * Keeps the focus term/region (which carries the description/components) and the
 * candidate classes, and tells the model to answer now without re-querying.
 */
export function buildInvestigationDirective(parsed) {
  return {
    investigation_mode: true,
    answer_now_directive:
      'Do NOT call more tools and do NOT repeat this query. Answer the user question now using the focus description/components below and the candidate neuron classes. If exact synaptic connectivity or weights are requested, state they require choosing one specific neuron class (not a broad region/anatomy term) and offer these candidates as the narrowing options.',
    candidate_neuron_classes: extractInvestigationCandidates(parsed),
    focus: parsed?.focus_region || parsed?.focus_term || parsed?.term || parsed?.attempted_query || undefined
  }
}
