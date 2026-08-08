// What KIND of thing a resolved VFB term is, and — if it is a specific example
// of something — what it is an example OF.
//
// This distinction decides which questions can be asked of a term at all, and
// the app had been inferring it five different ways from three different fields.
//
// A VFB **class** (FBbt_00003686, "Kenyon cell") is a type of thing. It offers
// type-level queries: SubclassesOf, UpstreamClassConnectivity, SplitsTargeting,
// TransgeneExpressionHere, anatScRNAseqQuery.
//
// A VFB **individual** (VFB_fw004661, "DA1_lPN (AL.LH.66 (FlyWire:…))") is ONE
// specific reconstructed neuron. It offers almost nothing type-level — the real
// record above offers exactly SimilarMorphologyTo and
// NeuronNeuronConnectivityQuery — because a question about the TYPE has to be
// asked of the type. What it does carry is `Meta.Types`: the classes it is an
// instance of.
//
//     "Types": "[adult antennal lobe projection neuron DA1 lPN](FBbt_00067363);
//               [adult fruitless aDT-e (female) neuron](FBbt_00110423)"
//
// So "what neurotransmitter does this neuron use?" asked of that individual is
// answerable — but only by walking up to FBbt_00067363 first. Nothing in the
// harness could do that: `ledger.terms[*].kind` existed in the schema and was
// never populated, and the parent ids were dropped by the digest builder.
//
// A **region** (a synaptic neuropil or painted domain) is neither, and takes a
// third set of queries again — NeuronsPartHere, TransgeneExpressionHere — while
// refusing the class-connectivity tools entirely.
//
// The authoritative flags are on the record: IsIndividual, IsClass, IsTemplate,
// IsPaintedDomain. They were present in every term-info payload and read by
// nothing. SuperTypes/Tags remain the fallback for records that predate them.

const lower = (x) => String(x || '').toLowerCase()

/** Lower-cased SuperTypes + Tags for a term-info record. */
export function termFlagsOf(info) {
  return [].concat(info?.SuperTypes || [], info?.Tags || []).map(lower)
}

/**
 * One of 'individual' | 'class' | 'region' | 'template' | 'dataset' | null.
 *
 * 'region' wins over 'class' when both apply, because it is the more specific
 * statement about what queries exist: a neuropil IS an ontology class, but the
 * class-connectivity tools have no region endpoints and handing them one
 * returns nothing, which the synthesiser then reports as an absence.
 */
export function termKind(info) {
  if (!info || typeof info !== 'object') return null
  const flags = termFlagsOf(info)
  const has = (f) => flags.includes(f)

  if (info.IsTemplate === true || has('template')) return 'template'
  if (info.IsPaintedDomain === true) return 'region'
  if (has('dataset')) return 'dataset'

  const isRegionish = (has('anatomy') || has('synaptic_neuropil')) && !has('neuron') && !has('cell')
  if (info.IsIndividual === true) return isRegionish ? 'region' : 'individual'
  if (info.IsClass === true) return isRegionish ? 'region' : 'class'

  // Records without the explicit flags: fall back to the SuperTypes the harness
  // has always used.
  if (isRegionish) return 'region'
  if (has('individual') && !has('class')) return 'individual'
  if (has('class')) return 'class'
  return null
}

export const isIndividualKind = (kind) => kind === 'individual'
export const isClassKind = (kind) => kind === 'class'
export const isRegionKind = (kind) => kind === 'region'

// "[label](FBbt_00067363)" — VFB writes Meta.Types and Meta.Type as
// semicolon-separated markdown links.
const TYPE_LINK_RE = /\[([^\]]+)\]\(([A-Za-z]+_?[0-9a-z]+)\)/gi
const CLASS_ID_RE = /^(FBbt|CL|GO|FBdv)_?\d+$/i

/**
 * The classes this term is an instance of, most specific first, as VFB stated
 * them. Empty for a class or a region — they are not instances of anything the
 * query surface cares about.
 *
 * Only Meta.Types / Meta.Type are read, never Meta.Relationships. The one
 * existing parser in the app (route.js) concatenated all three and took the
 * first FBbt id it found, so "develops from neuroblast BAlc" or "is part of
 * adult brain" could be returned as the neuron's own type. `is part of adult
 * brain` is true of every neuron in the dataset and answers nothing.
 */
export function parentClassesOf(info) {
  const text = [info?.Meta?.Types, info?.Meta?.Type].filter(Boolean).join('; ')
  const out = []
  const seen = new Set()
  for (const m of String(text).matchAll(TYPE_LINK_RE)) {
    const label = String(m[1]).trim()
    const id = String(m[2]).trim()
    if (!CLASS_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label })
  }
  return out
}

/**
 * Does this term's own catalogue offer `queryType`?
 * `queries` is the digest's queries array (or a term-info Queries array).
 */
export function offersQuery(queries, queryType) {
  const wanted = lower(queryType)
  if (!wanted) return false
  return (Array.isArray(queries) ? queries : []).some(
    q => lower(q?.query_type || q?.query) === wanted
  )
}
