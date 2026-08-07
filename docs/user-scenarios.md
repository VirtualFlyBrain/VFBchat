# VFBchat user scenarios

Fifty things a real person walks up to the chat and asks, grouped by the kind of
person asking, each marked with what the system actually does with it today.

This is a companion to `answerable-question-surface.md`. That document is a map
of what the tools *can* retrieve; this one is a map of what a *question* meets
when it arrives. The difference matters, because most of the interesting defects
live in the gap between them: the data is in VFB, the tool exists, and the
question still comes back thin because nothing routes the one to the other.

The catalogue is deliberately written as verbatim questions, in the register
people use — including the vague ones ("Tell me about the LNs"), the ones that
assume prior turns ("Now show me only the ones in the hemibrain") and the ones
that are about VFB rather than about flies ("My workshop query returned nothing
— why?"). A question a user would not type is not evidence of anything.

**Verdicts.** `WORKS` means the current build answers it well. `PARTIAL` means it
answers, but incompletely or with a caveat worth naming. `GAP#k` means it is
blocked by ranked capability gap *k* below. Entries marked *(fixed in 4.1.0)*
were `PARTIAL` before this release.

---

## Personas

**P1 — Bench fly neuroscientist.** A circuit/behaviour lab researcher who came
for a reagent she can order, a circuit she can perturb, and a number she can put
in a figure.

**P2 — Connectomics analyst.** A hemibrain/FlyWire/MANC power user who came for
exact partner lists, synapse weights, body-ID resolution and cross-dataset
reconciliation.

**P3 — Student / newcomer.** Someone with vague vocabulary and half-remembered
names who came to find out what things are, what they do, and where to start.

**P4 — Workshop attendee.** A time-boxed trainee following an exercise, whose
questions are as often about VFB the tool as about flies.

**P5 — Data curator / ontology maintainer.** A maintainer who asks inverted
questions — what is missing, what is inconsistent, what changed, and where a
figure came from.

---

## The catalogue

### Identity and orientation

| # | Persona | Question | Verdict |
|---|---|---|---|
| S1 | P3 | What is the ellipsoid body? | WORKS |
| S2 | P3 | What can VFB tell me about LPLC2? | WORKS *(fixed in 4.1.0 — chips now cover 33 query types, so the shelf and the chips agree)* |
| S3 | P3 | Tell me about the LNs | PARTIAL — candidates listed in prose, no clickable picker |
| S4 | P5 | MB-V2 — is that MBON-α2sc now? | PARTIAL — superseded data carried, no nomenclature mapping |
| S5 | P2 | What cell type is FlyWire 720575940630066007? | WORKS |
| S38 | P1 | Does VFB have any data on the ocellar ganglion? | WORKS |
| S44 | P1 | Give me a comprehensive profile of the giant fiber neuron | WORKS |
| S50 | P4 | What kinds of question can you answer? | PARTIAL — scope note hand-written, not derived from tools |

### Comparison

| # | Persona | Question | Verdict |
|---|---|---|---|
| S6 | P1 | How do α/β and γ Kenyon cells differ? | GAP#2 |
| S7 | P3 | How is the medulla different from the lobula? | GAP#2 |
| S8 | P1 | How does the antennal lobe compare between adult and larval flies? | WORKS |
| S9 | P2 | Is DA1 lPN connectivity the same in hemibrain and FlyWire? | PARTIAL — evidence packet, not a quantitative diff |
| S10 | P3 | What's the mammalian analogue of the mushroom body? | PARTIAL — out-of-scope refusal reads as lookup failure |
| S35 | P3 | Does this cell type exist in the larva? | PARTIAL — stage scoping only for region comparison |

### Counting

| # | Persona | Question | Verdict |
|---|---|---|---|
| S11 | P1 | How many neurons are in the adult central brain? | WORKS |
| S12 | P1 | How many Kenyon cells are there? | PARTIAL — count regex misses cell-type nouns |
| S13 | P2 | How many DA1 lPN neurons does VFB hold in each connectome dataset? | WORKS |
| S14 | P2 | How many MBONs are cholinergic? | GAP#4 |

### Connectivity

| # | Persona | Question | Verdict |
|---|---|---|---|
| S15 | P2 | What does MBON-γ1pedc>α/β connect to downstream? | WORKS |
| S16 | P1 | Which neurons provide input to the mushroom body? | WORKS |
| S17 | P2 | How strongly do γ Kenyon cells connect to MBON-γ1pedc>α/β? | PARTIAL — no deterministic two-endpoint router |
| S18 | P2 | Trace a pathway from ORNs to the lateral horn — what's in between? | GAP#1 |
| S19 | P2 | Which MBON–DAN pairs have the strongest mutual connectivity? | PARTIAL — no joined, ranked bidirectional weight table |
| S20 | P2 | Do α/β and γ Kenyon cells converge on the same MBONs? | WORKS |
| S21 | P2 | Is there a feedback loop from MBONs back onto Kenyon cells? | GAP#1 |
| S22 | P2 | Where does DA1 lPN make its output synapses, by region? | WORKS *(fixed in 4.1.0 — region connectivity now has a follow-on chip)* |
| S23 | P2 | Is DA1 lPN connectivity symmetric between left and right? | PARTIAL — no laterality facet on individuals |
| S43 | P1 | I want to study CO₂ avoidance — what neurons, how connected, what tools can I use? | GAP#1 |

### Reagents, genes and expression

| # | Persona | Question | Verdict |
|---|---|---|---|
| S24 | P1 | What split-GAL4 lines label lateral horn neurons? | WORKS |
| S25 | P1 | I need a clean split-GAL4 for MBON-α3 with minimal off-target expression | GAP#4 |
| S26 | P1 | Which neurons express Dop1R1? | GAP#5 |
| S27 | P1 | Which dopamine receptor genes do Kenyon cells express? | WORKS |
| S28 | P1 | What neurotransmitter do mushroom body Kenyon cells use? | WORKS |

### Images, datasets and morphology

| # | Persona | Question | Verdict |
|---|---|---|---|
| S29 | P3 | Show me what LPLC2 looks like in 3D | WORKS *(fixed in 4.1.0 — image queries now carry chips)* |
| S30 | P2 | What connectome datasets does VFB have? | WORKS *(fixed in 4.1.0 — dataset queries now carry chips)* |
| S31 | P4 | Can I bridge my JFRC2 stack onto JRC2018U? | PARTIAL — concept explained, no registration-chain check |
| S32 | P2 | What neurons are morphologically similar to LPLC2? | WORKS *(fixed in 4.1.0 — similarity queries now carry chips)* |
| S33 | P2 | I have a traced SWC skeleton — what's the closest VFB neuron? | PARTIAL — no upload path; redirect to natverse only |
| S34 | P1 | Which neurons come from the ALad1 lineage? | WORKS *(fixed in 4.1.0 — lineage/clone queries now carry chips)* |

### Provenance, literature and curation

| # | Persona | Question | Verdict |
|---|---|---|---|
| S36 | P1 | What papers describe the PPL1 dopaminergic neurons and aversive memory? | GAP#6 |
| S37 | P2 | You said 226,524 — what query is that from? | PARTIAL — figure provenance not carried across turns |
| S46 | P5 | Which MBON types have no image in VFB? | GAP#4 |
| S47 | P5 | What was included in the latest VFB release? | PARTIAL — release notes not joined to the term asked about |
| S48 | P5 | This definition is wrong — how do I report it? | WORKS |

### Continuing a conversation, and using the answer afterwards

| # | Persona | Question | Verdict |
|---|---|---|---|
| S39 | P4 | Now show me only the ones in the hemibrain | PARTIAL — result rows not retained for filtering |
| S40 | P3 | Explain the mushroom body circuit to me like I'm new to flies | PARTIAL — pedagogy ungrounded, carries no citations |
| S41 | P2 | How do I get this same list in VFB-connect? | WORKS *(fixed in 4.1.0 — Python reproduction now emitted)* |
| S42 | P4 | My workshop query returned nothing — why? | PARTIAL — no diagnostic explanation of empty results |
| S45 | P3 | What does the ellipsoid body do? | PARTIAL — function claims often ungrounded, unmarked |

---

## Ranked capability gaps

Ranked by how many scenarios each one unblocks, weighted by how badly the
scenario currently fails. Two were closed in 4.1.0 and are kept in place, struck
through in substance if not in numbering, so the ranking stays comparable across
releases.

1. **Graph traversal.** `vfb_find_pathway_evidence` returns plausibility evidence
   rather than paths. A bounded BFS returning ranked paths with per-edge weights
   would unlock multi-hop tracing, shortest paths, motif and loop detection, and
   experimental circuit design.

2. **Single-term router gate.** Four of six deterministic routers bail unless
   exactly one term resolves. Relaxing that to one-term-per-side, plus a generic
   compare tool, would unlock the entire two-entity comparison family — the
   single largest block of `GAP` verdicts above.

3. **Follow-on chip vocabulary.** *Resolved in 4.1.0.* Chips now cover 33 query
   types plus a grounded fallback that quotes VFB's own catalogue label, so
   image, dataset, scRNA-seq, similarity, lineage, stock, publication and
   region-connectivity axes no longer dead-end. Previously an untemplated query
   type was dropped rather than shown differently, which is why a neuron page
   advertising 107 NBLAST matches and 484 connected neurons offered neither.

4. **Class-list filtering.** Nothing joins a class list against a per-member
   attribute, or against its absence. A `vfb_filter_class_list(parent,
   attribute)` supporting negation would unlock filtered counts, driver
   specificity ranking, curator absence audits and batch lookup.

5. **Gene-keyed entry.** Every expression tool takes a neuron type as input.
   Accepting an FBgn and returning cell types would unlock the reverse
   expression question, which is how a molecular biologist actually arrives.

6. **Term → publications.** Literature reaches answers only as a side effect of
   two macros. A general `vfb_find_publications(term)` returning DOI/PMID would
   unlock literature lookup, richer profiles, and grounding for function claims.

7. **Export and code handoff.** *Resolved in 4.1.0.* Answers now carry the ids
   they resolved and the catalogue queries they ran as runnable VFBquery Python,
   turning a chat result into a working artefact. This also closes the loop
   between the chat route and the Python route, which is the workshop's whole
   three-ways premise, and removes a real correctness trap: a user who retypes a
   term name into Python re-runs the disambiguation the chat already did, on a
   different search stack, and can silently land on a different term.

8. **Disambiguation chips.** The resolver already computes candidate sets and
   correctly refuses to pick, but has no `kind:'disambiguate'` chip, so an
   ambiguous name dead-ends in prose. Adding one would make it resolvable in a
   click. Deferred from 4.1.0 deliberately: candidate ids are discarded during
   resolution, so this touches the orchestrator, the follow-on builder, the
   context/focus schema and the route together.

9. **Connectivity default disclosure.** A weight threshold of ≥ 5 and the
   `hb`/`fafb` exclusion are applied silently. Stating them per figure — and
   inverting them for comparison questions, where the threshold is exactly the
   wrong default — fixes both a provenance defect and a wrong answer.

10. **Function grounding.** Claims about what a structure *does* read identically
    to retrieved facts. Sourcing them to curated tables or cited papers, or
    visibly marking them as background, would remove the catalogue's highest
    hallucination risk. Note the interaction with gap 6: the cheapest honest fix
    for "what does the ellipsoid body do?" is a citation, not a hedge.

---

## How to use this document

When a defect report arrives, find the scenario it matches before opening the
code. A `PARTIAL` with a named cause is a known shape, and the note says what is
missing; a question that matches nothing here is new information and worth adding
as a numbered scenario in the same commit as the fix.

The task battery (`tests/task-battery/tasks.json`) is the executable subset of
this catalogue. Not every scenario is worth a live task — some are slow, some are
duplicative — but every scenario whose verdict changes should either gain a task
or explain in review why it did not.
