// Code handoff: turn a finished chat answer back into the query that produced it.
//
// This is the cheapest high-value thing the harness can do, and the reason is
// that it invents nothing. By the time an answer is written, the run holds the
// two coordinates that address every piece of VFB data it used — a resolved
// short_form id and a catalogue query_type — because that pair is what
// vfb_run_query was called with. The prose is a rendering of those coordinates;
// so is a follow-on chip; so, now, is a runnable Python snippet.
//
// Why it matters beyond convenience: it closes the loop between the chat route
// and the Python route. The workshop's own advice to users is to end a chat
// prompt with "…and list the VFB IDs so you can reproduce the result with
// vfb_connect", which is a workaround for the chat not handing over its own
// working. Worse, a user who retypes the term name into Python is re-running the
// disambiguation the chat already did, on a different search stack, and can
// silently land on a different term — "medulla" alone matches the adult medulla,
// the larval one, and the medulla of the optic lobe. Emitting the id the chat
// actually resolved makes the Python run reproduce THIS answer's rows rather
// than a fresh guess at them.
//
// The map below is not hand-written from documentation. It is derived from
// VFBquery's own `<QueryType>_to_schema` declarations — the `function` field in
// the Query object that VFB itself uses to run that query type — so every entry
// names a function that exists, takes the id we hold, and returns the table the
// answer was built from. Where VFB adds a query type we do not know, we say so
// and fall back to the browser URL, which always reproduces the result exactly
// even when we cannot name a Python entry point for it.

import { vfbQueryUrl, vfbReportUrl, stripMarkdown } from './followOns.mjs'

/**
 * query_type -> the VFBquery function that runs it.
 *
 * Derived from VFBquery src/vfbquery/vfb_queries.py (`*_to_schema`, `function=`),
 * every target verified to exist as a module-level function. 42/42 catalogue
 * query types are covered. Keep this in step with VFBquery; a wrong name here
 * produces a snippet that fails on the user's machine, which is worse than
 * offering none, so `reproductionFor` treats an unknown type as unmapped rather
 * than guessing from the name.
 */
export const VFBQUERY_FUNCTIONS = {
  NeuronInputsTo: 'get_individual_neuron_inputs',
  SimilarMorphologyTo: 'get_similar_neurons',
  ListAllAvailableImages: 'get_instances',
  NeuronsPartHere: 'get_neurons_with_part_in',
  NeuronsSynaptic: 'get_neurons_with_synapses_in',
  NeuronsPresynapticHere: 'get_neurons_with_presynaptic_terminals_in',
  NeuronsPostsynapticHere: 'get_neurons_with_postsynaptic_terminals_in',
  ComponentsOf: 'get_components_of',
  PartsOf: 'get_parts_of',
  SubclassesOf: 'get_subclasses_of',
  SplitsTargeting: 'get_splits_targeting',
  TargetNeurons: 'get_neurons_targeted_by_split',
  NeuronClassesFasciculatingHere: 'get_neuron_classes_fasciculating_here',
  NeuronNeuronConnectivityQuery: 'get_neuron_neuron_connectivity',
  NeuronRegionConnectivityQuery: 'get_neuron_region_connectivity',
  DownstreamClassConnectivity: 'get_downstream_class_connectivity',
  UpstreamClassConnectivity: 'get_upstream_class_connectivity',
  TractsNervesInnervatingHere: 'get_tracts_nerves_innervating_here',
  LineageClonesIn: 'get_lineage_clones_in',
  NeuronsCapableOf: 'get_neurons_capable_of',
  ImagesNeurons: 'get_images_neurons',
  ImagesThatDevelopFrom: 'get_images_that_develop_from',
  epFrag: 'get_expression_pattern_fragments',
  AnatomyExpressedIn: 'get_expression_overlaps_here',
  anatScRNAseqQuery: 'get_anatomy_scrnaseq',
  clusterExpression: 'get_cluster_expression',
  expressionCluster: 'get_expression_cluster',
  scRNAdatasetData: 'get_scrnaseq_dataset_data',
  SimilarMorphologyToPartOf: 'get_similar_morphology_part_of',
  SimilarMorphologyToPartOfexp: 'get_similar_morphology_part_of_exp',
  SimilarMorphologyToNB: 'get_similar_morphology_nb',
  SimilarMorphologyToNBexp: 'get_similar_morphology_nb_exp',
  SimilarMorphologyToUserData: 'get_similar_morphology_userdata',
  PaintedDomains: 'get_painted_domains',
  DatasetImages: 'get_dataset_images',
  AllAlignedImages: 'get_all_aligned_images',
  AlignedDatasets: 'get_aligned_datasets',
  AllDatasets: 'get_all_datasets',
  TermsForPub: 'get_terms_for_pub',
  TransgeneExpressionHere: 'get_transgene_expression_here',
  FindStocks: 'get_flybase_stocks',
  FindComboPublications: 'get_flybase_combo_pubs'
}

