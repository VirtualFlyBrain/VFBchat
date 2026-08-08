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

import { isGeneExpressionQuestion, isSplitGal4Question, asksIntrinsic } from './queryTypes.mjs'

// "Connect" has a second, entirely non-neural sense in this product's own
// vocabulary: connecting a CLIENT to a SERVER. "How do I connect Claude to the
// VFB MCP server?" matched the connectivity card on the word "connect" and was
// handed the synaptic-partner playbook — and, because connectivity is one of
// COMPLEX_CARD_IDS, was also promoted to three planner votes and 24 tool rounds.
// A documentation question paid for a connectome question's budget and got a
// connectome question's guidance.
//
// The discriminator is the object of the verb. Nothing in the neural sense of
// connectivity involves an MCP endpoint, an API key, a client or an install, so
// naming any of those is taken as the software sense and the card stands down.
// Deliberately a suppressor rather than extra alternation in the matcher: the
// neural pattern stays readable, and what it does NOT cover is stated once, in
// one place, with the reason attached.
const SOFTWARE_WIRING = /\b(mcp|api|apis|sdk|server|servers|endpoints?|client|clients|url|urls|token|tokens|api[- ]?key|install(?:ing|ation)?|configur\w+|set\s?up|plugin|plugins|desktop app|json)\b/i

