// Fly stocks for the split-GAL4 lines that target a neuron class (pure,
// offline-testable). The route layer fetches; everything here is shape.
//
// "Find me fly stocks for split drivers expressed in gamma dorsal KCs" is a
// three-hop question, and none of the hops was wired to the next (issue #46):
//
//   1. SplitsTargeting on the class lists its split-GAL4 expression patterns.
//      Each row's id is the two hemidriver constructs it intersects —
//      VFBexp_FBtp0099464FBtp0117485 is P{R21B06-GAL4.DBD} ∩ P{R13F02-p65.AD}.
//   2. FindStocks takes a FlyBase feature id, and an FBtp construct is one. Run
//      on the DBD it returns every stock carrying that DBD — with any AD.
//   3. The stock that carries BOTH constructs is the split-GAL4 stock: the
//      intersection of the two FindStocks results. For the row above that is
//      Bloomington 68318 and nothing else.
//
// So the answer to "which stocks" is a set intersection per split, batched
// into one run_query call for all the constructs. What was shipped instead was
// "VFB does not directly list the corresponding fly stock numbers", which is
// false: it lists them, one hop further than the planner looked.

const FBTP_RE = /FBtp\d{7}/g
const LINK_RE = /^\[(.*?)\]\((.*?)\)$/

/** Split-name text out of a markdown cell, or the raw text. */
function cellText(v = '') {
  const s = String(v || '').trim()
  const m = s.match(LINK_RE)
  return (m ? m[1] : s).trim()
}

/**
 * Read a SplitsTargeting result into {id, label, constructs:[FBtp…]} rows,
 * keeping only rows whose id names two constructs — the only rows a stock can
 * be found for.
 */
export function parseSplitRows(parsed) {
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
  const out = []
  for (const r of rows) {
    const id = String(r?.id || '').trim()
    const constructs = [...new Set(id.match(FBTP_RE) || [])]
    if (constructs.length < 2) continue
    out.push({
      id,
      label: cellText(r.label || r.name || id).replace(/\s+expression pattern$/i, ''),
      constructs
    })
  }
  return out
}

/** Read one FindStocks result (or a batch entry) into stock rows. */
export function parseStockRows(parsed) {
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
  return rows
    .map(r => ({
      id: String(r?.stock_id || r?.id || '').trim(),
      number: String(r?.stock_number || '').trim(),
      genotype: String(r?.genotype || '').trim(),
      collection: String(r?.collection || '').trim()
    }))
    .filter(s => s.id)
}

/**
 * Stocks per split: those present in the FindStocks result of EVERY construct
 * the split intersects. `stocksByConstruct` maps FBtp id → parsed stock rows.
 */
export function intersectSplitStocks(splits = [], stocksByConstruct = new Map()) {
  return splits.map(split => {
    const lists = split.constructs.map(c => stocksByConstruct.get(c) || [])
    const checked = split.constructs.filter(c => stocksByConstruct.has(c))
    let stocks = []
    if (lists.every(l => l.length)) {
      const [first, ...rest] = lists
      stocks = first.filter(s => rest.every(l => l.some(o => o.id === s.id)))
    }
    return { ...split, stocks, constructs_checked: checked.length }
  })
}

const CENTRE_SHORT = [
  [/bloomington/i, 'BDSC'],
  [/kyoto/i, 'Kyoto'],
  [/vdrc|vienna/i, 'VDRC'],
  [/ncbi|national institute of genetics|nig/i, 'NIG']
]
function centreShort(collection = '') {
  for (const [re, short] of CENTRE_SHORT) if (re.test(collection)) return short
  return collection || 'stock centre'
}

const VFB_REPORT = 'https://www.virtualflybrain.org/reports/'
const FLYBASE_REPORT = 'https://flybase.org/reports/'

/** A one-line description of a stock for prose and tags: "BDSC 68318". */
export function describeStock(s) {
  return `${centreShort(s.collection)} ${s.number || s.id}`
}

/**
 * The deterministic claim and the display table for a split-stocks result.
 * Says what was checked, because "no stock" for a split means "no stock in
 * FlyBase for this construct pair", not "unknown".
 */
export function summariseSplitStocks(result) {
  const splits = Array.isArray(result?.splits) ? result.splits : []
  if (!splits.length) return null
  const label = result.resolved?.label || 'this class'
  const withStocks = splits.filter(s => s.stocks?.length)
  const without = splits.filter(s => !s.stocks?.length)
  const parts = []
  parts.push(`VFB lists ${splits.length} split-GAL4 line${splits.length === 1 ? '' : 's'} targeting ${label}` +
    (Number.isFinite(result.split_count) && result.split_count > splits.length ? ` (${splits.length} of ${result.split_count} checked for stocks)` : ''))
  if (withStocks.length) {
    parts.push(`FlyBase records a stock carrying both hemidrivers for ${withStocks.length} of them: ` +
      withStocks.map(s => `${s.label} — ${s.stocks.map(describeStock).join(', ')}`).join('; '))
  }
  if (without.length) {
    parts.push(`No stock carrying both hemidrivers is recorded in FlyBase for ${without.map(s => s.label).join(', ')}` +
      '; the individual hemidriver stocks may still exist')
  }
  const rows = splits.map(s => ({
    name: s.label,
    id: s.id,
    reportUrl: `${VFB_REPORT}${s.id}`,
    tags: s.stocks?.length
      ? s.stocks.map(describeStock)
      : ['no combined stock in FlyBase'],
    cells: {
      stocks: s.stocks?.length ? s.stocks.map(describeStock).join(', ') : '—',
      genotype: s.stocks?.[0]?.genotype || ''
    },
    links: (s.stocks || []).map(st => ({ label: describeStock(st), url: `${FLYBASE_REPORT}${st.id}` }))
  }))
  return {
    claim: `${parts.join('. ')}.`,
    table: {
      kind: 'split-stocks',
      title: `Split-GAL4 lines targeting ${label} and their fly stocks`,
      subtitle: 'stocks are FlyBase records carrying both hemidrivers of the split',
      termId: result.resolved?.id || '',
      termLabel: label,
      count: splits.length,
      countKind: 'exact',
      countNoun: 'split-GAL4 lines',
      columns: [
        { key: 'stocks', label: 'Stock(s)', hint: 'stock centre and number; the FlyBase stock report is linked' },
        { key: 'genotype', label: 'Genotype', hint: 'genotype of the first listed stock' }
      ],
      rows
    },
    rows: withStocks.map(s => ({ name: s.label, id: s.id }))
  }
}
