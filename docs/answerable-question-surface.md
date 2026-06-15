# VFBchat answerable-question surface

What kinds of question the chat can answer, and from which data source. There are
two distinct planes:

- **Plane A — the VFB ontology + connectomics database** (the VFB MCP). The
  neuroanatomy/connectome data: terms, classification, connectivity, expression,
  images, stocks, scRNA-seq, similarity.
- **Plane B — the reviewed-docs site search** (`search_reviewed_docs` /
  `get_reviewed_page`). Documentation, how-to, concepts, provenance, API usage,
  news/releases, events, hosted sites, citation/funding, anatomy diagrams. This
  is content on `virtualflybrain.org`, `vfb-connect.readthedocs.io` and
  `neurofly.org`, indexed from their sitemaps (plus a curated seed index).

Since v3.2.x the reviewed-docs search runs **in parallel** with the VFB work on
every answerable query and folds a relevant top hit into the answer (relevance
pre-gate on the title/URL, plus the extract's relevant/answered gate), so plane-B
content supplements any answer rather than only keyword-detected ones. The page
used is listed under **Sources** with its title and link.

Source of truth for plane-B content: the site repo at `VirtualFlyBrain/VFB2`
(`content/en/{docs,blog,about,hosted}`).

---

## Plane A — ontology + connectomics database

| Category | Example question |
|---|---|
| Term definition / anatomy | What is the ellipsoid body? |
| Classification / subtypes | What types of Kenyon cells exist? |
| Parts / containment | What are the parts of the central complex? |
| Class connectivity (+ graph) | What does the giant fiber neuron connect to downstream? |
| Region inputs / outputs | Which neurons receive output from the fan-shaped body? |
| Neurotransmitter | What neurotransmitter do Kenyon cells use? |
| Expression / drivers | What GAL4 lines label the mushroom body? |
| Fly stocks | What stocks are available for a given line? |
| Images / templates | Show me images of MBON12. |
| scRNA-seq gene expression | Which dopamine receptor genes do Kenyon cells express? |
| Morphological similarity (NBLAST) | Find neurons similar to a given neuron. |
| Neuron / annotation counts | How many neurons are annotated in the central complex? |

This plane is covered by the existing tier 1–4 (and G1) tasks in
`tests/task-battery/tasks.json`.

---

## Plane B — reviewed-docs site search

One representative question per category (these are the `D#` tasks, tier 6, in
`tests/task-battery/tasks.json`). The "Source pages" column points at the section
of the VFB2 content that answers it.

| # | Category | Example question | Source pages |
|---|---|---|---|
| D1 | Project identity | What is Virtual Fly Brain and who is it for? | `about/whatisvfb`, `about/_index` |
| D2 | Citation | How should I cite Virtual Fly Brain in a publication? | `about/citeus` |
| D3 | Funding | Who funds Virtual Fly Brain and since when? | `about/funding` |
| D4 | Policies / accessibility | What is VFB's accessibility statement? | `about/accessibility`, `about/privacy`, `about/cookies` |
| D5 | Contact / contribute | How do I report a problem or contribute data to VFB? | `about/contactus`, `docs/Contribution guidelines` |
| D6 | Website how-to: 3D Viewer | How do I use the 3D Viewer on the VFB website? | `docs/Website Features/3dviewer` |
| D7 | Website how-to: Circuit Browser | What is the Circuit Browser tab and how do I use it? | `docs/Website Features/circuitbrowser` |
| D8 | Concepts: NBLAST | What is NBLAST and what does a similarity score mean? | `docs/Concepts/nblast` |
| D9 | Concepts: confidence values | What do confidence values mean on VFB? | `docs/Concepts/confidence-value` |
| D10 | Concepts: bridging registrations | What are bridging registrations between templates? | `docs/Concepts/bridging` |
| D11 | Data coverage & templates | What imaging data types and templates does VFB hold? | `docs/Data/{EM,LM,scRNAseq}`, `docs/Data/templates` |
| D12 | Release changelog | What was in the latest VFB release? | `blog/releases`, `blog/news` |
| D13 | API: VFB-connect (Python) | How do I install and get started with VFB-connect? | `vfb-connect.readthedocs.io`, `docs/Tutorials/APIs` |
| D14 | API: REST endpoints | How can I query VFB via the SOLR or Owlery API? | `docs/APIs/{SOLR,Owlery,PDB,KB}` |
| D15 | API: integrations | How do I explore VFB neurons using Navis or pymaid? | `docs/Tutorials/APIs/{navis,pymaid,neuprint}` |
| D16 | MCP tool usage | How do I use the VFB MCP tool? | `docs/Tutorials/vfb-mcp-guide` |
| D17 | News / operational | When did predicted neurotransmitters for EM data arrive? | `blog/news` |
| D18 | Community events | When and where is the NeuroFly 2026 conference? | `blog/news/neurofly-2026`, `neurofly.org` |
| D19 | Workshops / training | What's in the "Hacking the connectome" workshop? | `docs/past workshops/Connectome` |
| D20 | Hosted / archived sites | Where can I access the FAFB or FANC CATMAID datasets? | `hosted/` |
| D21 | Anatomy teaching diagrams | Is there a mushroom body circuit diagram on VFB? | `docs/Anatomy Diagrams` |

---

## Running the battery

```
node scripts/run-task-battery.mjs --tier 6        # plane B (documentation) only
node scripts/run-task-battery.mjs --tasks D18,D8  # specific cases
```

A plane-B task passes when the answer draws on the reviewed-docs content (correct,
grounded, and ideally with the page linked under Sources). It should NOT abstain
with "VFB does not currently hold data on …" for content that lives on the site.

### What "good" looks like
- The answer reflects the page content (e.g. NeuroFly 2026 → 7–11 September 2026,
  University of Cologne).
- The page is listed under **Sources** with its title and link.
- Plane-A questions are unaffected: the parallel doc-search must not intrude on a
  pure anatomy answer (relevance gate → no irrelevant page fetched, no doc source).
