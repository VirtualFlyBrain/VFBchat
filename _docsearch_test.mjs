import { searchReviewedDocs } from './lib/reviewedDocsSearch.js'
for (const q of ['NeuroFly 2026 conference', 'When and where is NeuroFly 2026', 'european drosophila conference']) {
  try {
    const r = await Promise.race([ searchReviewedDocs(q, 5), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')), 25000)) ])
    const results = (r && (r.results || r.matches)) || (Array.isArray(r)?r:[])
    const urls = (Array.isArray(results)?results:[]).map(x => x.url || x.link || (typeof x==='string'?x:JSON.stringify(x).slice(0,120)))
    console.log(`\nQUERY: ${q}\n  -> ${urls.length} results`)
    urls.slice(0,5).forEach(u=>console.log('   ',u))
    if(!urls.length) console.log('   RAW:', JSON.stringify(r).slice(0,250))
  } catch (e) { console.log(`\nQUERY: ${q}\n  ERROR: ${e.message}`) }
}
process.exit(0)