// The one mapped function that takes no id. VFB's schema anchors AllDatasets on
// a template short_form, but the function behind it lists every dataset in the
// database and takes no positional argument, so passing the template id would
// raise. The asymmetry is VFBquery's, and it is recorded here rather than
// silently reproduced.
export const NO_ARG_QUERY_TYPES = new Set(['AllDatasets'])

// Takes an upload_id — a handle for a file the user uploaded to VFB in the
// browser, not a VFB term id. Nothing in a chat session can supply it, so the
// snippet must not pretend otherwise.
export const UNREPRODUCIBLE_QUERY_TYPES = new Set(['SimilarMorphologyToUserData'])

const VFB_ID_RE = /^(?:FBbt|FBgn|FBal|FBti|FBtp|FBco|FBlc|FBrf|VFBexp|VFB)_[0-9a-zA-Z]+$/

/**
 * The Python entry point for one (id, query_type), or null when we have none.
 * Returning null is a real answer: the caller falls back to the browser URL,
 * which reproduces the query exactly.
 */
export function reproductionFor(queryType) {
  const qt = String(queryType || '')
  if (!qt || UNREPRODUCIBLE_QUERY_TYPES.has(qt)) return null
  const fn = VFBQUERY_FUNCTIONS[qt]
  if (!fn) return null
  return { fn, takesId: !NO_ARG_QUERY_TYPES.has(qt) }
}

// A Python identifier from a VFB label. Upper snake case because these are
// constants, ASCII-only because a snippet a user pastes into an old terminal
// should not depend on their encoding, and never leading with a digit.
function pyConst(label = '', seen = new Set()) {
  let base = stripMarkdown(String(label))
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase() || 'TERM'
  if (/^[0-9]/.test(base)) base = `T_${base}`
  if (base.length > 40) base = base.slice(0, 40).replace(/_+$/, '')
  let name = base
  let n = 2
  while (seen.has(name)) name = `${base}_${n++}`
  seen.add(name)
  return name
}

