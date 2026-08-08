// One reading of the client IP, used by every route that rate-limits or logs.
//
// It was defined inside app/api/chat/route.js, so /api/feedback — which appends
// a whole conversation transcript to a 30-day store — had no notion of a client
// at all, and no rate limit either.
export function getClientIp (request) {
  const xForwardedFor = request.headers.get('x-forwarded-for') || ''
  return (xForwardedFor.split(',')[0] || '').trim() || request.headers.get('x-real-ip') || 'unknown'
}
