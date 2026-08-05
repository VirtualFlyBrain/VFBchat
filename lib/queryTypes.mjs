// Semantic typing of VFB term-info query types, so the model can (a) read what a
// query's COUNT means, (b) pick the right query, and (c) never report a class
// count as an image count.
//
// The distinction, confirmed by the row id prefix in the results:
//   - INDIVIDUAL-IMAGE queries return individual registered images (VFB_* rows);
//     the count is a number of IMAGES (e.g. ImagesNeurons on the medulla = 226,524
//     neuron images).
//   - CLASS-LIST queries return ontology CLASSES (FBbt_* rows); the count is a
//     number of classes/types, and any thumbnail is just ONE example image of that
//     class (e.g. NeuronsPartHere = 471 neuron types, PartsOf = 28 subparts).
//     Reporting these as "images" is wrong.
//
// Per entry: kind, countNoun (what one unit of the count is, for wording answers),
// and an optional `use` (when to reach for it). queryTypeTag() renders the compact
// typing shown on each digest line.
//
// `carries` names SECONDARY kinds a query can also answer. It exists for exactly
// one reason, and it is the dataset axis: "How many DA1 lPN neurons does VFB hold
// in each connectome dataset?" classifies as kind `dataset` and nothing else —
// "neurons" is not an image cue and "how many" is not a class cue — so the only
// query in VFB that can answer it scored zero for kind match, sank in the shelf
// ranking, never ran, and the answer was "the specific counts are not provided".
// The individual-image queries return one row per registered neuron WITH its
// dataset column, which makes them the supply side of the dataset question even
// though their primary kind is images. A secondary kind is worth the same as a
// primary one; it is not a tie-break but a second true statement about what the
// query returns.

import { withoutDatasetSenseConnectome, connectomeMeansDataset } from './datasetAxis.mjs'

const S = (kind, countNoun, use, carries) => ({ kind, countNoun, ...(use ? { use } : {}), ...(carries ? { carries } : {}) })

