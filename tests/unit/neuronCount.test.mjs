// Tests for the region neuron-count literature render.
// Run: node --test tests/unit/neuronCount.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderNeuronCountEstimate } from '../../lib/neuronCount.mjs'

const OUT = {
  tool: 'vfb_get_region_neuron_count',
  query: { resolved_region: 'adult central brain' },
  vfb_query_summaries: [{ query_type: 'NeuronsPartHere', count: 9413 }],
  count_candidates: [
    // central-brain figure arrives as a FLOOR ("more than 125,000")
    { count_text: 'more than 125,000 neurons', count_numeric_floor: 125000, scope: 'adult Drosophila central brain connectome/model', source_pmid: '39358519', source_title: 'A central-brain connectome' },
    { count_numeric: 139255, scope: 'whole adult Drosophila brain', source_pmid: '39358518', source_title: 'A whole-brain wiring diagram' },
    { count_numeric_floor: 125000, scope: 'adult Drosophila central brain connectome/model', source_pmid: '39358519', source_title: 'A central-brain connectome' } // dup
  ]
}

test('renderNeuronCountEstimate lists cited estimates (exact and floor) and the annotated count, deduplicated', () => {
  const md = renderNeuronCountEstimate(OUT, 'adult central brain')
  assert.match(md, /Published neuron-count estimates — adult central brain/)
  assert.match(md, /more than 125,000 neurons .* — A central-brain connectome — PMID 39358519/)  // floor rendered
  assert.match(md, /~139,255 neurons \(whole adult Drosophila brain\)/)                          // exact rendered
  // dedup: only one 125,000 line
  assert.equal((md.match(/125,000/g) || []).length, 1)
  // annotated count distinguished
  assert.match(md, /VFB has annotated 9,413 neuron types.*not the biological total/)
})

test('renderNeuronCountEstimate returns empty when there is no literature estimate', () => {
  assert.equal(renderNeuronCountEstimate({ tool: 'vfb_get_region_neuron_count', count_candidates: [] }), '')
  assert.equal(renderNeuronCountEstimate(null), '')
})
