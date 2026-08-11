// When to stop working on a request nobody is waiting for.
//
// A VFBchat request is expensive: up to 24 MCP rounds and a dozen ELM calls,
// holding its ledger, its term-info records, its evidence array and every tool
// payload for the whole run. None of that was ever cancelled. `buildSseResponse`
// had no `cancel()` handler and `request.signal` was never wired into the
// harness, the MCP client or the ELM client, so a user who waited forty seconds
// and hit refresh three times left three complete working sets running to
// completion — plus the one they were actually waiting for.
//
// That is why observed concurrency is worse than actual concurrency, and it is
// half of why peak RSS goes super-linear: at four questions in flight the
// process can easily be doing the work of eight.
//
// There is also no reason a single run should be able to take an unbounded
// amount of time. The extract map-reduce splits an oversized payload into
// chunks and awaits one ELM call per chunk, each with a three-minute budget and
// no cap on the chunk count, so one step could occupy the gateway for hours.
// A deadline is the backstop for every such loop at once.

/** The default ceiling on one request's wall clock. */
export const DEFAULT_RUN_DEADLINE_MS = (() => {
  const raw = Number(process.env.VFB_RUN_DEADLINE_MS)
  return Number.isFinite(raw) && raw >= 30000 && raw <= 1800000 ? raw : 600000
})()

export class RunAbortedError extends Error {
  constructor (reason = 'aborted') {
    super(`run aborted: ${reason}`)
    this.name = 'RunAbortedError'
    this.reason = reason
  }
}

/**
 * One signal for a request: aborted when the client goes away, when the stream
 * is cancelled, or when the deadline passes — whichever happens first.
 *
 * Returns the signal, an `abort(reason)` for the stream's own cancel handler,
 * and a `dispose()` that clears the deadline timer so a completed request does
 * not hold one until it fires.
 */
export function createRunSignal ({ clientSignal = null, deadlineMs = DEFAULT_RUN_DEADLINE_MS } = {}) {
  const controller = new AbortController()
  let reason = null

  const abort = (why = 'cancelled') => {
    if (controller.signal.aborted) return
    reason = why
    controller.abort(new RunAbortedError(why))
  }

  let timer = null
  if (deadlineMs > 0) {
    timer = setTimeout(() => abort('deadline'), deadlineMs)
    // Do not keep the process alive for a timer whose only job is to give up.
    if (typeof timer.unref === 'function') timer.unref()
  }

  const onClientAbort = () => abort('client-disconnected')
  if (clientSignal) {
    if (clientSignal.aborted) abort('client-disconnected')
    else clientSignal.addEventListener('abort', onClientAbort, { once: true })
  }

  return {
    signal: controller.signal,
    abort,
    reason: () => reason,
    dispose () {
      if (timer) clearTimeout(timer)
      if (clientSignal) clientSignal.removeEventListener('abort', onClientAbort)
    }
  }
}

/** Throw if the run has been abandoned. Cheap enough to call in a loop. */
export function throwIfAborted (signal, where = '') {
  if (signal?.aborted) {
    const reason = signal.reason instanceof RunAbortedError ? signal.reason.reason : 'aborted'
    throw new RunAbortedError(where ? `${reason} (at ${where})` : reason)
  }
}

// Did THIS RUN abort, or did one upstream call time out? The two look almost
// identical at the catch site and mean opposite things, and conflating them hid
// every upstream timeout in production for weeks.
//
// The old predicate ended `|| err?.name === 'AbortError'`, which is true of any
// fetch that times out anywhere — ELM, MCP, PubMed, bioRxiv. app/api/chat/route.js
// treats an aborted run as "the user changed their mind": it logs one line and
// returns WITHOUT emitting an error event and WITHOUT writing a governance
// record. So an upstream timeout closed the stream on a client that was still
// waiting, the browser fell back to its generic error, and the run left no trace
// beyond `RUN ABANDONED` with no category and no upstream named.
//
// It also made the correct handler unreachable: the timeout branch further down
// that catch, with its "the AI service may be under heavy load" message, sat
// below a guard that had already returned.
//
// So: isRunAborted means THIS RUN's signal aborted, and nothing else. An
// AbortError with no aborted signal behind it is an ordinary upstream failure
// and must be reported as one.

/** This run was deliberately stopped — client gone, stream closed, or deadline. */
export const isRunAborted = (err) => err instanceof RunAbortedError || err?.name === 'RunAbortedError'

/** Abort-shaped, from any source. Only meaningful alongside a signal. */
export const isAbortLike = (err) => isRunAborted(err) || err?.name === 'AbortError'

/**
 * True when `err` is this run stopping rather than one call failing.
 *
 * A fetch cancelled by the run signal rejects with `AbortError`, not
 * `RunAbortedError`, so the signal is the only reliable discriminator — which is
 * why this takes one.
 */
export const isRunAbortedWith = (err, signal) =>
  isRunAborted(err) || Boolean(signal?.aborted && isAbortLike(err))

/** Reasons that mean nobody is listening, so silence is the right response. */
export const NOBODY_WAITING = new Set(['client-disconnected', 'stream-closed', 'cancelled'])