export const QUERY_SEMANTICS = {
  // individual images — count = images (VFB_* rows)
  ListAllAvailableImages: S('individual_images', 'images', 'images of the term itself; also the per-dataset breakdown of a type\'s registered neurons', ['dataset']),
  ImagesNeurons: S('individual_images', 'images of neurons', 'how many/which images of neurons have a part in a region', ['dataset']),
  AllAlignedImages: S('individual_images', 'images', 'images aligned to a template', ['dataset']),
  DatasetImages: S('individual_images', 'images', 'images in a dataset', ['dataset']),
  ImagesThatDevelopFrom: S('individual_images', 'images', 'images of neurons that develop from a lineage'),
  epFrag: S('individual_images', 'image fragments'),
  PaintedDomains: S('individual_images', 'painted-domain images'),

  // class lists — count = classes/types; thumbnails are examples (FBbt_* rows)
  NeuronsPartHere: S('class_list', 'neuron types', 'which/how many neuron types have a part in a region'),
  NeuronsSynaptic: S('class_list', 'neuron types', 'neuron types with synaptic terminals in a region'),
  NeuronsPresynapticHere: S('class_list', 'neuron types', 'neuron types with presynaptic terminals in a region'),
  NeuronsPostsynapticHere: S('class_list', 'neuron types', 'neuron types with postsynaptic terminals in a region'),
  NeuronClassesFasciculatingHere: S('class_list', 'neuron types'),
  SubclassesOf: S('class_list', 'subclasses', 'types/kinds/subclasses of the term'),
  PartsOf: S('class_list', 'subparts', 'parts/sub-regions/subdivisions of the term'),
  ComponentsOf: S('class_list', 'components'),
  TractsNervesInnervatingHere: S('class_list', 'tracts/nerves'),
  LineageClonesIn: S('class_list', 'lineage clones'),
  ExpressionOverlapsHere: S('class_list', 'anatomy terms', 'anatomy whose expression overlaps the term'),

  // transgene / expression reports
  TransgeneExpressionHere: S('expression', 'transgene expression reports', 'GAL4/LexA drivers or expression reported in a region'),

  // connectivity — count = partners/classes
  ref_neuron_region_connectivity_query: S('connectivity', 'region connections', 'connectivity of a neuron broken down by region'),
  ref_neuron_neuron_connectivity_query: S('connectivity', 'connected neurons', 'individual neurons connected to a neuron'),
  ref_downstream_class_connectivity_query: S('connectivity', 'downstream neuron classes', 'what a neuron class outputs to (downstream)'),
  ref_upstream_class_connectivity_query: S('connectivity', 'upstream neuron classes', 'what inputs to a neuron class (upstream)'),
  DownstreamClassConnectivity: S('connectivity', 'downstream neuron classes', 'what a neuron class outputs to (downstream)'),
  UpstreamClassConnectivity: S('connectivity', 'upstream neuron classes', 'what inputs to a neuron class (upstream)'),
  NeuronNeuronConnectivityQuery: S('connectivity', 'connected neurons'),
  NeuronRegionConnectivityQuery: S('connectivity', 'region connections'),

  // morphological similarity — individual neurons/expression patterns
  SimilarMorphologyTo: S('similarity', 'neurons', 'neurons of similar morphology (NBLAST)'),
  SimilarMorphologyToPartOf: S('similarity', 'expression patterns'),
  SimilarMorphologyToPartOfexp: S('similarity', 'neurons'),
  SimilarMorphologyToNB: S('similarity', 'neurons'),
  SimilarMorphologyToNBexp: S('similarity', 'expression patterns'),
  SimilarMorphologyToUserData: S('similarity', 'neurons'),

  // single-cell transcriptomics
  anatScRNAseqQuery: S('scrnaseq', 'scRNAseq clusters', 'single-cell clusters for a cell type'),
  clusterExpression: S('scrnaseq', 'genes', 'genes expressed in a cluster'),
  scRNAdatasetData: S('scrnaseq', 'clusters'),
  expressionCluster: S('scrnaseq', 'clusters'),

  // datasets
  AllDatasets: S('dataset', 'datasets', 'all datasets in VFB'),
  AlignedDatasets: S('dataset', 'datasets', 'datasets aligned to a template'),

  // FlyBase
  FindStocks: S('stocks', 'fly stocks', 'fly stocks for a FlyBase feature'),
  FindComboPublications: S('publications', 'publications', 'publications for a split-GAL4 combination'),
  TermsForPub: S('terms', 'terms')
}

const DEFAULT = S('other', 'results')

// Human phrase for a kind — the key line is that individual_images counts are
// images while class_list counts are types/subparts (thumbnails just examples).
const KIND_PHRASE = {
  individual_images: 'individual images',
  class_list: 'ontology classes; thumbnails are examples',
  connectivity: 'connectivity partners',
  expression: 'expression reports',
  scrnaseq: 'single-cell data',
  similarity: 'similar neurons',
  dataset: 'datasets',
  stocks: 'fly stocks',
  publications: 'publications',
  terms: 'terms',
  other: 'results'
}

// --- "expression" means two unrelated things ------------------------------
//
// "What genes are expressed in cell type T?" (single-cell transcriptomics) and
// "Which GAL4 lines label T?" (genetic reagents) share exactly one word:
// express. Every matcher that keyed on that word alone treated them as the same
// question, so a request for GENES was answered with DRIVER LINES — VFB does
// report those as "expression here", but a GAL4 line is not a gene, and naming
// one in answer to the other is a wrong answer, not a partial one.
//
// These regexes are the discriminator. A question carrying gene/transcript
// vocabulary and no reagent vocabulary is transcriptomics; the reverse is
// genetic tools; one carrying both ("which drivers label the cells expressing
// gene X") is genuinely both, and is left to the broader fallbacks rather than
// forced either way.
export const GENE_EXPRESSION_RE = /\b(genes?|marker\s+genes?|receptors?|transcripts?|transcriptom\w*|scrna-?seq|single[- ]cell|mrna|rna-?seq)\b/i
export const DRIVER_LINE_RE = /\b(gal4|lexa|split|transgene|drivers?|driver lines?|reporters?|expression patterns?|constructs?|intersectional|genetic tools?)\b/i
// Naming a gene is not asking about its expression — "what is the gene ort?" is
// a definitional lookup, and routing it to single-cell cluster queries would be
// its own wrong answer. Transcriptomics vocabulary (scRNAseq, single-cell) is
// self-evidently about expression; a bare gene/receptor word needs an
// expression cue alongside it.
const TRANSCRIPTOMICS_RE = /\b(scrna-?seq|single[- ]cell|transcriptom\w*|rna-?seq)\b/i
const EXPRESSION_CUE_RE = /\b(express\w*|marker|profile)\b/i