export const CARDS = [
  {
    id: 'connectivity',
    match: (q) => /\b(graph|network|connectom\w*|connectivity|connects?|connected|downstream|upstream|partners?|presynaptic|postsynaptic|inputs?|outputs?|afferent|efferent|synaptic)\b/i.test(q)
      && !SOFTWARE_WIRING.test(q),
    planner: [
      'CONNECTIVITY: use the connectivity tools, never term-info counts, for connectivity questions.',
      '- ONE neuron type ("what does X connect to / inputs to X / X outputs / X partners / graph of X"): vfb_find_connectivity_partners, endpoint_type = the neuron type, direction "downstream" for outputs/"connects to" or "upstream" for inputs/sources.',
      '- TWO neuron types ("between X and Y", "X to Y", "X → Y"): vfb_query_connectivity with upstream_type and downstream_type.',
      '- A BRAIN REGION (medulla, mushroom body, antennal lobe), a MUSCLE or SENSE ORGAN, or an INDIVIDUAL named neuron: do NOT use the class-connectivity tools — answer from vfb_get_term_info and its query counts; class-to-class edges are not defined for those.',
      'Connectivity defaults: minimum synapse weight 5; exclude the "hb" and "fafb" datasets unless the user asks for all datasets (they overlap newer connectomes and would double-count). The connectivity tool output is rendered as a graph automatically — do not plan create_basic_graph.'
    ].join('\n'),
    synth: 'Do not state whether a graph, diagram or visualisation is or is not provided — any connectivity graph is attached by the interface automatically; just describe the connectivity in words.'
  },
  // Before the general genetic-tools card, which would otherwise claim the
  // question on the word "split" and send the planner to TransgeneExpressionHere.
  {
    id: 'split-gal4',
    match: isSplitGal4Question,
    planner: 'SPLIT-GAL4: a split-GAL4 is an INTERSECTION of two hemidrivers, and VFB records them under the SplitsTargeting query, which exists on NEURON CLASSES (e.g. Kenyon cell), not on brain regions. For a neuron type, read SplitsTargeting. For a REGION, VFB has no split-specific query: TransgeneExpressionHere is the nearest thing, and its rows are transgene expression patterns — overwhelmingly single GMR enhancer-fragment GAL4 lines such as P{GMR11B09-GAL4}, which are NOT split-GAL4 lines. Never describe those rows as split-GAL4. Say what VFB holds: the expression-pattern count for the region, and that splits are recorded against the neuron types that arborise there. If the user named one specific neuron (a VFB_ individual), the splits are on its TYPE, not on that individual.'
  },
  {
    id: 'genetic-tools',
    // …but NOT for a transcriptomics question. "What scRNAseq / expression data
    // does VFB have, and which marker genes are associated with it?" matched on
    // the word "expression" and told the planner to read TransgeneExpressionHere,
    // so a question about GENES was planned as a question about GAL4 lines. A
    // driver line is not a gene; the scrnaseq card handles that side.
    match: (q) => /\b(genetic tool|genetic tools|driver|drivers|gal4|lexa|split|transgene|reporter|express(?:es|ion)?|label(?:l?ed|l?ing)?|construct|intersectional)\b/i.test(q)
      && !isGeneExpressionQuestion(q),
    planner: 'GENETIC TOOLS / DRIVERS: resolve the target anatomy or neuron with vfb_get_term_info and read its expression queries (TransgeneExpressionHere, ExpressionOverlapsHere), or use vfb_find_genetic_tools — these list the GAL4 / split-GAL4 / LexA lines. Do NOT answer "what drivers label X" from neuron-count or image queries.'
  },
  // Before the taxonomy card, which would otherwise claim "neuron types
  // intrinsic to the mushroom body" on the words "types of" and send the
  // planner to the region's own subclasses.
  {
    id: 'intrinsic',
    match: asksIntrinsic,
    planner: 'INTRINSIC NEURONS: "intrinsic to <region>" means the neuron lies WHOLLY within that region — it is not the same as having a part there. NeuronsPartHere / NeuronsPresynapticHere / NeuronsPostsynapticHere all include extrinsic neurons (MBONs, DANs, projection neurons) and must NOT be used to answer it. Resolve the class "<region> intrinsic neuron" with vfb_get_term_info (VFB names these consistently: mushroom body intrinsic neuron = FBbt_00007484, whose subclasses are the Kenyon cells; intrinsic neuron of the central complex = FBbt_00053387) and read its SubclassesOf query. If no such class exists for the region, say so — do not substitute a spatial-overlap query.'
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
    synth: 'NEURON COUNTS: VFB\'s "neurons with some part here" figure is the number of neuron types ANNOTATED in VFB, not the biological total — do NOT state it as "approximately N neurons are in the region"; report it as "VFB has annotated N neuron types …". Only give a published biological total if EVIDENCE contains it WITH a citation, and cite that reference; never quote a published/literature figure (e.g. a whole-brain neuron count) without a real reference, and never invent one.'
  },
  {
    id: 'containment',
    match: (q) => /\b(containment|anatomical hierarchy|trace .*(?:hierarchy|up to)|up to the top.?level|which .* contains|what (?:is|are) .* (?:a )?part of)\b/i.test(q),
    planner: 'CONTAINMENT HIERARCHY: for "trace the containment hierarchy from X up to the top-level structure" or "what is X part of", use vfb_trace_containment_chain (term = X), or vfb_get_hierarchy with relationship part_of for the full tree.'
  },
  {
    id: 'scrnaseq',
    // The shared discriminator is the primary matcher — it catches wordings the
    // hand-written list missed ("which marker genes are associated with T"),
    // and, being the same predicate the genetic-tools card negates, guarantees
    // the two cards can never both claim a pure gene question.
    match: (q) => isGeneExpressionQuestion(q)
      || /\b(scrna-?seq|single[- ]cell|transcriptom\w*|gene expression|which genes|what genes|receptor genes?|express(?:es|ed)? .*(?:gene|receptor)|dopamine receptor|acetylcholine receptor)\b/i.test(q),
    planner: 'SINGLE-CELL / GENE EXPRESSION: for "which genes / which receptors does <neuron type> express" (single-cell / transcriptomic questions), use vfb_scrnaseq_gene_expression (neuron_type = the type; genes = the gene or family asked about, e.g. "dopamine receptors"). It runs the scRNA-seq chain (clusters → per-gene expression) and returns a cited gene × subtype matrix. This is distinct from "what driver lines label X" (that is genetic-tools / expression-pattern).',
    synth: 'For gene-expression answers, report the expression level and the fraction of cells expressing (extent) per cluster/subtype where available, cite the scRNA-seq dataset publication, and attribute it to that dataset — do not present single-cell expression as settled biology. GAL4/LexA/split driver lines and transgene expression-pattern records are genetic REAGENTS, not genes: never list them as genes the cell type expresses. If only those are available, say VFB has driver/expression-pattern data but no single-cell gene expression for this type.'
  },
  {
    id: 'similarity',
    // Kept in step with the orchestrator's SIMILARITY_INTENT_RE, and deliberately
    // narrow for the same reason: "equivalent" alone is a homology question, which
    // NBLAST does not answer.
    match: (q) => /\b(nblast|neuronbridge|morphologically similar|similar (?:in )?morpholog\w*|(?:most )?(?:closely )?resembl\w*|closest match\w*|looks? (?:most )?like)\b/i.test(q)
      || /\bsimilar\b[\s\S]{0,30}\b(neurons?|cells?|cell types?|morpholog\w*|shapes?)\b/i.test(q)
      || /\b(neurons?|cells?|cell types?)\b[\s\S]{0,30}\bsimilar\b/i.test(q),
    planner: 'MORPHOLOGICAL SIMILARITY: for "what neurons are similar to X / what does X resemble / NBLAST matches for X", use vfb_find_similar_neurons (neuron_type = the type or the individual neuron). Do NOT answer a similarity question from term-info subclass or parent lists — taxonomic relatives are not morphological neighbours, and VFB scores similarity per registered neuron, so the class term-info carries no similarity query at all.',
    // The self-class figure is the one the synthesiser drops, and dropping it
    // inverts the answer: for LPLC2, 76 of the 192 neighbours are other LPLC2
    // neurons and they score HIGHER than any other type, so a list that opens
    // with the best-scoring *other* type reads as "LPLC2 most resembles VPNd1".
    synth: 'For morphological-similarity answers: state FIRST how many of the nearest neighbours are the same cell type as the query and their score, before listing the other cell types — omitting it makes the best-scoring other type look like the closest match when it is not. Keep the statement that NBLAST is computed per registered neuron and name how many registered neurons the result came from; it is a scored comparison of individual neurons, not a property of the cell type. Report each figure as "N of the M nearest neighbours", never as a total for the cell type.'
  },
  {
    id: 'neurotransmitter',
    match: (q) => /\b(what (?:neuro)?transmitter|which (?:neuro)?transmitter|neurotransmitter (?:do|does|of|used|profile)|what (?:does|do) .*(?:release|secrete)|is .* (?:cholinergic|gabaergic|glutamatergic|dopaminergic|serotonergic))\b/i.test(q),
    planner: 'NEUROTRANSMITTER: for "what neurotransmitter does <neuron type> use/release", use vfb_get_neurotransmitter_profile (neuron_type = the type) for the connectome-predicted transmitter, and fall back to vfb_get_term_info if the profile tool returns nothing.'
  }
]

