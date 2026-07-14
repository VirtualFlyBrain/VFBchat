import { searchReviewedDocs } from './lib/reviewedDocsSearch.js'
const r = await Promise.race([ searchReviewedDocs('What datasets are available?', 5), new Promise((_,x)=>setTimeout(()=>x(new Error('t')),25000)) ])
const results = (r && r.results) || []
console.log('top results for "What datasets are available?":')
results.slice(0,5).forEach(x=>console.log('  -', x.title, '|', x.url))
process.exit(0)