/** True for a transcriptomics question — genes/receptors, not reagents. */
export function isGeneExpressionQuestion(question = '') {
  const q = String(question || '')
  if (DRIVER_LINE_RE.test(q)) return false
  if (TRANSCRIPTOMICS_RE.test(q)) return true
  return GENE_EXPRESSION_RE.test(q) && EXPRESSION_CUE_RE.test(q)
}

/** True for a genetic-reagent question — GAL4/LexA/split lines, not genes. */
export function isDriverLineQuestion(question = '') {
  const q = String(question || '')
  return DRIVER_LINE_RE.test(q) && !GENE_EXPRESSION_RE.test(q)
}

// --- "intrinsic to a region" is an ONTOLOGY question, not a spatial one ------
//
// This is the one place where VFB's data model and the neuroanatomist's
// vocabulary point in opposite directions, and the wrong answer looks right
// enough to survive review.
//
// "Intrinsic to the mushroom body" means: the neuron's whole arbour is inside
// the MB — it is a Kenyon cell, and nothing else. The nearest-looking query,
// NeuronsPartHere, means "has SOME part in the mushroom body", which is true of
// every MBON, every DAN and every PN that so much as touches the calyx. So
// NeuronsPartHere returns 602 rows for a question whose true answer is one
// class, and the examples it volunteers are extrinsic neurons — the exact
// opposite of what was asked. That was W7.C1 and W7.B on 3.9.1.
//
// No VFB query type expresses intrinsic-ness. The route that does is
// ontological: resolve "<region> intrinsic neuron" as a term and take its
// SubclassesOf. route.js already knows the mapping for the MB case
// ("mushroom body intrinsic neurons" → Kenyon cell), so all that is needed is
// to stop the spatial query from being selected.
//
// EXTRINSIC_RE is not symmetry for its own sake: "extrinsic neurons of the
// mushroom body" IS a part-overlap question, and must keep falling through to
// the spatial rule.
export const INTRINSIC_RE = /\bintrinsic\b/i
export const EXTRINSIC_RE = /\bextrinsic\b/i

/** True when the question asks what is intrinsic to a region (and not extrinsic). */
export function asksIntrinsic(question = '') {
  const q = String(question || '')
  return INTRINSIC_RE.test(q) && !EXTRINSIC_RE.test(q)
}

/** Semantics for a query_type: { kind, countNoun, use? }. Unknown types get a safe default. */
export function querySemantics(queryType = '') {
  return QUERY_SEMANTICS[queryType] || DEFAULT
}

