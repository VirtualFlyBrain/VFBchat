import { NextResponse } from 'next/server'

import {
  isNegativeFeedbackRating,
  isValidFeedbackReasonCode,
  normalizeAttachedConversation
} from '../../../lib/feedback.js'
import {
  ensureGovernanceStorage,
  recordFeedbackEvent,
  recordFeedbackTranscript
} from '../../../lib/governance.js'
import { checkAndIncrement } from '../../../lib/rateLimit.js'
import { getClientIp } from '../../../lib/clientIp.mjs'

function normalizeRating(value) {
  return value === 'up' || value === 'down' ? value : null
}

export async function POST(request) {
  ensureGovernanceStorage()

  // /api/chat rate-limits every request; this route did not, and it is the one
  // that appends up to 100 KB of conversation transcript to a store the
  // University treats as genuine user data and keeps for 30 days. Unlimited and
  // unauthenticated, a loop here fills the log volume — at which point every
  // writeJson in governance.js starts throwing and the chat route's
  // finalizeGovernanceEvent fails with it.
  const clientIp = getClientIp(request)
  const rateCheck = checkAndIncrement(clientIp)
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: 'Daily feedback limit reached.' },
      { status: 429 }
    )
  }

  try {
    const body = await request.json()
    const requestId = typeof body.request_id === 'string' ? body.request_id.trim() : ''
    const responseId = typeof body.response_id === 'string' ? body.response_id.trim() : ''
    const rating = normalizeRating(body.rating)
    const reasonCode = typeof body.reason_code === 'string' ? body.reason_code.trim() : ''
    const attachConversation = body.attach_conversation === true
    const conversation = attachConversation
      ? normalizeAttachedConversation(body.conversation)
      : null

    if (!requestId || !responseId || !rating || !isValidFeedbackReasonCode(reasonCode)) {
      return NextResponse.json(
        { error: 'Invalid feedback payload.' },
        { status: 400 }
      )
    }

    if (attachConversation && !isNegativeFeedbackRating(rating)) {
      return NextResponse.json(
        { error: 'Conversation attachments are only allowed for negative feedback.' },
        { status: 400 }
      )
    }

    if (attachConversation && !conversation) {
      return NextResponse.json(
        { error: 'Invalid attached conversation payload.' },
        { status: 400 }
      )
    }

    recordFeedbackEvent({
      requestId,
      responseId,
      rating,
      reasonCode,
      conversationAttached: attachConversation,
      conversationMessageCount: conversation?.length || 0
    })

    if (attachConversation) {
      recordFeedbackTranscript({
        requestId,
        responseId,
        rating,
        reasonCode,
        conversation
      })
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json(
      { error: 'Unable to record feedback.' },
      { status: 500 }
    )
  }
}