function pyStr(s = '') {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// A label safe to sit in a `#` comment: one line, no control characters.
function commentSafe(s = '') {
  return stripMarkdown(String(s)).replace(/\s+/g, ' ').trim()
}

/**
 * The (id, query_type) pairs this turn actually ran, in plan order.
 *
 * Read from the plan rather than from the evidence rows because the plan is
 * where the ARGUMENTS live: an evidence row records what was learned, a step
 * records what was asked. Reproduction is a claim about the second.
 */
export function ranQueries(ledger) {
  const seen = new Set()
  const out = []
  for (const s of (ledger?.plan || [])) {
    if (s.tool !== 'vfb_run_query') continue
    const qt = s.args?.query_type
    const id = s.args?.id
    if (!qt || !id || !VFB_ID_RE.test(String(id))) continue
    const key = `${id}::${qt}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: String(id), query_type: String(qt), stepId: s.id, status: s.status })
  }
  return out
}

/**
 * Build the code handoff for a finished run.
 *
 * Returns null when there is nothing to hand over — no resolved term and no
 * query — rather than an empty snippet, so callers can test truthiness.
 *
 * @param {object} ledger
 * @param {{ question?: string, maxCalls?: number }} [opts]
 * @returns {{python:string, ids:Array, calls:Array, unmapped:Array}|null}
 */
export function buildReproduction(ledger, { question = '', context = null, maxCalls = 8 } = {}) {
  // id -> authoritative VFB label. Same rule as buildFollowOns: a canonical
  // registry entry (term-info Name / search label) outranks anything a model
  // supplied, so a snippet can never comment an id with the wrong name.
  const idLabel = {}
  for (const e of Object.values(ledger?.registry || {})) {
    if (e?.canonical && e.id && !idLabel[e.id]) idLabel[e.id] = e.label
  }

  const ids = []
  const seenId = new Set()
  const seenConst = new Set()
  const constOf = {}
  const noteId = (id, label) => {
    if (!id || !VFB_ID_RE.test(id) || seenId.has(id)) return
    seenId.add(id)
    const name = commentSafe(label || idLabel[id] || id)
    const konst = pyConst(name, seenConst)
    constOf[id] = konst
    ids.push({ id, label: name, const: konst, url: vfbReportUrl(id) })
  }

  // Resolved terms first: they are the subjects of the answer, and they come in
  // resolution order, so the snippet's constants read in the order the user's
  // question introduced them.
  for (const t of Object.values(ledger?.terms || {})) {
    if (t?.id) noteId(t.id, t.digest?.name || idLabel[t.id])
  }
  // A turn that resolved nothing new still talks about what the conversation
  // established. Its label comes from the context, which only ever carried VFB's
  // own, so a carried constant is named rather than numbered.
  for (const t of (context?.terms || [])) {
    if (t?.id) noteId(t.id, t.label || t.name)
  }

  // This turn's queries first, then the ones earlier turns ran and the context
  // carried. "How would I get that same result in Python?" runs no query of its
  // own — correctly, it is a question about code — so without the carried set
  // the snippet would name the right term and no way to ask anything about it.
  const carried = []
  for (const t of (context?.terms || [])) {
    if (!t?.id || !VFB_ID_RE.test(t.id)) continue
    for (const q of (t.queries || [])) {
      if (q?.ran === true && q.query_type) carried.push({ id: t.id, query_type: String(q.query_type) })
    }
  }

  const calls = []
  const unmapped = []
  for (const q of [...ranQueries(ledger), ...carried]) {
    if (calls.some(c => c.id === q.id && c.query_type === q.query_type) ||
        unmapped.some(c => c.id === q.id && c.query_type === q.query_type)) continue
    noteId(q.id, idLabel[q.id])
    const rep = reproductionFor(q.query_type)
    const url = vfbQueryUrl(q.id, q.query_type)
    const label = commentSafe(idLabel[q.id] || q.id)
    if (!rep) {
      unmapped.push({ ...q, url, label })
      continue
    }
    calls.push({
      ...q,
      label,
      fn: rep.fn,
      // The call as it will appear. `takesId` false is the AllDatasets case.
      python: rep.takesId
        ? `vfbquery.${rep.fn}(${constOf[q.id] || pyStr(q.id)})`
        : `vfbquery.${rep.fn}()`,
      url
    })
    if (calls.length >= maxCalls) break
  }

  if (!ids.length && !calls.length) return null

  const lines = []
  lines.push('# Reproduce this answer in Python — pip install vfbquery')
  lines.push('#')
  lines.push('# These are the exact ids this conversation resolved and the exact catalogue')
  lines.push('# queries it ran, so this returns the same rows the answer was written from')
  lines.push('# rather than a fresh search that might land on a different term.')
  lines.push('import vfbquery')
  if (ids.length) {
    lines.push('')
    for (const t of ids) lines.push(`${t.const} = ${pyStr(t.id)}${t.label && t.label !== t.id ? `  # ${t.label}` : ''}`)
  }
  if (calls.length) {
    lines.push('')
    for (const c of calls) {
      const noun = commentSafe(`${c.query_type} for ${c.label}`)
      lines.push(`# ${noun}`)
      lines.push(`df = ${c.python}`)
    }
  }
  if (unmapped.length) {
    lines.push('')
    lines.push('# No VFBquery entry point is known for the following, so they are given as')
    lines.push('# links that run the same query in the VFB browser:')
    for (const u of unmapped) lines.push(`#   ${u.query_type} for ${u.label}: ${u.url}`)
  }

  return { python: lines.join('\n'), ids, calls, unmapped }
}

