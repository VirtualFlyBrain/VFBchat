# Absence requires evidence

Status: accepted
Date: 2026-08-10

## Context

`lib/coverage.mjs` has stated the rule since the four-state model was
introduced: of RUN, EMPTY, FAILED and UNRUN, only EMPTY licenses an absence.
The synthesis prompt repeats it three times in capitals.

Measured against production v4.2.1 — thirteen questions, three repetitions each,
answers judged blind — **fourteen of thirty-nine answers asserted that VFB holds
nothing, and not one of them had a query behind it that had run and come back
empty.** Three of those denials were about `γ Kenyon cells`, `α/β Kenyon cells`
and `MBON-γ1pedc>α/β`, which are FBbt_00100247, FBbt_00100248 and
FBbt_00100246 — classes the ontology has held for years.

An instruction violated at that rate is not a control. This is the same lesson
the project already learned for counts, where the answer was not a firmer
instruction but `repairMistranscribedCounts`: state the rule, then enforce it
deterministically after the model has had its say.

## Decision

Three layers, in the order they should bite.

**1. Make the name findable.** `lib/nameNormalise.mjs` transliterates Greek
letters to the spellings FlyBase and FBbt actually store, and normalises primes,
arrows, dashes and non-breaking spaces. It is the first rung of `nameVariants`,
and only when there is something to transliterate — an ASCII name still pays
exactly one extra search for its plural, as before.

**2. Go and look before conceding.** If the drafted answer claims an absence and
nothing came back empty, `maybeEscalateBeforeAbsence` injects the failed and the
most relevant unrun queries and writes the answer again. Failed queries go
first: a lookup that fell over is the one case with positive evidence that the
absence is an artefact.

**3. Do not ship what was not earned.** `gateAbsence` removes absence claims the
ledger does not license. It is the floor, not the fix — by the time it fires,
escalation has already had its chance.

`renderShelf` also gained a NAMES THAT DID NOT MATCH block, for the
half-resolved question: one term matches, another does not, the shelf is
non-empty so the no-coverage floor never fires, and nothing in the prompt
distinguished "never looked at" from "checked and found wanting".

## Consequences

The absence rate went from 14/39 to 1/39 on the same questions, with no errors
and a median cost of 66 s → 77 s. The full 64-task battery stays at 64/64.

Three deliberate costs, recorded because each one is a place a future reader may
reasonably disagree:

- **Relevance orders escalation attempts; it does not veto them.** "Are any
  mushroom body output neurons cholinergic?" scores every query the class
  advertises at zero, because no label contains the word "cholinergic" — while
  `SubClasses`, scoring zero, is the query that answers it. Filtering here would
  escalate nothing in the case the guard exists for.

- **A query the escalation chose cannot license the claim it was chosen to
  check.** An early version ran `ListAllAvailableImages` for a question about
  hemisphere symmetry, got an empty, and licensed the symmetry denial with it.
  The guard was manufacturing its own permission, which is worse than the bug it
  replaces. So a run where escalation genuinely proves an absence now hedges it
  rather than stating it flatly. Hedging a true absence is a worse answer;
  asserting a false one is a wrong answer.

- **Escalation stops at `ABSENCE_ESCALATION_DEADLINE_MS` (120 s, env-tunable).**
  It buys a second synthesis costing 60–90 s, and one started too late takes the
  first answer down with it — which it did, once, on the first CI run of this
  branch. A false absence is worse than a hedge; it is not worse than no answer.

## Known limits

- A licence is per-RUN, not per-claim: one genuinely empty query entitles every
  absence sentence in that answer. Narrowing it to the subject of each sentence
  needs claim-to-query matching, which is not reliably decidable from the text.
- The detector is a pattern list built from sentences production actually wrote.
  It will miss constructions nobody has written yet. Add them from observed
  output rather than by imagination, and keep a negative case beside each one —
  "serotonin is not present in these neurons" is a claim about the world and
  must survive.
- `T3.8` runs at 190–205 s against the workflow's `TASK_BATTERY_TIMEOUT_MS` of
  240 s and has been marginal for several releases. It is unrelated to this
  change and wants that ceiling raised to 360000.
