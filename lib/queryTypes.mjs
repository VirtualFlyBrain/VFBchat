// Semantic classification of VFB term-info query types, so the assistant can
// (a) describe what a query's COUNT means and (b) pick the right query.
//
// The critical distinction, confirmed by the row id prefix in the results:
//   - INDIVIDUAL-IMAGE queries return individual registered images (VFB_* rows);
//     the count is a number of IMAGES. e.g. ImagesNeurons on the medulla returns
//     226,524 individual neuron images.
//   - CLASS-LIST queries return ontology CLASSES (FBbt_* rows); the count is a
//     number of classes/types, and any thumbnail shown is just ONE example image
//     of that class. e.g. NeuronsPartHere = 471 neuron types, PartsOf = 28
//     subparts. Reporting these as "images" is wrong.
//
// countNoun is what one row/one unit of the count IS, used to word answers
// ("226,524 images", "471 neuron types", "28 subparts").

const S = (kind, countNoun) => ({ kind, countNoun })

export const QUERY_SEMANTICS = {
  // individual images — count = images (VFB_* rows)
  ListAllAvailableImages: S('individual_images', 'images'),
  AllAlignedImages: S('individual_images', 'images'),
  DatasetImages: S('individual_images', 'images'),
  ImagesNeurons: S('individual_images', 'images of neurons'),
  ImagesThatDevelopFrom: S('individual_images', 'images'),
  epFrag: S('individual_images', 'image fragments'),
  PaintedDomains: S('individual_images', 'painted-domain images'),

  // class lists — count = classes/types; thumbnails are examples (FBbt_* rows)
  NeuronsPartHere: S('class_list', 'neuron types'),
  NeuronsSynaptic: S('class_list', 'neuron types'),
  NeuronsPresynapticHere: S('class_list', 'neuron types'),
  NeuronsPostsynapticHere: S('class_list', 'neuron types'),
  NeuronClassesFasciculatingHere: S('class_list', 'neuron types'),
  SubclassesOf: S('class_list', 'subclasses'),
  PartsOf: S('class_list', 'subparts'),
  ComponentsOf: S('class_list', 'components'),
  TractsNervesInnervatingHere: S('class_list', 'tracts/nerves'),
  LineageClonesIn: S('class_list', 'lineage clones'),
  ExpressionOverlapsHere: S('class_list', 'anatomy terms'),

  // transgene / expression reports
  TransgeneExpressionHere: S('expression', 'transgene expression reports'),

  // connectivity — count = partners/classes
  ref_neuron_region_connectivity_query: S('connectivity', 'region connections'),
  ref_neuron_neuron_connectivity_query: S('connectivity', 'connected neurons'),
  ref_downstream_class_connectivity_query: S('connectivity', 'downstream neuron classes'),
  ref_upstream_class_connectivity_query: S('connectivity', 'upstream neuron classes'),
  DownstreamClassConnectivity: S('connectivity', 'downstream neuron classes'),
  UpstreamClassConnectivity: S('connectivity', 'upstream neuron classes'),
  NeuronNeuronConnectivityQuery: S('connectivity', 'connected neurons'),
  NeuronRegionConnectivityQuery: S('connectivity', 'region connections'),

  // morphological similarity — individual neurons/expression patterns
  SimilarMorphologyTo: S('similarity', 'neurons'),
  SimilarMorphologyToPartOf: S('similarity', 'expression patterns'),
  SimilarMorphologyToPartOfexp: S('similarity', 'neurons'),
  SimilarMorphologyToNB: S('similarity', 'neurons'),
  SimilarMorphologyToNBexp: S('similarity', 'expression patterns'),
  SimilarMorphologyToUserData: S('similarity', 'neurons'),

  // single-cell transcriptomics
  anatScRNAseqQuery: S('scrnaseq', 'scRNAseq clusters'),
  clusterExpression: S('scrnaseq', 'genes'),
  scRNAdatasetData: S('scrnaseq', 'clusters'),
  expressionCluster: S('scrnaseq', 'clusters'),

  // datasets
  AllDatasets: S('dataset', 'datasets'),
  AlignedDatasets: S('dataset', 'datasets'),

  // FlyBase
  FindStocks: S('stocks', 'fly stocks'),
  FindComboPublications: S('publications', 'publications'),
  TermsForPub: S('terms', 'terms')
}

const DEFAULT = S('other', 'results')

/** Semantics for a query_type: { kind, countNoun }. Unknown types get a safe default. */
export function querySemantics(queryType = '') {
  return QUERY_SEMANTICS[queryType] || DEFAULT
}

/** True when a query returns individual images (its count is a number of images). */
export function isIndividualImageQuery(queryType = '') {
  return querySemantics(queryType).kind === 'individual_images'
}
