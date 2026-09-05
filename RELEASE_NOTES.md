# Release Notes

This file summarizes the release notes inferred from git tags (tag message/annotation). It is intended to preserve release history in the repository.

---

## v4.2.14
- **A symbol that names a type resolves to the type.** "EPG neurons" — a class named by its symbol, "EPG" — matched a FAFB reconstruction's synonym first (that cell also carries "EPG" as a synonym) and answered with one neuron's 38 partners as what VFB knows about EPG neurons. A name of the shape *symbol + category noun* ("EPG neurons", "the EPG neuron", "Kenyon cell types") names a type, and no record's own label ends that way — so when such a name lands on an individual without matching its label exactly, the resolver now searches the symbol alone among classes and takes an exact match. EPG neurons now return the class (FBbt_00047030): term info, 214 images, 10 subclasses, 12 driver reports, and the ranked downstream partner table. A connectivity question no longer gets an unrelated subtype tree appended just for saying "cell types" ([#59](https://github.com/VirtualFlyBrain/VFBchat/issues/59)).

  **scRNA-seq expression columns now say what they are.** Every column of a multi-cluster expression table read the same cell-type label, because that is all the tool showed; the cluster names themselves encode the difference — study, year, sex, tissue. Column headers now read *Davie 2018 · whole fly*, *FCA 2022 · female head*, *AFCA 2023 D30 · male whole fly*, with the cell type prefixed only when it varies across columns, duplicate headers numbered, and the table caption stating what the columns are. The clusters queried are also spread across datasets — one per study before a second from any — so a table compares studies rather than four sex/tissue splits of the same one ([#58](https://github.com/VirtualFlyBrain/VFBchat/issues/58)).

  Unit suite 1,315; full 72-task battery, 72/72, 0 errors, run twice (once under CI, once locally at concurrency 4 against a production build). [#60](https://github.com/VirtualFlyBrain/VFBchat/pull/60), feedback from Clare, 4 September.

## v4.2.13
- **The welcome-screen prompts answer.** Three of the five example prompts on the chat's own first screen failed, and none was in the battery. "What neurons are involved in visual processing?" searched the phrase verbatim, found nothing, and then fetched an id from memory; a planner search that returns nothing is now withdrawn and its phrase handed to the resolver, which learned that "<modality> processing" is FBbt's "<modality> system", and a step whose id no search, term or prior turn supplied is withdrawn. "Find neurons similar to DA1 using NBLAST" resolved DA1 to a larval tracheal anastomosis (an exact synonym) and ran NBLAST on it; a symbol matched on a synonym outside the kind the question names is re-searched within that kind, and the answer names the other readings (DA1 lPN, DA1 vPN, MN-DA1). "What genes are expressed in the antennal lobe?" denied single-cell data for a region whose cell types have 23 clusters; the expression tool now hops to the region's most general cell type with scRNA-seq data and says so.

  **Unmatched names now lead somewhere.** When nothing resolves, one search per content word collects terms VFB does hold, and the answer ends with concrete rephrasings built on them instead of "could not be matched".

  All five welcome prompts are tier-1 battery tasks (WS1–WS5); the main battery passes 69/69. Workshop feedback from Kit Longden, 3 September ([#57](https://github.com/VirtualFlyBrain/VFBchat/pull/57)).

## v4.2.12
- **Documentation answers now read the page.** On the current site layout,
  `get_reviewed_page` returned the docs sidebar — the section tree, ~100 links
  that sit inside `<main>` ahead of the article — and nothing of the article
  itself, because the block cap filled on those links before the first
  paragraph. Every documentation page was affected; "How many larval datasets
  does VFB hold?" was answered from the dataset name list. Inside `<main>`, a
  single `<article>` is now the page, the caps are raised so a 210-row reference
  table fits under the extractor's window, and Goldmark's typographic entities
  are decoded.

  **The site's own search index is a source.** `virtualflybrain.org/search/` is
  client-side over `/index.json` — every page's title, description, section and
  body text, rebuilt with the site. The chat now reads that file too, alongside
  its seed list and the sitemap crawl, so the first question after a cold start
  ranks on what the pages say rather than on their URL slugs. Only the pages
  half is used; terms come from the MCP, as before.

  **The right page is opened first.** Candidates whose title or URL share a
  topic word with the question are read before ones that merely out-rank them;
  question words ("how many") no longer count as topic words, and tokens are
  stemmed, so "dataset" finds "Datasets by stage". The synthesiser is told that a
  documentation page which addresses the question as asked outranks a raw
  catalogue listing that does not.

  **Housekeeping.** The static lookup cache at the repository root, unread since
  August and carrying wrong ids, is deleted. The task battery commits its results
  only from a successful run on the default branch, with a rebase-and-retry push;
  branch runs keep a 90-day artifact instead.

## v4.2.11
- **Connectivity answers now rank the biology on every route, and show it as a
  table.** "What are the main inputs to KCg-s?" was answered with adult neuron,
  Kenyon cell and interneuron, and a graph of fifteen overlapping labels. The
  deterministic ranker that orders partner classes by mean synaptic weight per
  connected pair existed, but only fired on one of the two payload shapes a class
  question can produce; the other — the partner tool's, which the planner and the
  injector actually use — went to the extractor pre-ranked by total weight, which
  ranks the ontology. A class now runs its whole connectivity table, the ranker
  fires on both shapes, and the answer carries a sortable table (partner, synapses
  per connected pair, % connected, pairs, total) with the roll-up classes and the
  self-connection appended and labelled rather than hidden. The graph sits behind
  "Show as a graph", draws only the ranked specific partners, and puts its labels
  beside the nodes. Two facts about VFB's class-connectivity table surfaced on the
  way: it carries rows for the queried class *and* every subclass, so only the
  queried class's rows are read now (a subclass's 98.5 synapses per pair had been
  reported as the parent's); and on a four-cell class unrelated partners can share
  pair and connected counts by chance, so the chain-collapse now requires the
  synapse total to agree as well. (#47, #50)

  **Fly stocks for a neuron class's split-GAL4 lines.** "Find me fly stocks for
  split drivers expressed in gamma dorsal KCs" was told VFB does not list stock
  numbers. It does, one hop further than the planner looked: each SplitsTargeting
  row names its two hemidriver constructs, FindStocks accepts a construct, and the
  stock in both constructs' results is the split-GAL4 stock — Bloomington 68318 for
  R21B06-DBD ∩ R13F02-AD. A new `vfb_find_split_stocks` macro runs that chain with
  the lookups batched, and the answer lists each split with its stock centre and
  number; seven of the nine KCg-d splits have one. "Split drivers" now counts as
  split-GAL4 wording. (#46)

  **Ontology hierarchies are drawn as trees.** "Show me the hierarchy of Kenyon cell
  subtypes" ran the 32,328-row image list, because "show me" was an image cue, and
  then explained that VFB does not provide a multi-level tree. The MCP's
  `get_hierarchy` tool was referenced by two guidance cards but had never been put
  in the tool catalogue. It is wired now, runs deterministically for hierarchy,
  subtype and parts wording, and the tree is rendered as a nested, linked list
  under the answer; the SubclassesOf table replaces the image list, because result
  tables are now chosen by the kind of thing the question asks for rather than by
  word overlap. (#48)

  **Term resolution.** The AllDatasets fast path no longer hijacks a question whose
  dataset clause is a scope with a stranded preposition ("which datasets they're
  in") or whose subject is an unquoted symbol ("DA1 lPN neurons") — the NeuroFly
  workshop's own discovery prompt. The term tokeniser keeps the prime, so
  alpha/beta and alpha'/beta' Kenyon cell resolve to their own classes instead of
  whichever VFB ranked first. A symbol the question names is looked up even when
  the planner, shown the previous turn, read it as a back-reference to that turn's
  term — "inputs to KCg-s" after a turn on KCg-d now answers about KCg-s. The
  intrinsic-neuron class is resolved when the planner copies the whole phrase
  ("neuron types intrinsic to the mushroom body"), and evidence reaches the
  synthesiser VFB first, documentation second, literature last — so the mushroom
  body's intrinsic neurons are the Kenyon cells, not the MBONs a paper snippet
  named. (#39, #40, #44)

  **Expression answers filter by gene function.** "Which receptor genes are most
  highly expressed in Kenyon cells?" listed ribosomal RNAs: only hand-kept symbol
  lists could filter. The cluster expression table tags every gene with FlyBase's
  function vocabulary — Receptor, Dopamine_receptor, Transcription_factor,
  Ion_channel, GPCR and so on — so a function named in the question now filters on
  that column, ranked by level. (#45)

  **Rendering.** Pipe tables render (remark-gfm had never been installed, so the
  scRNA-seq expression matrix arrived as a paragraph of literal bars); ranked lists
  number 1, 2, 3 rather than 1, 1, 1; the chat panel scrolls itself, only while the
  reader is at the bottom, instead of scrolling the whole document out from under
  the conversation; and the thumbnail strip is chosen by what the question is
  about — an image question gets the query previews, a definitional one the
  term's own example images, and a question on the expression, connectivity,
  stocks or dataset axis gets none. (#41, #42, #43, #45)

  **Verification.** `tests/task-battery/workshop.json` holds every NeuroFly workshop
  chat prompt and the 31 August walk-through as a tier-8 battery. Against v4.2.10 it
  fails three of eleven tasks, at the points the issues describe; against this
  release it passes all eleven. The per-question battery timeout is 900 s.

  **Build.** Each architecture is now built on a runner of that architecture and
  the multi-arch manifest assembled from the two digests; the arm64 image was
  built under QEMU, where Next's native compiler intermittently died with an
  illegal instruction. Every workflow action is on a current major, ahead of the
  retirement of the Node 20 action runtime.

## v4.2.10
- **The privacy notice now identifies who is responsible for the data, and on what
  legal basis.** It named neither. It gave the data categories, the recipients, the
  transfer mechanism, the retention periods and the DPO's address — and never said
  that the University of Edinburgh is the controller, never stated a lawful basis,
  listed only two of the six data subject rights, and offered no route to the ICO.
  Those are Article 13 essentials, and the transparency answer in the service's data
  protection assessment rests entirely on that page. It now names the controller
  with its ICO registration; states Article 6(1)(e) public task, grounded in the
  Universities (Scotland) Acts 1858 to 1966 and the Further and Higher Education
  (Scotland) Act 2005, with consent for a transcript a user chooses to attach to a
  problem report; gives the full rights list and how to exercise them using the
  response identifier shown under every answer; and gives the ICO complaint route.
  Legitimate interests was considered and is not available: Article 6(1) provides
  that it does not apply to processing carried out by a public authority in the
  performance of its tasks, and the IP address held for abuse prevention exists
  solely to keep a public-task service available. The notice also now says that
  literature search reaches PubMed and bioRxiv, and what is sent to them — a string
  built from the resolved VFB term, never the question.

  **The accessibility audit now sees an answer.** It loaded each page and ran axe
  against it, which on the chat page is a heading, an input and a send button.
  Everything a reader actually spends time in exists only after a question has been
  answered — the answer text, result tables, the image gallery and its data-derived
  alt text, inline citations, the response identifier and its copy button, the
  feedback controls — and none of it was covered, although it is the surface most
  likely to be wrong, because it is assembled from model output rather than written
  by hand. A fifth target drives the real interface to a rendered answer against a
  stubbed response, so axe sees the production DOM with only the words fixed. It
  found two contrast failures on its first run, both now fixed: the `Response ID:`
  label at 3.94:1 and the tag line in a result row at 4.42:1, where WCAG 2.2 AA
  wants 4.5:1 for text that size.

  **The accessibility statement now says what has not been tested.** It claimed ten
  measures without saying how any had been checked, and two of them — live regions
  for streamed content, and alternative text on images — were precisely about the
  state the audit never visited. It now separates what is verified automatically on
  every change, what automation cannot establish (whether data-derived alt text is
  *useful*, whether a live region announces well), and what has not been tested at
  all: screen readers, voice recognition, and reflow at 400% with a long answer. The
  Regulations ask for an accurate statement, not a clean one.

  **The container log no longer echoes a web address the user typed.** Tool
  arguments were rendered by shape while the upstream error beside them was printed
  verbatim, and `get_reviewed_page` takes a URL whose path is unconstrained — only
  the host is allow-listed — which the fetcher throws back in its message. The
  redaction was defeated by the value next to it, in a public CI log. Errors now go
  through the same renderer at all five sites. The argument value test was "contains
  no whitespace", which a URL and a seventy-character lab identifier both pass; it
  is now identifier-shaped, forty characters and no path separators, so real VFB
  vocabulary still prints and the diagnostic keeps its value. The behavioural guard
  had caught neither, because it planted its canary only in the question and the
  term name and its tool-failure case threw an error containing no user text. Two
  new cases close both paths.

  **Hostnames a user types are no longer kept by name for twenty-six months.** They
  are extracted by regex so the service can refuse to fetch anything off its
  allow-list, and the refusal was recorded in the long-retention counters with the
  name attached — a fragment of what someone wrote, in the tier meant to hold
  nothing but counts. It is now a count. The names remain in the thirty-day security
  and blocked-search logs, which is where an abuse investigation would look anyway.

  **The documentation index points at the site that exists.** The task battery
  failed on a Circuit Browser question because the model constructed a plausible URL
  on an allow-listed host and got a 404 — the index held thirteen entries, two of
  them documentation pages, against seventy-seven pages the site publishes. The home
  page pointed at the non-canonical bare host, which answers a redirect to `http`;
  the 3D viewer pointed at a single-page app that serves no readable text; and
  `/reports/` is a routed namespace rather than a document. All three corrected, the
  whole Website Features section added, and a landing page for each of Concepts,
  Data, Tutorials, APIs, Anatomy Diagrams, Resources and Overview, with titles and
  summaries taken from each page's own front matter. Every one of the twenty-seven
  URLs returns 200 with no redirect.

  **Also:** `NCBI_EMAIL` is passed through the compose file, having been set on the
  server but never reaching the container, because Compose forwards only what is
  listed. And the chat's opening guidance now asks users not to share personal
  information, where it named only confidential and sensitive.

  **Verification.** 62/64 on the task battery, the two failures being 240-second
  timeouts on live model calls rather than assertions. The offline unit suite is
  1279 green across 88 files. `next lint` and `next build` are clean. The WCAG 2.2
  AA audit reports zero machine-detectable violations across all five targets,
  including the answered state — which is a floor and not a certificate, and the
  statement now says so.

## v4.2.9
- **Every citation in an answer can now be followed.** The synthesiser is forbidden to write URLs, because a model that writes its own links invents them; the automatic linking that rule promises in exchange only ever covered VFB term reports. So anything that was not an ontology term could not be cited by any route. The visible case was the neuron-count answer, which opens by saying there is no single figure — it depends on the boundaries, the specimen and the counting method — and cited nothing, although that framing is drawn from VFB's own reviewed article on neuron counts, and although the tool payload already carried the article's URL and an instruction to point the reader at it. The model was simultaneously told never to write a URL, so the two cancelled, every time. References are now emitted deterministically, exactly as the term sources already were: `lib/referenceSources.mjs` turns literature evidence and the article and primary papers behind a curated count into sources, deduplicated across trailing slash, `www` and scheme. Each source carries what is on the other side of the link — a term report, a documentation page, a paper — and words its own hover text accordingly. The count block links every figure to its paper, prints the curator's note that qualifies it, and closes with the article. The article's URL now comes from `config/fly-neuron-counts.json` rather than a string literal, so moving the page cannot leave the reference pointing at a 404.

  **Documentation sources had never worked at all, for any question.** `buildEvidenceRow` spreads its locator, so an evidence row has no `.locator` field; `buildFollowOns` read `e.locator?.url`. No VFB documentation page has ever appeared beneath an answer. The unit test passed throughout because it built its fixture by hand in the nested shape the builder has never produced — a test agreeing with the code instead of with production. Fixtures now go through `buildEvidenceRow`.

  **The container log no longer repeats what the user typed, and a test keeps it that way.** Rendering tool arguments by shape closed this once, and nothing asserted it stayed closed while three rounds of diagnostics widened the surface again — each caught by somebody reading the code rather than by a failing build. The guard is now behavioural: every path is driven for real with a canary planted where the user's text enters, and the assertion is that the canary reaches no console writer, so a new diagnostic that interpolates user text fails the build without anyone remembering the file exists. It found four leaks that were live, none of them tool arguments: the term name in `get_term_info FAILED` and in `deprecated term redirected`, and the verbatim absence sentence in `ABSENCE ESCALATION` and `ABSENCE GATE`. An absence sentence is the model's prose rather than typed text — but the model writes a denial by restating the question. Names now render by shape, and the absence lines name the pattern they matched, which is countable across runs and more useful than the sentence was. The second half of the test asserts the opposite direction: under `VFB_HARNESS_TRACE` those values are printed in full, because a privacy guard that cannot be turned off for debugging gets turned off by deletion.

  **Every answer now shows its response identifier**, with a sentence in the privacy notice explaining what it is for, so a user reporting a bad answer can name it and it can be found.

  **The region-count injector decides out loud.** Every gate it takes was silent, and only the success path called `log()` — which appends to the per-request trace, printed only under `VFB_HARNESS_TRACE`. On a production container the absence of an `inject` line was therefore not evidence that the injector declined; it was not evidence either way, and a conclusion was drawn from exactly that during the 11 August defect review. The decision now goes to stderr on both paths, once the question has count intent, naming ontology ids and gate names only. The injector also prefers the ontology class over a painted domain: VFB's search answers "fly brain" with hundreds of painted domains on JRC_FlyEM_Hemibrain, every one of which satisfies the region test as well as `brain` does, and one extra survivor was enough to take the count off the table.

  **A rewritten answer no longer appears twice.** Synthesis streams into a single live bubble that only the final result event closes, so when absence escalation bought a second synthesis its tokens were appended to the first draft's and the reader watched the same answer written out twice in two wordings. On the flagship count question that window is a whole extra round of queries, and a connection dropping inside it left the duplicate as what the reader kept. The tokens are already sent, so the server cannot unsend them; the client is told to discard the draft instead.

  **The first request after a restart waits for the model catalogue** rather than resolving every preference list unfiltered against a catalogue it does not have yet. Separately, structured image and row URLs harvested from tool output now meet the same outbound allow-list the prose does — they had been reaching the browser as `<img src>` without ever being checked. They are all virtualflybrain.org addresses today, which is a fact about today.

  **Verification.** 64/64 on the task battery at 5be963d, the first clean sweep, with zero on every quality measure: no factual answer without a tool, no tool claim without a tool, no disambiguation-only or plan-only answers, no unreported graph failures, no context lost across a turn. The one flag raised is a slow follow-up turn on C3. `next lint` is clean, the offline unit suite is 1279 green, and the multi-architecture image built.

  **What this release does not prove.** Nothing here was validated against live ELM and MCP before merge — the sandbox cannot reach either, so the battery run on `main` above is the first live evidence, and the reference links have not been looked at in a browser. The arm64 leg of the build still dies intermittently under QEMU with an illegal instruction; it took three attempts on the v4.2.8 merge and is not a code failure, but it is not fixed either.

## v4.2.8
- **There is no v4.2.7 image.** The v4.2.7 release exists on GitHub with nothing behind it: the version gate added in v4.2.5 failed the build before the push, so the tag was published and no image was ever produced. Docker Hub's `4.2` still points at 4.2.6's build, so deployments have been serving 4.2.6 and reporting 4.2.6 throughout — consistent, just a release behind. This release is what v4.2.7 was meant to be, plus the mechanism that makes that failure impossible.

  **Cutting a release is now publishing a tag, and nothing else.** Preparing a release used to mean applying a list from memory — `package.json`, `package-lock.json`, `RELEASE_NOTES.md`, then tag — and the memory was imperfect: v4.2.3 shipped reporting 4.2.2 while being entirely correct, and `RELEASE_NOTES.md` had been stuck at v4.2.2 across four releases. v4.2.5's answer was a gate that failed the build on disagreement, which converted a mislabelled release into no release at all. Failing was the wrong verb. CI now reads the version off the tag, applies it to every file in `RELEASE_SURFACES`, builds from that tree, and pushes the same change back to the default branch with the release body written into `RELEASE_NOTES.md`. Adding a version-carrying file means adding it to that list in `lib/releaseVersion.mjs`; nothing under `.github/` or `scripts/` changes. `--check` runs on every push and pull request, so a half-applied bump surfaces there instead of as a failing `npm ci` at release time, and `--only-if-newer` stops a hotfix or a re-published old release walking the default branch backwards. Applying a release twice is a no-op, so a failed release can be re-run rather than unpicked.

  **`config/fly-neuron-counts.json` no longer cites a mirror that cannot exist.** Its `canonical_url` pointed at `www.virtualflybrain.org/data/fly-neuron-counts.json`, a URL that can never resolve — `/data/` on virtualflybrain.org is a routed namespace that reads the path segment as a dataset id, so a static file there is unreachable however the site is built. Nothing fetched it, so the effect was inert; it was still a false statement inside a file whose entire purpose is that its contents can be trusted. The header now states the arrangement plainly: one copy, shipped in the image, no published mirror, curators edit the repo file. VirtualFlyBrain/VFB2 drops the mirror file and the article's dead link in the same change.

  **Verification.** 63/64 task battery at 363ba92, and 0 on every quality measure — no factual answer without a tool, no tool claim without a tool, no disambiguation-only or plan-only answers, no unreported graph failures. The one error is a 240 s timeout on the DNa02 descending-neuron question (T3). That is an upstream timeout reporting itself as a timeout, which is what v4.2.6 changed and is the intended behaviour rather than a regression; it is not evidence about how often that upstream is slow, and one run cannot tell you.

  **What this release does not yet prove:** that the write-back to `main` behaves under a real merge race. The retry is written and unit-tested, but until two releases land close together it has not been exercised in anger.

## v4.2.2
- Release v4.2.2: An answer may no longer tell a user that Virtual Fly Brain holds nothing until something has actually looked.

  **The rule existed and nothing enforced it.** `lib/coverage.mjs` has said since the four-state model was introduced that of RUN, EMPTY, FAILED and UNRUN, only EMPTY licenses an absence; the synthesis prompt repeats it three times in capitals. Measured against production v4.2.1 — thirteen questions, three repetitions each, judged blind — **eighteen of thirty-nine answers asserted that VFB holds nothing, and not one had a query behind it that had run and come back empty.** This release takes that to one in thirty-nine. It is the same lesson the project learned for counts in 4.1.x, where the answer was not a firmer instruction but `repairMistranscribedCounts`: state the rule, then enforce it deterministically after the model has had its say.

  **Three of those denials were about classes the ontology has held for years,** because the wording a fly neuroanatomist types and the wording VFB's index answers to are different strings. Against the live index: `γ Kenyon cell` returns zero documents and `gamma Kenyon cell` is an exact label match for FBbt_00100247; `α/β Kenyon cell` zero and `alpha/beta Kenyon cell` FBbt_00100248; `MBON-γ1pedc>α/β` zero and `MBON-gamma1pedc>alpha/beta` FBbt_00100246 at rank one. The quieter form of the same fault is more dangerous than the zero-hit one: `MBON-α′1` returns eighty documents *without* the term among them, so the resolver has plenty to pick from and no signal that it should not, where `MBON-alpha'1` puts FBbt_00111010 first. `lib/nameNormalise.mjs` transliterates Greek to the spellings FlyBase and FBbt actually store and normalises primes, arrows, dashes and non-breaking spaces. It is the first rung of `nameVariants` and only fires when there is something to transliterate, so an ASCII name still pays exactly one extra search for its plural.

  **Going and looking, rather than conceding.** If the drafted answer claims an absence and nothing came back empty, the harness injects the failed and the most relevant unrun queries and writes the answer again — failed first, because a lookup that fell over is the one case with positive evidence that the absence is an artefact. Relevance orders those attempts but does not veto them, and that distinction is load-bearing: "are any mushroom body output neurons cholinergic?" scores every query the class advertises at zero, because relevance compares a query label's words with the question's and no label contains "cholinergic" — while `SubClasses`, scoring zero, is exactly the query that answers it by enumerating the 34 subtypes. Filtering here would have escalated nothing in the case the guard exists for.

  **A query the guard chose cannot license the claim it was chosen to check.** An early cut ran `ListAllAvailableImages` for a question about hemisphere symmetry, got an empty result, and licensed the symmetry denial with it — the guard manufacturing its own permission, which is worse than the bug it replaces, because the false claim now ships with something that looks like evidence behind it. An empty from an escalation-chosen query no longer licenses absence. The cost is real and is the right way round: a run where escalation genuinely proves an absence now hedges it instead of stating it flatly. Hedging a true absence is a worse answer; asserting a false one is a wrong answer.

  **`gateAbsence` is the floor, not the fix.** It removes absence claims the ledger does not license, and by the time it fires escalation has already had its chance. `renderShelf` also gained a NAMES THAT DID NOT MATCH block for the half-resolved question — one term matches, another does not, the shelf is non-empty so the no-coverage floor never fires, and nothing in the prompt distinguished "never looked at" from "checked and found wanting". That is how a comparison of the lobula with the medulla resolved only the medulla, queried only the medulla, and reported the difference as a difference in what VFB holds.

  **Three defects the measurement exposed on the way.** `harnessFraming` was producing the framing it exists to remove: `EVIDENCE_SUBJECT` needs "the evidence", `INPUT_NOUN` matches "the provided evidence" as a unit and rewrites it to "VFB evidence", so the subject rules ran first, found "provided" in the way, did nothing, and the noun rule then produced exactly the subject they would have handled, one pass too late — shipping "VFB evidence lists queries for subclasses, scRNAseq data … but it does not include a completed query", which is this program's working set wearing VFB's name. The rules were right and their order was wrong. Definitions were being summarised twice: "what is the ellipsoid body?" returned the same 254 characters on all three repetitions, dropping the ellipsoid body canal, the anterior bundle, the 16 radial segments and the Ito et al. citation, because the extractor is a weak model summarising the whole term-info record into one claim and a definitional question went through two paraphrase hops before reaching the reader. The description is now carried verbatim as its own evidence row — 254 characters to 471, all three sentences and the citation intact. And the escalation had no sense of time, buying a second synthesis at three minutes on a run that then timed out, turning a usable if hedged answer into "the language service did not respond"; it now stops at `ABSENCE_ESCALATION_DEADLINE_MS`, 120 s and env-tunable, derived from the tighter of the two ceilings in the system rather than from the run deadline alone.

  **Numbers.** Same thirteen questions, three repetitions each: unlicensed absence claims 18 → 1, errors 0 → 0, median 66 s → 77 s, worst case 429 s → 246 s. The 64-task battery is 64/64 with no errors. 1188 unit tests, no failures; every positive case in `tests/unit/absence.test.mjs` is a string production actually produced.

  **Known limits,** recorded in `docs/adr/absence-requires-evidence.md` rather than papered over: a licence is per-run and not per-claim, so one genuinely empty query still entitles every absence sentence in that answer, and narrowing it needs claim-to-query matching that is not reliably decidable from the text; and the detector is a pattern list grown from sentences production actually wrote, so it should keep growing from observed output rather than from imagination, with a negative case beside each addition — "serotonin is not present in these neurons" is a claim about the world and must survive.

## v4.2.1
- Release v4.2.1: A request nobody is waiting for now stops, an MCP result is parsed once instead of five times, and two gates that were documented and tested but never called are wired to the thing that actually knows the answer.

  **Cancellation.** `buildSseResponse` had no `cancel()` handler, `request.signal` was never wired into the harness, the MCP client or the ELM client, and the enqueue-failed branch carried a comment saying there was nothing else to do when the client disconnected. There was: stop. A user who waited forty seconds and hit refresh three times left three complete working sets running to completion — up to 82 controller iterations and 24 MCP rounds each, holding a ledger, its term-info records, its evidence array and every tool payload for the whole run, so four questions in flight could be doing the work of eight. `lib/runSignal.mjs` is one signal per request, aborted by whichever comes first of the client disconnecting, the stream being cancelled, or a deadline; it is checked at the top of every controller iteration and before every tool round, and passed to the ELM fetch so a call already in flight is cancelled rather than merely not started. Verified against a running server rather than assumed: `next start` fires both hooks, and four questions abandoned after six seconds now produce four `RUN ABANDONED` lines and zero completed answers in four and a half minutes, against an answer that takes 90–210 s. An abandoned run is also no longer recorded as a service error, which was writing an `errored=true` governance record and emitting an error event to a client that had already gone.

  **One MCP result was materialised five times, with every copy alive at once** — joined by `mcpResultToText`, `JSON.parse`d by the graph collector, regex-scanned twice for thumbnails, `JSON.parse`d again purely to test one key, `JSON.parse`d a third time by the orchestrator, then stringified back by `asText` and sliced into a second full copy by `chunkText`. At ~20 MB of JSON, which `ListAllAvailableImages` on the medulla reaches at 226k rows, that is three independent V8 object graphs at 5–10× the text size plus ~60 MB of string copies, for one tool call out of 24, all synchronous on the single event loop. It is not a leak; it is 5× amplification of an uncapped payload, and it is the shape of 88 MB → 6.8 GB across four concurrent questions. Parse once, reuse it, and above `MAX_TOOL_RESULT_CHARS` build no object graph at all. Four further things were sized by the payload rather than by what the answer uses: the extract map-reduce split an oversized result into unbounded chunks with one three-minute ELM call each; thumbnails accumulated without a cap while the dedupe `Set` was rebuilt from the whole accumulated array on every tool call, to render eight images; `backfillDigestPreview` mapped every row to keep five; and the reviewed-docs page cache was TTL-checked on read and never deleted.

  **Synchronous disk I/O off the request path.** Every request did two full read-modify-write cycles on the shared event loop — the entire 30-day rate-limit state before any work started, the whole day's analytics bucket at the end — plus five `readdirSync` calls for the retention sweep. Both counters are aggregates and are now buffered with a timed write-through and an exported flush; anything with a legal retention requirement is still appended synchronously. The retention sweep is throttled to hourly while keeping the property its test was written for, that it runs on a long-lived container rather than once at startup. The rate-limit map is bounded, because its key is the leftmost value of `X-Forwarded-For` and a client that forges a fresh one each time both defeated the limit and grew the map.

  **Two gates that were not gates.** `priorTermQueries` is documented as validating a clicked chip's `{id, query_type}` before it runs; it had a unit test and exactly one occurrence in non-test code, its own definition, so a stale or client-authored chip passing two shape regexes went to the MCP, was rejected, and came back as "VFB does not currently hold …" about a term the same answer hyperlinks. It could not have been that gate: the carried context is truncated, so absence from it is not evidence. Chip steps are now marked `via_chip` and reconciled against VFB's own catalogue after resolution, with the type lift getting first refusal. And the clarify branch returned the model's text raw with `blockedResponseDomains: []` hard-coded, while every other exit went through five sanitisers.

  **Also:** MCP sessions leaked one per extra concurrent name, because `getMcpClientForContext` was check-then-await-then-set and `resolveTerms` fans out with `Promise.all`; the force-refresh allowance documented as two recomputes per request was passed by one of its 27 call sites, so a single reciprocal-connectivity call could fire seven; `/api/feedback` had no rate limit and no authentication despite appending up to 100 KB of transcript to a 30-day store; a fetched documentation page was concatenated into the prompt with no boundary, and a fenced block was lifted verbatim as something to copy, which is right for a configuration and wrong for a shell command. The unreachable `stop` action is gone, and so is the static lookup cache whose 1,500 compiled RegExps ran over every question and were thrown away unread.

  1150 unit tests, no failures.

## v3.9.1
- Release v3.9.1: Remove the dead tool-output compression path. Before resource handles existed, an oversized relay payload was truncated at `VFB_TOOL_OUTPUT_TRUNCATE_CHARS` and, past a total trigger, split into chunks for a summarisation pass — `truncateToolOutput`, `shouldCompressToolOutputs`, `buildToolOutputCompressionChunks` and `getRelayToolOutput`, tuned by five environment variables. The `data_resource` threshold introduced later intercepts every payload large enough to reach that path, so nothing has called any of the four functions for several releases; `getRelayToolOutput` read an `item.relayOutput` field that no code anywhere writes, which makes the whole relay-output concept vestigial. Dead code of this shape is worse than merely unused: it advertises a safety net that is not there. A reader of `route.js` — or of a deployment's environment — would reasonably conclude that oversized outputs are still truncated as a second line of defence, and would size `DATA_RESOURCE_INLINE_MAX_CHARS` accordingly. They are not: the resource threshold is the only thing standing between a large tool result and the prompt, and anything that survives it is sent whole. 100 lines removed from one file, no behaviour change, no test change (701/701 still green), and `docs/tool-result-resource-strategy.md` now says so explicitly rather than describing the removed path. The five variables — `VFB_TOOL_OUTPUT_TRUNCATE_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_TOTAL_TRIGGER_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_CHUNK_CHARS`, `VFB_TOOL_OUTPUT_COMPRESSION_MAX_INPUT_CHARS` and `VFB_DISABLE_TOOL_RESULT_COMPRESSION` — are no longer read and can be deleted from any deployment that still sets them. `stringifyToolOutput` is deliberately kept: it is live in the resource-storage decision.

## v3.9.0
- Release v3.9.0: The shelf is now acted on rather than read out, and a lookup that was abandoned no longer poses as a lookup that came back empty. 3.8.0 built a correct catalogue of every query each resolved term advertises; the twenty workshop questions then showed four distinct ways of misusing it. (A) Relevance was lexical — a query matched the question when their words overlapped, so "what are the main synaptic partners" scored no higher on a connectivity query than on an image query. `lib/queryTypes.mjs` now declares the KIND of question each query type answers and `lib/queryRelevance.mjs` scores on kind intersection, with kinds the question explicitly excludes scoring negative. (B) The shelf was narrated instead of used: answers ended "VFB also holds 92 transgene expression records, but this query has not been run yet", which reports on the harness rather than on the fly. The synthesis rules now say plainly that an unrun query is a thing to RUN, not a thing to mention, and `lib/harnessFraming.mjs` strips the residue deterministically when the model says it anyway. (C) An empty shelf gave no prohibition at all — when nothing resolved, `renderShelf` returned an empty string and the absence rules went with it, which is precisely the case that most needs them; there is now an unconditional no-coverage floor, ignorance counts as insufficiency rather than sufficiency, and the two fast paths that were hijacking multi-step and connectivity questions are vetoed. (D) One question errored after 300 s with 181 s spent inside term resolution before any data query ran: a 30 s timeout is classified transient, so each retry was granted another full 30 s and the retry count became a silent latency multiplier (30 + 2 + 30 + 3 + 30 ≈ 95 s per lookup, twice per name). `lib/callBudget.mjs` states the allowance ONCE as a total for the whole attempt sequence — every attempt and every backoff draws from it, so a retry that only fits in 12 s is given 12 s rather than 30 — and the resolve ladder gets a per-name wall-clock deadline that abandons its speculative rungs (spelling variants, the dataset-index sweep) while never touching the rungs the answer is made of. Worst case falls from ~181 s to ~90 s and is now bounded rather than emergent. Crucially, an abandoned lookup is recorded as abandoned: it is reported to the synthesiser as "the lookup did not complete", never as "VFB's search returned nothing", because the wordings that were skipped are exactly the ones that would have matched.

## v3.8.0
- Release v3.8.0: Coverage is now tracked per QUERY, not per term. 3.7.0 forbade an absence about anything the AVAILABLE VFB DATA block listed, but the block itself was withheld the moment any planned step produced evidence — so one query running took the prohibition down with it, and eight of twenty workshop answers still denied records VFB was holding. The unit was wrong in two places: the synthesis gate suppressed the whole catalogue on the first answered step, and the sufficiency pre-filter counted a term as covered once one of its five queries had run. A new `lib/coverage.mjs` builds a shelf of every query every resolved term advertises and sorts each into one of four states — RUN (answer from evidence), EMPTY (the only state that licenses an absence), FAILED (a lookup that fell over, which licenses nothing but keeps its counts) and UNRUN (held, never asked, and forbidden to deny). The block that used to do two jobs at once now does them separately: the prohibition is unconditional and complete, while the licence to name a follow-up query is scoped to a WORTH SAYING list of at most two queries the question actually asked for that nothing already run covers — which fixes the catalogue-as-a-tail padding the old suppression was hacked in to stop, rather than hiding the list to avoid it. Relevance scoring moves to `lib/queryRelevance.mjs` so the shelf can be ranked and capped by what the question asked rather than by the order VFB returned. Also: the catalogue is now gated on the QUESTION (a definitional question has no absence to guard), definitively-empty query results are recorded as such rather than as failures, and a new synthesis rule stops the model handing back a `vfb.terms([...])` snippet in place of the result it was asked for.

## v3.7.0
- Release v3.7.0: Absence in an answer now requires a lookup that actually happened. Seven of twenty workshop questions were answered "VFB does not currently hold data on X" about terms whose own digests advertised exactly X, with the query sitting available and un-run — nothing distinguished QUERIED AND EMPTY from NEVER QUERIED. Three layers: the synthesis absence gate now keys on a query having run and come back empty, and the AVAILABLE VFB DATA block states its queries are unrun and forbids an absence about anything it covers; a new ledger-level sufficiency check runs before synthesis, asking which of the un-run queries would answer the question and injecting it (one shot, deterministically pre-filtered, on the ledger rather than the streamed prose so it can still re-plan); and three deterministic injectors were widened to reach a region asked a connectivity question, a counted query asked for its members, and a question resolving two terms.

## v3.3.0
- Release v3.3.0: Reviewed-docs search plane — run an approved-domain documentation search in parallel to supplement every answer, with page citations in Sources; scRNA-seq gene-expression rendered as deterministic gene x subtype tables; published neuron-count estimates surfaced with their citation; role-harness reliability work — deterministic connectivity-graph routing for neuron types, intent-scoped guidance cards, answer-grounding guards, and more robust token-superset term resolution; route dataset-listing questions to vfb_list_connectome_datasets; split VFB MCP timeouts by call weight; thumbnail link/label fixes; and VFB3-MCP 1.9.1 compatibility (run_query paging/image controls, FlyBase stock/combination-publication query_types, parallel population).

## v3.2.4
- Release v3.2.4: Fix zero-count VFB query links and include the latest merged 5point5Review changes.

## v3.2.3
- Release v3.2.3: Recover with partial answers or clarifying follow-ups after upstream stream failures when tool evidence already exists, prioritize gene-expression classification over connectivity for analytics, and bias broad transgene-expression requests toward short representative lists

## v3.2.2
- Release v3.2.2: Restore production compatibility when explicit approved ELM values are not configured, add partial-summary and clarification fallbacks for broad tool-heavy queries, raise the tool-round budget to 10, and add named example asset generation

## v3.2.1
- Release v3.2.1: Expand approved site search beyond a hand-maintained VFB page list by adding wider sitemap-backed reviewed search, approved page extraction, and NeuroFly domain allow-list support

## v3.2.0
- Release v3.2.0: Add governance-ready logging with `/logs` volume support, reviewed-domain search controls, outbound link allow-listing, structured feedback, privacy updates, and opt-in transcript attachments for problem reports

## v3.1.0
- Release v3.1.0: Add per-IP daily rate limiting and rate-info endpoint; backend data storage in data/rate-limits.json; client-side usage counter in UI

## v3.0.3
- Release v3.0.3: Fix thumbnail handling by avoiding ID linkification inside existing URLs

## v3.0.2
- Release v3.0.2: Improve linked ID display by using preferred labels (e.g., “ME on JRC2018Unisex” instead of raw ID)

## v3.0.1
- Release v3.0.1: Add VFB report link generation and improved term linking

## v3.0.0
- Release v3.0.0

## v2.2.23
- Add retry logic and sanitize API error responses

## v2.2.22
- Bump version to 2.2.22

## v2.2.21
- Refactor message rendering with memoization and unique message IDs

## v2.2.20
- Bump version to 2.2.20

## v2.2.19
- Bump version to 2.2.19

## v2.2.18
- v2.2.18: Add interactive suggested questions from gpt-5-nano responses

## v2.2.17
- Release 2.2.17: Fix dataset search filtering

## v2.2.16
- Fix runtime error: add missing conversationMessages variable definition

## v2.2.15
- Release v2.2.15: Fix complex term information retrieval

## v2.2.14
- Release v2.2.14: VFB_connect-style lookup methodology

## v2.2.13
- Update release notes for v2.2.13

## v2.2.12
- Release v2.2.12: Add thumbnail URL validation

## v2.2.11
- Release 2.2.11: Fix critical tool call processing bug

## v2.2.10
- Release 2.2.10: Add table rendering and improve connectivity query guidance

## v2.2.9
- Release v2.2.9: Query optimization and hallucination prevention

## v2.2.8
- Release v2.2.8: FlyBase Link Fix

## v2.2.7
- Release v2.2.7: Image Display Fix

## v2.2.6
- Release v2.2.6: Context Fix

## v2.2.5
- Release v2.2.5: Precise VFB data structure logic for thumbnails

## v2.2.4
- Release v2.2.4: Improve thumbnail selection with Images vs Examples handling

## v2.2.3
- Release v2.2.3: Fix AI hallucinating thumbnail URLs

## v2.2.2
- Release v2.2.2: Improve paper citation formatting

## v2.2.1
- Release v2.2.1: Fix thumbnail URL display issue

## v2.2.0
- Bump version to 2.2.0 for analytics and AI guidelines release

## v2.1.1
- Release v2.1.1: Add jailbreak detection and security features

## v2.1.0
- feat: add image thumbnails, guardrails, and fix nested link corruption

## v2.0.1
- fix: improve UI layout, markdown rendering, and term link replacement

## v2.0.0
- feat: migrate LLM backend from Ollama to OpenAI API

## v1.1.2
- Bump version to 1.1.2

## v1.1.1
- Release v1.1.1: Fix MCP session issues with official SDK

## v1.1.0
- Bump version to 1.1.0 - Added MCP SDK session management

## v1.0.5
- Enhance status message feedback for MCP operations

## v1.0.4
- Fix syntax errors causing Docker build failures

## v1.0.3
- Update system prompt with VFB LLM guidance and improve MCP error handling

## v1.0.2
- Fix MCP server integration and improve error handling

## v1.0.1
- Dark mode implementation for VFB branding
