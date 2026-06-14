// Intent-scoped guidance cards (pure, offline-testable).
//
// Instead of one ever-growing planner/synth system prompt, each card carries a
// deterministic matcher and a compact instruction that is injected ONLY when the
// question matches — progressive disclosure for a weak model. Per query the model
// sees a short, on-point prompt rather than every rule at once, which both keeps
// the prompt maintainable and improves weak-model reliability.
//
// The domain rules are ported from the ask-vfb Claude skills so the harness
// handles VFB data the same way the interactive agent does:
//   - vfb-connectivity / annotated-connectome: query-mode inference (upstream /
//     downstream / between X and Y), neuron-vs-region/muscle/sense-organ/individual
//     guardrails, weight=5 default, hb/fafb dataset exclusion to avoid
//     double-counting overlapping connectomes.
//   - flybase-stocks / flybase-combo-pubs: id-pattern → entity type.
//   - taxonomy: subclasses via the parent class, not a flat search list.
//
// Deterministic step injection (orchestrator.maybeInjectConnectivityStep) and the
// result-table intent mapping (resultTables) are the *enforcement* of the same
// rules; these cards are the *guidance* the planner sees so it routes correctly.

export const CARDS = [
  {
    id: 'connectivity',
    match: (q) => /\b(graph|network|connectom\w*|connectivity|connects?|connected|downstream|upstream|partners?|presynaptic|postsynaptic|inputs?|outputs?|afferent|efferent|synaptic)\b/i.test(q),
    planner: [
      'CONNECTIVITY: use the connectivity tools, never term-info counts, for connectivity questions.',
      '- ONE neuron type ("what does X connect to / inputs to X / X outputs / X partners / graph of X"): vfb_find_connectivity_partners, endpoint_type = the neuron type, direction "downstream" for outputs/"connects to" or "upstream" for inputs/sources.',
      '- TWO neuron types ("between X and Y", "X to Y", "X → Y"): vfb_query_connectivity with upstream_type and downstream_type.',
      '- A BRAIN REGION (medulla, mushroom body, antennal lobe), a MUSCLE or SENSE ORGAN, or an INDIVIDUAL named neuron: do NOT use the class-connectivity tools — answer from vfb_get_term_info and its query counts; class-to-class edges are not defined for those.',
      'Connectivity defaults: minimum synapse weight 5; exclude the "hb" and "fafb" datasets unless the user asks for all datasets (they overlap newer connectomes and would double-count). The connectivity tool output is rendered as a graph automatically — do not plan create_basic_graph.'
    ].join('\n'),
    synth: 'Do not state whether a graph, diagram or visualisation is or is not provided — any connectivity graph is attached by the interface automatically; just describe the connectivity in words.'
  },
  {
    id: 'genetic-tools',
    match: (q) => /\b(genetic tool|genetic tools|driver|drivers|gal4|lexa|split|transgene|reporter|express(?:es|ion)?|label(?:l?ed|l?ing)?|construct|intersectional)\b/i.test(q),
    planner: 'GENETIC TOOLS / DRIVERS: resolve the target anatomy or neuron with vfb_get_term_info and read its expression queries (TransgeneExpressionHere, ExpressionOverlapsHere), or use vfb_find_genetic_tools — these list the GAL4 / split-GAL4 / LexA lines. Do NOT answer "what drivers label X" from neuron-count or image queries.'
  },
  {
    id: 'taxonomy',
    match: (q) => /\b(subtypes?|subclass(?:es)?|types? of|kinds? of|classification|taxonomy|how many .*(?:types|classes|subtypes))\b/i.test(q),
    planner: 'TAXONOMY / SUBTYPES: resolve the parent class with vfb_get_term_info and read its SubclassesOf query (count + preview), or use vfb_get_hierarchy with subclass_of. Do not enumerate subtypes from a flat search list.'
  },
  {
    id: 'stocks',
    match: (q) => /\b(stock|stocks|fly line|fly lines|bloomington|kyoto|vdrc|available lines?)\b/i.test(q),
    planner: 'FLY STOCKS: resolve the gene/allele/insertion/combination first, then use vfb_find_stocks. The id pattern fixes the type: FBgn = gene (find stocks via its alleles), FBal = allele, FBti = insertion, FBco = split-GAL4 combination.'
  },
  {
    id: 'neuron-profile',
    match: (q) => /\b(comprehensive profile|profile of|tell me about|what is known about|overview of|full (?:profile|details|picture))\b/i.test(q),
    planner: 'NEURON PROFILE: for "profile of / what is known about / tell me about <neuron type>", use vfb_summarize_neuron_profile (neuron_type = the type) — it bundles anatomy, connectivity, genetic tools and publications in one call, so prefer it over separate connectivity/genetic-tools steps. Resolve the neuron type in terms_to_resolve.'
  },
  {
    id: 'pathway',
    match: (q) => /\b(pathway|trace a (?:pathway|path|route)|how (?:does|do|can) .*(?:reach|get to)|synaptic steps?|through how many synap|intermediate neurons?|route from)\b/i.test(q),
    planner: 'PATHWAY: for "trace a pathway from X to Y", "how does X reach Y", or "how many synaptic steps from X to Y", use vfb_find_pathway_evidence (source = X, target = Y). Resolve both endpoints in terms_to_resolve.'
  },
  {
    id: 'comparison',
    match: (q) => /\b(compare|comparison|consistent between|converge on|same (?:downstream|targets?|partners?)|differ(?:ence|ences)? between|both .*(?:receive|connect)|reciprocal)\b/i.test(q),
    planner: 'COMPARISON: "compare X and Y" or "do X and Y converge on shared targets" → vfb_compare_downstream_targets (upstream_types = [X, Y]). "is connectivity consistent between connectome datasets" → vfb_compare_dataset_connectivity (neuron_type, datasets). "compare region organisation across life stages" → vfb_compare_region_organization. "reciprocal connections between two families" → vfb_find_reciprocal_connectivity.'
  },
  {
    id: 'neuron-count',
    match: (q) => /\b(how many neurons|number of neurons|neuron count|approximately how many .*neuron|how many .* neurons are)\b/i.test(q),
    planner: 'NEURON COUNT: for "how many neurons are in <region>" use vfb_get_region_neuron_count (region = the region; include_literature true to add published estimates alongside the annotated count).',
    synth: 'NEURON COUNTS: VFB\'s "neurons with some part here" figure is the number of neuron types ANNOTATED in VFB, not the biological total — do NOT state it as "approximately N neurons are in the region". Give the published/whole-brain estimate as the biological figure when available, and report the VFB-annotated count separately and clearly labelled as such.'
  },
  {
    id: 'containment',
    match: (q) => /\b(containment|anatomical hierarchy|trace .*(?:hierarchy|up to)|up to the top.?level|which .* contains|what (?:is|are) .* (?:a )?part of)\b/i.test(q),
    planner: 'CONTAINMENT HIERARCHY: for "trace the containment hierarchy from X up to the top-level structure" or "what is X part of", use vfb_trace_containment_chain (term = X), or vfb_get_hierarchy with relationship part_of for the full tree.'
  },
  {
    id: 'neurotransmitter',
    match: (q) => /\b(what (?:neuro)?transmitter|which (?:neuro)?transmitter|neurotransmitter (?:do|does|of|used|profile)|what (?:does|do) .*(?:release|secrete)|is .* (?:cholinergic|gabaergic|glutamatergic|dopaminergic|serotonergic))\b/i.test(q),
    planner: 'NEUROTRANSMITTER: for "what neurotransmitter does <neuron type> use/release", use vfb_get_neurotransmitter_profile (neuron_type = the type) for the connectome-predicted transmitter, and fall back to vfb_get_term_info if the profile tool returns nothing.'
  }
]

/** Cards whose matcher fires for this question. */
export function selectCards(question = '') {
  const q = String(question || '')
  return CARDS.filter(c => { try { return c.match(q) } catch { return false } })
}

/** Combined planner-side guidance for the matched cards ('' if none). */
export function plannerGuidance(question = '') {
  const parts = selectCards(question).map(c => c.planner).filter(Boolean)
  return parts.join('\n\n')
}

/** Combined synthesiser-side guidance for the matched cards ('' if none). */
export function synthGuidance(question = '') {
  const parts = selectCards(question).map(c => c.synth).filter(Boolean)
  return parts.join('\n')
}
