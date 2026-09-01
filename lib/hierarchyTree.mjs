// Ontology hierarchy → nested list (pure, offline-testable).
//
// "Show me the hierarchy of Kenyon cell subtypes" was answered with a
// sentence naming a dozen of the 37 subclasses, then "VFB records the direct
// subclasses but does not provide a multi-level hierarchical tree structure in
// this view" (issue #48). The MCP has had get_hierarchy for exactly this since
// 1.9 — two guidance cards even told the planner to use it — but the tool was
// never wired into the catalogue, so the planner reached for a name that did
// not exist. This module turns the tool's nested payload into a claim the
// synthesiser can narrate and a nested list the interface renders verbatim.

const VFB_REPORT = 'https://www.virtualflybrain.org/reports/'

function node(raw) {
  const id = String(raw?.id || '').trim()
  const label = String(raw?.label || raw?.name || id).trim()
  if (!id && !label) return null
  const kids = Array.isArray(raw?.descendants) ? raw.descendants
    : Array.isArray(raw?.ancestors) ? raw.ancestors
      : Array.isArray(raw?.children) ? raw.children : []
  return { id, label, children: kids.map(node).filter(Boolean) }
}

/**
 * Read a get_hierarchy payload. Returns null when it carries no tree.
 * @returns {null|{id:string,label:string,relationship:string,descendants:Array,ancestors:Array}}
 */
export function parseHierarchy(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const id = String(parsed.id || '').trim()
  const label = String(parsed.label || id).trim()
  if (!id) return null
  const descendants = (Array.isArray(parsed.descendants) ? parsed.descendants : []).map(node).filter(Boolean)
  const ancestors = (Array.isArray(parsed.ancestors) ? parsed.ancestors : []).map(node).filter(Boolean)
  if (!descendants.length && !ancestors.length) return null
  return {
    id,
    label,
    relationship: String(parsed.relationship || 'subclass_of'),
    descendants,
    ancestors
  }
}

function countNodes(list = []) {
  let n = 0
  for (const x of list) n += 1 + countNodes(x.children)
  return n
}

function depthOf(list = [], d = 0) {
  let max = d
  for (const x of list) max = Math.max(max, depthOf(x.children, d + 1))
  return max
}

/** Every node in the tree, once, for the link registry. */
export function hierarchyNodes(tree) {
  const out = []
  const seen = new Set()
  const walk = (list) => {
    for (const x of list) {
      if (x.id && !seen.has(x.id)) { seen.add(x.id); out.push({ name: x.label, id: x.id }) }
      walk(x.children)
    }
  }
  if (tree) { walk(tree.descendants); walk(tree.ancestors) }
  return out
}

const RELATION_WORDS = {
  subclass_of: { down: 'subtypes', up: 'parent classes', of: 'subtype of' },
  part_of: { down: 'parts', up: 'containing regions', of: 'part of' }
}

/**
 * A deterministic claim: how many direct children, how many in the tree, how
 * deep it was expanded, and the direct children by name. The full tree is the
 * rendered list, not the prose.
 */
export function summariseHierarchy(tree, { maxNamed = 12 } = {}) {
  if (!tree) return null
  const words = RELATION_WORDS[tree.relationship] || RELATION_WORDS.subclass_of
  const parts = []
  if (tree.descendants.length) {
    const direct = tree.descendants.map(x => x.label)
    const total = countNodes(tree.descendants)
    const depth = depthOf(tree.descendants)
    parts.push(
      `VFB's ontology places ${direct.length} direct ${words.down} under ${tree.label}` +
      (total > direct.length ? `, ${total} ${words.down} in all across ${depth} levels` : '') +
      `: ${direct.slice(0, maxNamed).join(', ')}${direct.length > maxNamed ? `, and ${direct.length - maxNamed} more` : ''}`
    )
  }
  if (tree.ancestors.length) {
    const chain = []
    let cur = tree.ancestors
    while (cur && cur.length) { chain.push(cur[0].label); cur = cur[0].children }
    parts.push(`${tree.label} is a ${words.of} ${chain.join(', which is a ' + words.of + ' ')}`)
  }
  if (!parts.length) return null
  return {
    claim: `${parts.join('. ')}. The full tree is shown below the answer.`,
    directCount: tree.descendants.length,
    totalCount: countNodes(tree.descendants),
    rows: hierarchyNodes(tree)
  }
}

function renderList(list, depth, budget, lines) {
  for (const x of list) {
    if (budget.left <= 0) { budget.cut += 1 + countNodes(x.children); continue }
    budget.left -= 1
    const link = x.id ? `[${x.label}](${VFB_REPORT}${x.id})` : x.label
    lines.push(`${'  '.repeat(depth)}- ${link}`)
    renderList(x.children, depth + 1, budget, lines)
  }
}

/**
 * The tree as a nested markdown list, each node linked to its VFB report,
 * capped so a broad class cannot flood the answer. Appended to the answer
 * after synthesis, so the ids in the links never reach a model.
 */
export function renderHierarchyMarkdown(tree, { maxNodes = 150 } = {}) {
  if (!tree) return ''
  const words = RELATION_WORDS[tree.relationship] || RELATION_WORDS.subclass_of
  const out = []
  if (tree.descendants.length) {
    const lines = []
    const budget = { left: maxNodes, cut: 0 }
    lines.push(`- [${tree.label}](${VFB_REPORT}${tree.id})`)
    renderList(tree.descendants, 1, budget, lines)
    const cap = words.down.charAt(0).toUpperCase() + words.down.slice(1)
    out.push(`**${cap} of ${tree.label}** (${countNodes(tree.descendants)} in VFB's ontology, ${depthOf(tree.descendants)} level${depthOf(tree.descendants) === 1 ? '' : 's'} shown)\n\n${lines.join('\n')}` +
      (budget.cut ? `\n\n_… and ${budget.cut} more not shown; open ${tree.label} in VFB for the full tree._` : ''))
  }
  if (tree.ancestors.length) {
    const chain = []
    let cur = tree.ancestors
    while (cur && cur.length) { chain.push(cur[0]); cur = cur[0].children }
    const lines = chain.map((x, i) => `${'  '.repeat(i)}- [${x.label}](${VFB_REPORT}${x.id})`)
    lines.push(`${'  '.repeat(chain.length)}- **${tree.label}**`)
    const cap = words.up.charAt(0).toUpperCase() + words.up.slice(1)
    out.push(`**${cap} of ${tree.label}**\n\n${lines.join('\n')}`)
  }
  return out.join('\n\n')
}
