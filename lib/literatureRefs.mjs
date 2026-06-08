// Literature reference extraction (pure logic) for the literature/reference
// retriever role (design report §4.8).
//
// VFB get_term_info returns a `Publications` array; each item has the shape
// { microref, PubMed, FlyBase, DOI } (VFBquery term_info_queries.py). This
// module normalises those into refs the literature retriever can follow into
// PubMed / bioRxiv, with a best link per ref. Pure + offline-testable; the
// fetch/extract calls live in route.js using the existing search_pubmed /
// get_pubmed_article / biorxiv_* tools.

function clean(v) {
  return typeof v === 'string' ? v.trim() : ''
}
// VFBquery treats an identifier as present only when length > 2.
function present(v) {
  return clean(v).length > 2
}

/** Best external URL for a ref: DOI > PubMed > FlyBase. */
export function bestRefUrl(ref) {
  if (!ref) return ''
  if (present(ref.doi)) return `https://doi.org/${clean(ref.doi)}`
  if (present(ref.pmid)) return `https://pubmed.ncbi.nlm.nih.gov/${clean(ref.pmid)}/`
  if (present(ref.fbrf)) return `https://flybase.org/reports/${clean(ref.fbrf)}`
  return ''
}

/**
 * Extract and normalise publication refs from a VFB get_term_info payload.
 * @param {object} termInfoPayload  parsed get_term_info result (has .Publications)
 * @param {number} [max=20]
 * @returns {Array<{pmid:string, doi:string, fbrf:string, citation:string, url:string}>}
 */
export function extractPublicationRefs(termInfoPayload, max = 20) {
  const pubs = termInfoPayload && Array.isArray(termInfoPayload.Publications)
    ? termInfoPayload.Publications
    : []
  const out = []
  const seen = new Set()
  for (const p of pubs) {
    if (!p || typeof p !== 'object') continue
    const ref = {
      pmid: present(p.PubMed) ? clean(p.PubMed) : '',
      doi: present(p.DOI) ? clean(p.DOI) : '',
      fbrf: present(p.FlyBase) ? clean(p.FlyBase) : '',
      citation: clean(p.microref) || clean(p.miniref) || ''
    }
    if (!ref.pmid && !ref.doi && !ref.fbrf) continue // no resolvable identifier
    const dedupeKey = ref.pmid || ref.doi || ref.fbrf
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    ref.url = bestRefUrl(ref)
    out.push(ref)
    if (out.length >= max) break
  }
  return out
}

/** Does this term have any followable publication refs? */
export function hasPublicationRefs(termInfoPayload) {
  return extractPublicationRefs(termInfoPayload, 1).length > 0
}