// Complexity router. Classify the question off the same card matchers and scale
// the tool budget to it:
//   - complex (connectivity, scRNA-seq, comparison, pathway, region count — heavy
//     macros / multi-hop): full self-consistency + deep budget.
//   - standard (a single specific tool: genetic tools, taxonomy, stocks,
//     neurotransmitter): moderate.
//   - simple (no card — term-info / definitional): shallow budget.
//
// The vote counts here are a FLOOR, not a ceiling. Since v4.0.0 the harness
// escalates retrospectively: when the planner's samples disagree it buys another
// round and re-decides (lib/roleProfiles.mjs, PLANNER_ESCALATION). That is why
// the simple tier moved from one vote to two — at k=1 there is nothing to
// disagree with, so a misclassified "simple" question could never be caught. Two
// samples cost one round-trip in wall-clock (they run concurrently) and turn the
// cheapest tier from unmeasurable into self-correcting.
const COMPLEX_CARD_IDS = new Set(['connectivity', 'scrnaseq', 'comparison', 'pathway', 'neuron-count'])

export function classifyComplexity(question = '') {
  const ids = selectCards(question).map(c => c.id)
  if (ids.some(id => COMPLEX_CARD_IDS.has(id))) return { tier: 'complex', plannerVotes: 3, maxToolRounds: 24 }
  if (ids.length) return { tier: 'standard', plannerVotes: 2, maxToolRounds: 16 }
  return { tier: 'simple', plannerVotes: 2, maxToolRounds: 10 }
}

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
