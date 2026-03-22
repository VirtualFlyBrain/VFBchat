export const FEEDBACK_REASON_CODES = [
  'helpful',
  'wrong',
  'unclear',
  'missing_citation_links',
  'not_specific_enough',
  'tool_failed',
  'out_of_scope_refusal'
]

export const NEGATIVE_FEEDBACK_REASON_CODES = FEEDBACK_REASON_CODES.filter(code => code !== 'helpful')
export const MAX_ATTACHED_CONVERSATION_MESSAGES = 100
export const MAX_ATTACHED_CONVERSATION_CHARS = 100000

export function isValidFeedbackReasonCode(value) {
  return FEEDBACK_REASON_CODES.includes(value)
}

export function isNegativeFeedbackRating(value) {
  return value === 'down'
}

export function normalizeAttachedConversation(conversation) {
  if (!Array.isArray(conversation) || conversation.length === 0) return null
  if (conversation.length > MAX_ATTACHED_CONVERSATION_MESSAGES) return null

  let totalChars = 0
  const normalized = []

  for (const item of conversation) {
    if (!item || typeof item !== 'object') return null
    if (item.role !== 'user' && item.role !== 'assistant') return null
    if (typeof item.content !== 'string') return null

    totalChars += item.content.length
    if (totalChars > MAX_ATTACHED_CONVERSATION_CHARS) return null

    const normalizedItem = {
      role: item.role,
      content: item.content
    }

    if (Array.isArray(item.images) && item.images.length > 0) {
      normalizedItem.images = item.images
        .filter(image => image && typeof image === 'object')
        .map(image => ({
          id: typeof image.id === 'string' ? image.id : '',
          template: typeof image.template === 'string' ? image.template : '',
          thumbnail: typeof image.thumbnail === 'string' ? image.thumbnail : '',
          label: typeof image.label === 'string' ? image.label : ''
        }))
        .filter(image => image.thumbnail)
    }

    normalized.push(normalizedItem)
  }

  return normalized
}