// --- what KIND of thing the QUESTION is asking for -------------------------
//
// Everything above types the SUPPLY side: given a query_type, what does it
// return? Nothing typed the DEMAND side, so the only way to ask "is this query
// about this question?" was to count words the question and the query's label
// happened to share. That is a proxy, and it fails in the one direction that
// costs an answer: it scores ZERO whenever VFB's label says the same thing in
// different words, which is most of the time.
//
//   "Is there a hemibrain equivalent of VFB_fw035286, and do they share a
//    cell type?"        vs  "Neurons with similar morphology to DA1_lPN"   → 0
//   "What genes are expressed in Kenyon cells?"
//                       vs  "Single cell transcriptomics for Kenyon cell"  → 0
//
// A zero there is not "slightly less relevant". unansweredAsks filters on
// relevance > 0, so a zero means the query is invisible to the sufficiency
// pre-filter (it never runs) AND invisible to the shelf's ranking (it sinks to
// the bottom of a capped list) — and the answer then denies the CONCEPT, which
// no enumerative prohibition covers because the prohibition is phrased in
// VFB's vocabulary and the denial is phrased in the reader's.
//
// So the question gets classified into the SAME kind vocabulary the queries are
// already typed with, and a kind match counts as relevance in its own right.
// One vocabulary, both sides, and the match no longer depends on the two
// happening to choose the same nouns.
const KIND_CUES = [
  ['individual_images', /\bimages?\b|\bpictures?\b|\bthumbnails?\b|\bimage stacks?\b|\bindividual\b|\bshow me\b|\blooks? like\b|\b3d\b|\bvisuali[sz]\w*/i],
  ['class_list', /\b(?:sub)?types?\b|\bsubclass\w*|\bclasses\b|\bkinds?\b|\bparts?\b|\bsubdivisions?\b|\bcomponents?\b|\bintrinsic\b|\bwhich neurons?\b|\bwhat neurons?\b/i],
  ['connectivity', /\bconnect\w*|\bpartners?\b|\bupstream\b|\bdownstream\b|\bpre-?synap\w*|\bpost-?synap\w*|\bsynap\w*|\binputs?\b|\boutputs?\b|\btargets?\b|\bprojects?\s+to\b|\bcircuits?\b|\bafferent\w*|\befferent\w*/i, { onlyIn: withoutDatasetSenseConnectome }],
  ['similarity', /\bsimilar\w*|\bnblast\b|\bneuronbridge\b|\bmorpholog\w*|\bequivalents?\b|\bcounterparts?\b|\bhomolog\w*|\bclosest\b|\bmatch(?:es|ing)?\b|\bsame\s+(?:cell\s+)?type\b|\bshares?\s+a\s+(?:cell\s+)?type\b|\bcorrespond\w*/i],
  // "connectome" is NOT in this pattern; it is handled by connectomeMeansDataset
  // below, because the word only names a data source in dataset position. A bare
  // /\bconnectomes?\b/ here typed "what is X connected to across the connectome?"
  // as a dataset question and floated the dataset queries above the connectivity
  // ones — the same confusion as the connectivity cue above, mirrored.
  ['dataset', /\bdata\s?sets?\b|\bem\s+volumes?\b/i, { also: connectomeMeansDataset }],
  ['stocks', /\bstocks?\b|\bbloomington\b|\bfly\s+lines?\b/i],
  ['publications', /\bpublications?\b|\bpapers?\b|\bliterature\b|\breferences?\b|\bcitations?\b|\bpublished\b/i],
  ['terms', /\bontolog\w*|\bterm\s+ids?\b/i]
]
// "expression" is the one kind whose cue cannot be a single regex, because the
// word means two unrelated things (see the block above isGeneExpressionQuestion).
// Reagents are `expression`; genes are `scrnaseq`; a question about "expression
// data" with neither vocabulary attached is asking for the reagent reports VFB
// files under that name.
const EXPRESSION_DATA_RE = /\bexpress\w*\s+(?:data|reports?|patterns?)\b|\bexpression\b/i

/**
 * The semantic kinds this question is asking for — the demand side of the same
 * vocabulary QUERY_SEMANTICS types queries with.
 *
 * Returns a Set (possibly empty, often more than one: "how many DA1 lPN images
 * are in each connectome dataset?" wants individual_images AND dataset). Empty
 * is a real answer and means "no kind cue" — callers must fall back to the
 * lexical score rather than treating it as "matches nothing".
 */