// Asking for the working, in the words users actually use. Deliberately narrow:
// this decides whether a fenced code block is APPENDED to the prose, and a block
// nobody asked for is noise in a chat window. The structured reproduction is
// returned on every turn regardless, so a UI can offer it as a button without
// any of these words being typed.
const REPRODUCE_RE = new RegExp([
  '\\bvfb[_ ]?connect\\b',
  '\\bvfbquery\\b',
  '\\bin python\\b',
  '\\bpython (?:code|snippet|script)\\b',
  // "show me the python" is how people actually ask, and it matched none of
  // the patterns above until a unit test asked it out loud.
  '\\b(?:show|give|write|share)(?: me)? (?:the |some )?python\\b',
  '\\breproduc\\w*\\b',
  '\\bcode (?:snippet|for (?:this|that))\\b',
  '\\bhow (?:do|would) i (?:get|query|fetch|run) (?:this|that|these|those)\\b',
  '\\bprogrammatic\\w*\\b',
  '\\bnotebook\\b',
  '\\b(?:list|give|show)(?: me)? (?:all )?the (?:vfb )?ids\\b'
].join('|'), 'i')

/** Did the user ask for the code / the ids behind the answer? */
export function wantsReproduction(question = '') {
  return REPRODUCE_RE.test(String(question || ''))
}

/**
 * The fenced block to append to an answer, or '' when the user did not ask.
 * Kept separate from buildReproduction so the payload and the prose can differ:
 * the structured form always ships, the prose form only on request.
 */
export function reproductionBlock(reproduction, question) {
  if (!reproduction || !wantsReproduction(question)) return ''
  return `\n\n\`\`\`python\n${reproduction.python}\n\`\`\``
}

// A fence the model wrote that claims to be VFB Python. Tagged python/py, or
// untagged but reaching for one of the libraries — that is enough to say this is
// code the user is meant to run against VFB, which is the only kind we displace.
const MODEL_CODE = /```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g
const VFB_LIB = /\b(vfbquery|vfb_connect|VfbConnect|navis)\b/

// A python fence is displaced on sight: we are holding python we can vouch for,
// and two python blocks in one answer is a question the reader cannot settle. An
// untagged fence has to earn it by naming a VFB library or id — the first draft
// of this sniffed the body for `import`/`from`, and missed the very snippet that
// prompted the fix, because the model had emitted `from.cross_server_tools`.
// Marks a fence we removed, so its orphaned introduction can go with it in
// the same pass. Stripped unconditionally, so it never reaches an answer.
const DROPPED = '\u0000DROPPED\u0000'

function displaces(tag, body) {
  const t = String(tag || '').toLowerCase()
  if (t === 'py' || t === 'python') return true
  return !t && VFB_LIB.test(String(body || ''))
}

/**
 * Put the grounded snippet where the user will actually read it.
 *
 * The measured failure: asked "how would I get that same result in Python?", the
 * model produced a snippet cribbed from a docs page — wrong library, undefined
 * variable, worked example about a different neuron — and the block we can vouch
 * for was appended underneath it, reading like a footnote to the confident wrong
 * code above.
 *
 * So the model's first VFB code fence is REPLACED by ours, in place: the prose
 * that introduces code still introduces code. Any further ones are dropped.
 * Nothing is removed unless we have something to put there, because an answer
 * with a flawed example still beats an answer with a dangling colon.
 */
export function withReproduction(answer = '', reproduction = null, question = '') {
  const block = reproductionBlock(reproduction, question)
  const text = String(answer || '')
  if (!block) return text
  const ours = block.replace(/^\n+/, '')

  let replaced = false
  const out = text.replace(MODEL_CODE, (whole, tag, body) => {
    if (!displaces(tag, body)) return whole
    if (replaced) return DROPPED
    replaced = true
    return ours
  })
  if (!replaced) return text + block
  return out
    // A dropped block usually leaves its introduction behind — a sentence ending
    // in a colon that promised the very code we just removed. It goes too.
    .replace(/\n[^\n]*:[ \t]*\n\s*\u0000DROPPED\u0000/g, '\n')
    .replace(/\u0000DROPPED\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
