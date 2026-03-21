import { getRateInfo } from '../../../lib/rateLimit.js'
import { NextResponse } from 'next/server'

export async function GET(request) {
  const xForwardedFor = request.headers.get('x-forwarded-for') || ''
  const clientIp = (xForwardedFor.split(',')[0] || '').trim() || request.headers.get('x-real-ip') || 'unknown'

  const info = getRateInfo(clientIp)
  return NextResponse.json(info)
}
