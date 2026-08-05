// Wall-clock accounting: what a slow lookup is allowed to cost before the
// caller has to be told something instead of waited at.
//
// THE MEASURED FAILURE
//
// W9.2 — "What images does VFB have for the DA1 lPN neuron type?" — returned an
// error after 300 seconds. 181 of those were spent inside the RESOLVE step,
// before a single data query ran, and none of them were spent computing
// anything. They were spent waiting, repeatedly, on a tool that had already
// demonstrated it was not going to answer.
//
// The number is entirely predictable from the constants. A fast tool gets a 30 s
// per-call timeout and 2 retries, and a timeout counts as a TRANSIENT error — so
// it is retried, and the retry is granted the SAME full 30 s:
//
//     30 s attempt + ~2 s backoff
//   + 30 s attempt + ~3 s backoff
//   + 30 s attempt
//   ≈ 95 s for ONE fast lookup
//
// and the resolve ladder makes two such calls in sequence for a single name.
// ~181 s, reproducible, with no failure anywhere except patience.
//
// WHERE THE OLD RULE WENT WRONG
//
// The rule it was built on reads: "the per-call timeout is NOT shortened — a
// slow-but-responding call is allowed to finish, since cutting it off early just
// wastes the work already in flight." That is correct, and it is correct about
// the FIRST attempt. It is wrong about the second, because by then the first
// attempt is EVIDENCE: this call did not come back inside 30 s, so granting it
// another 30 s is not patience, it is repetition. Retrying a dropped connection
// is a bet that the network was unlucky. Retrying a timeout on the same
// allowance is a bet that the server is about to be three times faster than it
// just was, and nothing observed supports that bet.
//
// THE RULE THAT REPLACES IT
//
// State the budget ONCE, as a total for the whole attempt sequence, and make
// every attempt and every backoff draw from the same total. Three consequences,
// all wanted:
//
//   - A failing call costs its budget, not a multiple of it. The retry count
//     stops being a latency multiplier and goes back to being what it reads as:
//     how many times we are willing to try.
//   - The retry that only fits in the remaining 12 s is GIVEN 12 s, not 30. That
//     is the honest amount of time left, and a shorter attempt that fails inside
//     the budget is strictly better than a longer one that blows it.
//   - Sleeping is charged too. A backoff is only worth its cost if an attempt
//     can still fit behind it; when it cannot, there is nothing to wait for.
//
// Everything here is pure arithmetic over an injected clock so it can be tested
// without a network or a timer.

// Below this, an attempt is not worth starting: the round trip alone would spend
// it, so the only thing a sub-floor attempt reliably produces is a later
// failure than the one already in hand.
export const ATTEMPT_FLOOR_MS = 2000

/** Growing linear backoff, unchanged from the behaviour this replaces. */
export function backoffMs(attempt) {
  return 1000 * (Math.max(0, attempt) + 1)
}

/**
 * Time left in a total budget. A missing or non-positive total means "no
 * ceiling" and yields Infinity, so every caller below degrades to the old
 * unbounded behaviour rather than to a zero budget — an accounting bug must not
 * be able to turn every call off.
 */
export function remainingMs(totalMs, elapsedMs) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) return Infinity
  return totalMs - (Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0)
}

/**
 * Whether there should be another attempt, how long to wait first, and how long
 * that attempt may take.
 *
 * Returns {retry:false, reason} or {retry:true, reason:'retry', waitMs, timeoutMs}.
 * The reasons are distinct on purpose — 'permanent', 'retries-exhausted' and
 * 'budget-spent' are three different things to put in a log line, and a stall
 * that is really a budget exhaustion should never be read later as a server
 * that refused three times.
 */
export function planNextAttempt({
  attempt = 0,
  retries = 0,
  transient = false,
  perAttemptMs = 0,
  totalMs = 0,
  elapsedMs = 0,
  jitterMs = 0
} = {}) {
  if (!transient) return { retry: false, reason: 'permanent' }
  if (attempt >= retries) return { retry: false, reason: 'retries-exhausted' }

  const left = remainingMs(totalMs, elapsedMs)
  if (left !== Infinity && left < ATTEMPT_FLOOR_MS) return { retry: false, reason: 'budget-spent' }

  // Jitter keeps concurrent requests from retrying in lockstep; it is part of
  // the wait, so it is part of what the wait is charged for.
  const wanted = backoffMs(attempt) + Math.max(0, jitterMs)
  // Never sleep away the last of the budget: reserve the floor so whatever is
  // waited for can actually be attempted.
  const waitMs = left === Infinity ? wanted : Math.max(0, Math.min(wanted, left - ATTEMPT_FLOOR_MS))
  const timeoutMs = left === Infinity ? perAttemptMs : Math.min(perAttemptMs, left - waitMs)

  if (!(timeoutMs >= ATTEMPT_FLOOR_MS)) return { retry: false, reason: 'budget-spent' }
  return { retry: true, reason: 'retry', waitMs, timeoutMs }
}

/**
 * A wall-clock allowance an ordered sequence of OPTIONAL work can consult.
 *
 * The resolve ladder is the caller this exists for. Its steps are not equal: the
 * first search and the term-info fetch are what the answer is made of, while the
 * spelling variants and the dataset-index sweep are extra chances at a name that
 * has not matched yet. Extra chances are worth taking when they are cheap and
 * are exactly what must go when they are not — so the ladder asks this before
 * each optional step and simply stops descending when the answer is no.
 *
 * `now` is injected so tests can advance time without spending any.
 */
export function createDeadline(totalMs, now = () => Date.now()) {
  const startedAt = now()
  const spent = () => Math.max(0, now() - startedAt)
  return {
    totalMs,
    startedAt,
    spent,
    remaining: () => remainingMs(totalMs, spent()),
    /**
     * True when there is not enough left to be worth starting something. The
     * floor is a parameter because "worth starting" depends on what is being
     * started: a cached index read is worth a shorter runway than a network
     * search.
     */
    expired: (floorMs = ATTEMPT_FLOOR_MS) => remainingMs(totalMs, spent()) < floorMs
  }
}

/**
 * Parse an integer from the environment, clamped, with a fallback. Local copy
 * rather than an import so this module stays dependency-free and testable in
 * isolation; the route has its own for the same reason.
 */
export function envInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
