import { NextResponse } from 'next/server'

import { getClientIp } from './lib/clientIp.mjs'

// VFBchat defines no React Server Actions ('use server', or a <form action={fn}>) —
// the chat send path is a plain POST to /api/chat via fetch(). So any request
// carrying Next's Server Action signature header is not real app traffic: it's an
// automated scanner (commonly probing for the Server Actions SSRF class of bug,
// CVE-2024-34351 / GHSA-fr5h-rqp8-mj6g, which this Next 14.0.0 build predates the
// fix for) or a stray forwarded request. Next's own handling of that case has known
// crash bugs on 14.0.0 — a missing `origin` header, or an action id from a
// different build, throws an uncaught TypeError instead of returning a clean 4xx
// (vercel/next.js#70229, discussion #58646). Middleware runs before any route
// handler, so this never touches real chat traffic; it just stops the crash and
// the raw stack trace that was landing in the container's stdout for every scan.
const SERVER_ACTION_HEADER = 'next-action'

export function middleware (request) {
  if (request.method === 'POST' && request.headers.has(SERVER_ACTION_HEADER)) {
    console.error(`[VFBchat] FORGED SERVER ACTION REJECTED | path=${request.nextUrl.pathname} | ip=${getClientIp(request)}`)
    return new NextResponse(null, { status: 404 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
}