export function questionKinds(question = '') {
  const q = String(question || '')
  const out = new Set()
  if (!q.trim()) return out
  // `onlyIn` narrows the HAYSTACK for one cue (the connectivity cue must not see
  // a dataset-position "connectome"); `also` widens the MATCH with a predicate
  // the regex cannot express. Both exist so the two readings of "connectome"
  // stay one decision made in one place — see lib/datasetAxis.mjs.
  for (const [kind, re, opts] of KIND_CUES) {
    const hay = opts?.onlyIn ? opts.onlyIn(q) : q
    if (re.test(hay) || (opts?.also && opts.also(q))) out.add(kind)
  }
  if (isGeneExpressionQuestion(q)) out.add('scrnaseq')
  if (isDriverLineQuestion(q) || EXPRESSION_DATA_RE.test(q)) out.add('expression')
  // A transcriptomics question is not a driver-line question, however VFB files
  // it: "what genes are expressed in Kenyon cells" must not pull GAL4 reports in
  // on the strength of the word "expressed".
  if (isGeneExpressionQuestion(q)) out.delete('expression')
  return out
}

/**
 * Kinds this question positively RULES OUT — a veto, not a low score.
 *
 * Deliberately almost empty. A kind cue that fails to fire costs a query its
 * ranking; a veto costs it its existence, so the bar for adding one is that the
 * two kinds are known to be confusable by accident of vocabulary, in a known
 * direction, with a known right answer. Exactly one pair meets it.
 *
 * "What genes are expressed in Kenyon cells?" shares the stem "express" with
 * "Transgene expression in Kenyon cell", so the reagent query scores on the very
 * word that proves the question is not about reagents. Without the veto the
 * sufficiency pre-filter runs a GAL4 report to answer a transcriptomics
 * question — the 3.7.0 gene/driver split all over again, one layer down.
 */
export function excludedKinds(question = '') {
  const q = String(question || '')
  const out = new Set()
  if (!q.trim()) return out
  if (isGeneExpressionQuestion(q)) out.add('expression')
  if (isDriverLineQuestion(q)) out.add('scrnaseq')
  return out
}

/** True when a query returns individual images (its count is a number of images). */
export function isIndividualImageQuery(queryType = '') {
  return querySemantics(queryType).kind === 'individual_images'
}

/**
 * Compact typing tag for a query, shown on each digest line so the model reads
 * what the count means and when to use the query, e.g.:
 *   "ImagesNeurons — individual images; count = images of neurons; use for how many/which images of neurons have a part in a region"
 *   "PartsOf — ontology classes; thumbnails are examples; count = subparts"
 */
export function queryTypeTag(queryType = '') {
  const s = querySemantics(queryType)
  const phrase = KIND_PHRASE[s.kind] || 'results'
  const use = s.use ? `; use for ${s.use}` : ''
  return `${queryType} — ${phrase}; count = ${s.countNoun}${use}`
}

// Some questions name no entity at all. "What do confidence values mean on
// Virtual Fly Brain?" and "When did predicted neurotransmitters for EM data
// become available on VFB?" are about a display convention and a release
// milestone; neither has an ontology entry, so the term lookup was never going
// to find one and its failure is not a finding. Both came back as nothing but
// the naming failure — "the name could not be matched to a VFB term … try
// rephrasing" — which tells the reader their question was malformed when it was
// perfectly clear.
//
// Kept deliberately narrow: only shapes that CANNOT be an entity lookup, and
// only when VFB itself is named. "How do I find the partners of DA1 lPN in VFB?"
// does name an entity, and if that name fails to resolve the reader does need to
// be asked which one was meant — so how-to and where-can-I are not on this list.
const VFB_NAMED = /\b(?:vfb|virtual\s?fly\s?brain)\b/i
const VFB_SELF_SHAPES = [
  /\bwhat\s+do(?:es)?\b[^?]*\bmean\b/i,
  /\b(?:when|since when)\b[^?]*\b(?:available|released?|added|introduced|launched|supported)\b/i,
  /\bwho\s+(?:funds?|funded|maintains?|runs?|develops?|built|owns?)\b/i,
  /\bwhat\s+is\b[^?]*\b(?:accessibility|privacy|licen[cs]e|licensing|funding|citation)\b/i
]

/**
 * True when the question is about VFB itself — a convention, a milestone, a
 * policy — rather than about something VFB might hold an ontology term for.
 */
export function isAboutVfbItself(question = '') {
  const q = String(question || '')
  if (!VFB_NAMED.test(q)) return false
  return VFB_SELF_SHAPES.some(re => re.test(q))
}
