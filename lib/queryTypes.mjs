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

const S = (kind, countNoun, use) => ({ kind, countNoun, ...(use ? { use } : {}) })

export const QUERY_SEMANTICS = {
  // individual images — count = images (VFB_* rows)
  ListAllAvailableImages: S('individual_images', 'images', 'images of the term itself'),
  ImagesNeurons: S('individual_images', 'images of neurons', 'how many/which images of neurons have a part in a region'),
  AllAlignedImages: S('individual_images', 'images', 'images aligned to a template'),
  DatasetImages: S('individual_images', 'images', 'images in a dataset'),
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

/** Semantics for a query_type: { kind, countNoun, use? }. Unknown types get a safe default. */
export function querySemantics(queryType = '') {
  return QUERY_SEMANTICS[queryType] || DEFAULT
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
