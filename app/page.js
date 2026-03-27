'use client'

import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import ReactMarkdown from 'react-markdown'
import { NEGATIVE_FEEDBACK_REASON_CODES } from '../lib/feedback.js'

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false })

const FEEDBACK_REASON_LABELS = {
  helpful: 'Helpful',
  wrong: 'Wrong',
  unclear: 'Unclear',
  missing_citation_links: 'Missing citation/link',
  not_specific_enough: 'Not specific enough',
  tool_failed: 'Tool failed',
  out_of_scope_refusal: 'Out of scope/refusal'
}

const GRAPH_PALETTE = ['#4a9eff', '#4ade80', '#f59e0b', '#f472b6', '#22d3ee', '#a78bfa', '#f87171', '#34d399']

function hashString(value = '') {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

const BasicGraphView = memo(function BasicGraphView({ graph }) {
  const containerRef = useRef(null)
  const fgRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 640, height: 400 })

  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []

  // Build color map from groups
  const groupColorMap = useMemo(() => {
    const map = {}
    const groups = [...new Set(nodes.map(n => n.group || '').filter(Boolean))]
    groups.forEach((g, i) => { map[g] = GRAPH_PALETTE[i % GRAPH_PALETTE.length] })
    return map
  }, [nodes])

  // Build graph data for force-graph (must use fresh objects each render to avoid mutation issues)
  const graphData = useMemo(() => {
    const nodeIds = new Set(nodes.map(n => String(n.id)))
    return {
      nodes: nodes.map(n => ({
        id: String(n.id),
        label: n.label || n.id,
        group: n.group || '',
        color: n.color || groupColorMap[n.group] || GRAPH_PALETTE[hashString(n.label || n.id) % GRAPH_PALETTE.length],
        size: n.size || 1
      })),
      links: edges
        .filter(e => nodeIds.has(String(e.source)) && nodeIds.has(String(e.target)))
        .map(e => ({
          source: String(e.source),
          target: String(e.target),
          label: e.label || (Number.isFinite(Number(e.weight)) ? String(e.weight) : ''),
          weight: Number(e.weight) || 1
        }))
    }
  }, [nodes, edges, groupColorMap])

  // Measure container width
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w > 0) setDimensions({ width: w, height: Math.max(350, Math.min(500, w * 0.6)) })
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Zoom to fit after initial layout settles
  useEffect(() => {
    const timer = setTimeout(() => {
      if (fgRef.current) fgRef.current.zoomToFit(300, 40)
    }, 800)
    return () => clearTimeout(timer)
  }, [graphData])

  if (nodes.length === 0 || edges.length === 0) return null

  const isDirected = graph?.directed !== false
  const maxWeight = Math.max(1, ...graphData.links.map(l => l.weight))

  // Build legend entries from groups
  const legendEntries = [...new Set(nodes.map(n => n.group).filter(Boolean))].map(g => ({
    group: g,
    color: groupColorMap[g] || '#888'
  }))

  return (
    <div ref={containerRef} style={{
      marginTop: '10px',
      border: '1px solid #2a2a2a',
      borderRadius: '8px',
      backgroundColor: '#0f0f12',
      padding: '10px',
      overflow: 'hidden'
    }}>
      {graph?.title && (
        <div style={{
          fontSize: '0.82em',
          color: '#9ecbff',
          marginBottom: '6px',
          fontWeight: 600
        }}>
          {graph.title}
        </div>
      )}
      {legendEntries.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '6px', fontSize: '0.72em' }}>
          {legendEntries.map(e => (
            <span key={e.group} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ccc' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: e.color, display: 'inline-block' }} />
              {e.group}
            </span>
          ))}
        </div>
      )}
      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={dimensions.width - 20}
        height={dimensions.height}
        backgroundColor="#0f0f12"
        nodeRelSize={6}
        nodeVal={n => Math.max(1, (n.size || 1) * 1.5)}
        nodeColor={n => n.color}
        nodeLabel={n => `${n.label}${n.group ? ` (${n.group})` : ''}`}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const r = Math.max(3, 4 + (node.size || 1) * 2)
          ctx.beginPath()
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI)
          ctx.fillStyle = node.color
          ctx.fill()
          ctx.strokeStyle = '#1a1a2e'
          ctx.lineWidth = 0.5
          ctx.stroke()
          // Draw label when zoomed in enough
          if (globalScale > 0.7) {
            const label = node.label || node.id
            const fontSize = Math.max(3, 10 / globalScale)
            ctx.font = `${fontSize}px sans-serif`
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.fillStyle = '#e5e7eb'
            ctx.fillText(label, node.x, node.y + r + 2)
          }
        }}
        linkColor={() => '#4b5563'}
        linkWidth={link => Math.max(0.5, 1 + (link.weight / maxWeight) * 3)}
        linkDirectionalArrowLength={isDirected ? 5 : 0}
        linkDirectionalArrowRelPos={1}
        linkLabel={link => link.label}
        linkCurvature={link => {
          // Curve parallel edges between same node pairs
          const key = [link.source?.id || link.source, link.target?.id || link.target].sort().join('-')
          const rev = [link.target?.id || link.target, link.source?.id || link.source].sort().join('-')
          return key === rev ? 0 : 0.15
        }}
        d3VelocityDecay={0.3}
        cooldownTicks={80}
        enableZoomInteraction={true}
        enablePanInteraction={true}
      />
    </div>
  )
})

// ── Memoized single-message bubble ──────────────────────────────────
// Only re-renders when its own props change, NOT when sibling messages
// are added or the thinking indicator ticks.
const ChatMessage = memo(function ChatMessage({
  msg,
  markdownComponents,
  feedbackState,
  onSubmitHelpful,
  onSelectNeedsWork,
  onSubmitFeedbackReason,
  onToggleIncludeConversation
}) {
  const getDisplayName = (role) => {
    if (role === 'user') return 'Researcher'
    if (role === 'assistant') return 'VFB'
    if (role === 'reasoning') return 'VFB'
    return role
  }

  const canCollectFeedback = msg.role === 'assistant' && msg.requestId && msg.responseId
  const isSubmittingFeedback = feedbackState?.status === 'submitting'
  const isFeedbackSubmitted = feedbackState?.status === 'submitted'

  return (
    <div role="article" aria-label={`${getDisplayName(msg.role)} message`} style={{
      marginBottom: '12px',
      padding: '8px 12px',
      backgroundColor: msg.role === 'user' ? '#1a1a2e' : 'transparent',
      borderRadius: '6px',
      borderLeft: msg.role === 'user' ? '3px solid #4a9eff' : '3px solid #2a6a3a'
    }}>
      <div aria-hidden="true" style={{
        fontSize: '0.75em',
        fontWeight: 600,
        color: msg.role === 'user' ? '#4a9eff' : '#4ade80',
        marginBottom: '4px',
        textTransform: 'uppercase',
        letterSpacing: '0.5px'
      }}>
        {getDisplayName(msg.role)}
      </div>
      <div
        className="message-content"
        style={msg.role === 'reasoning' ? { fontSize: '0.85em', fontStyle: 'italic', color: '#999' } : {}}
      >
        <ReactMarkdown
          components={markdownComponents}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
      {Array.isArray(msg.graphs) && msg.graphs.length > 0 && (
        <div>
          {msg.graphs.map((graph, graphIndex) => (
            <BasicGraphView
              key={`${msg.id}-graph-${graphIndex}`}
              graph={graph}
            />
          ))}
        </div>
      )}
      {/* Image gallery from API images field */}
      {msg.images && msg.images.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {msg.images.map((img, i) => (
            <div key={i} style={{ display: 'inline-block' }}>
              <img
                src={img.thumbnail}
                alt={img.label}
                style={{
                  width: '80px',
                  height: '80px',
                  objectFit: 'cover',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
                title={img.label}
              />
            </div>
          ))}
        </div>
      )}
      {canCollectFeedback && (
        <div style={{
          marginTop: '10px',
          paddingTop: '8px',
          borderTop: '1px solid #1f1f1f'
        }}>
          {isFeedbackSubmitted ? (
            <div style={{ fontSize: '0.75em', color: '#7ec699' }}>
              Feedback recorded. Thank you.
            </div>
          ) : (
            <>
              <div style={{ fontSize: '0.75em', color: '#aaa', marginBottom: '6px' }}>
                Was this response useful?
              </div>
              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => onSubmitHelpful(msg)}
                  disabled={isSubmittingFeedback}
                  style={{
                    padding: '4px 10px',
                    backgroundColor: '#173522',
                    color: '#dff7e7',
                    border: '1px solid #29543a',
                    borderRadius: '999px',
                    cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer',
                    fontSize: '0.75em'
                  }}
                >
                  Helpful
                </button>
                <button
                  type="button"
                  onClick={() => onSelectNeedsWork(msg)}
                  disabled={isSubmittingFeedback}
                  style={{
                    padding: '4px 10px',
                    backgroundColor: feedbackState?.selectedRating === 'down' ? '#3b1d22' : '#25161a',
                    color: '#ffdede',
                    border: '1px solid #5d2a33',
                    borderRadius: '999px',
                    cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer',
                    fontSize: '0.75em'
                  }}
                >
                  Needs work
                </button>
              </div>
              {feedbackState?.selectedRating === 'down' && (
                <>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '8px',
                      marginTop: '10px',
                      fontSize: '0.75em',
                      color: '#b8d7ff',
                      cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(feedbackState?.attachConversation)}
                      disabled={isSubmittingFeedback}
                      onChange={(event) => onToggleIncludeConversation(msg, event.target.checked)}
                      style={{ marginTop: '2px' }}
                    />
                    <span>
                      Attach the full visible conversation for investigation.
                      <span style={{ display: 'block', color: '#888', marginTop: '3px' }}>
                        Only do this if you are comfortable sharing the chat text. Attached conversations are retained for up to 30 days.
                      </span>
                    </span>
                  </label>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
                    {NEGATIVE_FEEDBACK_REASON_CODES.map((reasonCode) => (
                      <button
                        key={reasonCode}
                        type="button"
                        onClick={() => onSubmitFeedbackReason(msg, reasonCode, Boolean(feedbackState?.attachConversation))}
                        disabled={isSubmittingFeedback}
                        style={{
                          padding: '4px 10px',
                          backgroundColor: '#101820',
                          color: '#c9e6ff',
                          border: '1px solid #284055',
                          borderRadius: '999px',
                          cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer',
                          fontSize: '0.72em'
                        }}
                      >
                        {FEEDBACK_REASON_LABELS[reasonCode]}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {feedbackState?.status === 'error' && (
                <div style={{ marginTop: '8px', fontSize: '0.75em', color: '#ff9e9e' }}>
                  Unable to record feedback right now. Please try again.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
})

export default function Home() {
  const searchParams = useSearchParams()
  const rawQuery = searchParams.get('query') || ''
  const initialQuery = (() => { try { return decodeURIComponent(rawQuery) } catch { return rawQuery } })()
  const existingI = searchParams.get('i') || ''
  const existingId = searchParams.get('id') || ''

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState(initialQuery)
  const [scene, setScene] = useState({ id: existingId, i: existingI })
  const [isThinking, setIsThinking] = useState(false)
  const [thinkingDots, setThinkingDots] = useState('.')
  const [rateInfo, setRateInfo] = useState({ used: 0, limit: 50, remaining: 50 })
  const [thinkingSteps, setThinkingSteps] = useState([{ message: 'Thinking', done: false }])
  const [feedbackStateByResponseId, setFeedbackStateByResponseId] = useState({})
  const chatEndRef = useRef(null)
  const msgIdRef = useRef(0) // stable, incrementing message ID
  const initialSendFired = useRef(false) // prevent double-send from StrictMode

  // Helper: inject VFB term links into responses, so IDs like FBbt_00003748 or VFB_00102107
  // become clickable links to the corresponding Virtual Fly Brain report page.
  //
  // Avoid modifying IDs that are already part of a URL (e.g. https://virtualflybrain.org/reports/VFB_...) as this can break
  // thumbnail URLs and other VFB links.
  const linkifyVfbTerms = (text) => {
    if (!text) return text

    // Strip OpenAI Responses API citation artifacts in all known formats
    let cleaned = text.replace(/\u3010[^\u3011]*\u3011/g, '')  // 【...】 bracketed citations
    cleaned = cleaned.replace(/citeturn[\w?]*\d*/g, '')         // citeturn0search0, citeturn0?, citeturn0vfbsomething etc.
    cleaned = cleaned.replace(/\bcite(?=\[|https?:\/\/)/g, '')  // orphaned "cite" before links
    // Clean up leftover whitespace/punctuation from stripped artifacts
    cleaned = cleaned.replace(/ {2,}/g, ' ').replace(/\.\s*\?\s*/g, '. ').replace(/\. \./g, '.')

    // Preserve existing markdown links/images exactly as-is to avoid
    // creating nested markdown when we linkify plain IDs below.
    const markdownPlaceholders = []
    const MARKDOWN_PLACEHOLDER = '\x00MD'
    let result = cleaned.replace(/!?\[[^\]]*\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g, (markdownLink) => {
      markdownPlaceholders.push(markdownLink)
      return `${MARKDOWN_PLACEHOLDER}${markdownPlaceholders.length - 1}\x00`
    })

    const urlPlaceholders = []
    const URL_PLACEHOLDER = '\x00URL'
    result = result.replace(/https?:\/\/[^\s)]+/g, (url) => {
      urlPlaceholders.push(url)
      return `${URL_PLACEHOLDER}${urlPlaceholders.length - 1}\x00`
    })

    // Avoid double-linking IDs that are already inside markdown links.
    // Link VFB and FBbt IDs to VFB, FBrf IDs to FlyBase
    result = result.replace(/(?<!\[)(?<!\]\()(\b(FBbt_\d{8}|VFB_\d{8})\b)/g, '[$1](https://virtualflybrain.org/reports/$1)')
    result = result.replace(/(?<!\[)(?<!\]\()(\b(FBrf\d{7})\b)/g, '[$1](https://flybase.org/reports/$1)')

    // Restore protected URLs
    result = result.replace(new RegExp(`${URL_PLACEHOLDER}(\\d+)\\x00`, 'g'), (_, idx) => urlPlaceholders[Number(idx)])
    // Restore pre-existing markdown links/images
    result = result.replace(new RegExp(`${MARKDOWN_PLACEHOLDER}(\\d+)\\x00`, 'g'), (_, idx) => markdownPlaceholders[Number(idx)])

    return result
  }

  // Helper: create a message object with a stable unique id
  const makeMsg = useCallback((role, content, extras = {}) => ({
    id: ++msgIdRef.current,
    role,
    content: role !== 'user' ? linkifyVfbTerms(content) : content,
    ...extras
  }), [])

  const updateFeedbackState = useCallback((responseId, patch) => {
    if (!responseId) return

    setFeedbackStateByResponseId(prev => ({
      ...prev,
      [responseId]: {
        ...(prev[responseId] || {}),
        ...patch
      }
    }))
  }, [])

  // Auto-scroll to bottom when messages change or thinking starts/stops
  // NOT on thinkingDots – that would cause layout jumps every 500ms
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isThinking])

  function createVFBUrl(scene) {
    if (!scene.id) return '#'
    const baseUrl = 'https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto'
    return `${baseUrl}?id=${encodeURIComponent(scene.id)}${scene.i ? `&i=${encodeURIComponent(scene.i)}` : ''}`
  }

  useEffect(() => {
    if (isThinking) {
      const interval = setInterval(() => {
        setThinkingDots(prev => prev === '...' ? '.' : prev + '.')
      }, 500)
      return () => clearInterval(interval)
    }
  }, [isThinking])

  const fetchRateInfo = useCallback(async () => {
    try {
      const response = await fetch('/api/rate-info')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setRateInfo({
        used: data.used ?? 0,
        limit: data.limit ?? 50,
        remaining: data.remaining ?? Math.max(0, (data.limit ?? 50) - (data.used ?? 0))
      })
    } catch (error) {
      // Keep existing state on error; not critical for user workflow
      console.error('Failed to fetch rate info', error)
    }
  }, [])

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    fetchRateInfo()

    if (initialQuery && !initialSendFired.current) {
      initialSendFired.current = true
      handleSend()
    } else if (!initialQuery) {
      setMessages([makeMsg('assistant', `Welcome to VFB Chat! I'm here to help you explore Drosophila neuroanatomy and neuroscience using Virtual Fly Brain data.

**Important AI Usage Guidelines:**
- Always verify information from AI responses with primary sources
- We log limited technical and usage data, including IP addresses for abuse prevention
- Raw security logs are retained for up to 30 days
- We do not store full chat content for routine analytics
- If you report a problem, you can optionally attach the visible chat for investigation for up to 30 days
- Do not share confidential or sensitive information
- Use this tool to enhance your understanding of neuroscience concepts
- See the [Privacy Notice](/privacy) for more information

Here are some example queries you can try:
- What neurons are involved in visual processing?
- Show me images of Kenyon cells
- How does the olfactory system work in flies?
- Find neurons similar to DA1 using NBLAST
- What genes are expressed in the antennal lobe?

Feel free to ask about neural circuits, gene expression, connectome data, or any VFB-related topics!`)])
    }
  }, [fetchRateInfo])
  /* eslint-enable react-hooks/exhaustive-deps */

  const buildAttachedConversation = useCallback((targetMsg) => {
    if (!targetMsg?.id) return []

    const transcript = []

    for (const item of messages) {
      if (item.role === 'user' || item.role === 'assistant') {
        const conversationItem = {
          role: item.role,
          content: item.content
        }

        if (Array.isArray(item.images) && item.images.length > 0) {
          conversationItem.images = item.images
        }

        transcript.push(conversationItem)
      }

      if (item.id === targetMsg.id) {
        break
      }
    }

    return transcript
  }, [messages])

  const submitFeedback = useCallback(async (msg, rating, reasonCode, options = {}) => {
    if (!msg?.requestId || !msg?.responseId) return
    const attachConversation = Boolean(options.attachConversation && rating === 'down')
    const conversation = attachConversation ? buildAttachedConversation(msg) : null

    updateFeedbackState(msg.responseId, {
      status: 'submitting',
      selectedRating: rating,
      attachConversation
    })

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: msg.requestId,
          response_id: msg.responseId,
          rating,
          reason_code: reasonCode,
          attach_conversation: attachConversation,
          conversation
        })
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      updateFeedbackState(msg.responseId, {
        status: 'submitted',
        rating,
        reasonCode,
        selectedRating: rating,
        attachConversation
      })
    } catch {
      updateFeedbackState(msg.responseId, {
        status: 'error',
        selectedRating: rating,
        attachConversation
      })
    }
  }, [buildAttachedConversation, updateFeedbackState])

  const handleSubmitHelpful = useCallback((msg) => {
    submitFeedback(msg, 'up', 'helpful')
  }, [submitFeedback])

  const handleSelectNeedsWork = useCallback((msg) => {
    updateFeedbackState(msg.responseId, {
      status: 'idle',
      selectedRating: 'down',
      attachConversation: false
    })
  }, [updateFeedbackState])

  const handleToggleIncludeConversation = useCallback((msg, checked) => {
    updateFeedbackState(msg.responseId, {
      attachConversation: Boolean(checked)
    })
  }, [updateFeedbackState])

  const handleSubmitFeedbackReason = useCallback((msg, reasonCode, attachConversation = false) => {
    submitFeedback(msg, 'down', reasonCode, { attachConversation })
  }, [submitFeedback])

  const handleSend = async (messageText = null) => {
    const textToSend = (typeof messageText === 'string' ? messageText : null) || input
    if (!textToSend.trim()) return

    const userMessage = makeMsg('user', textToSend)
    const outboundMessages = [...messages, userMessage]
    setMessages(prev => [...prev, userMessage])
    if (!messageText) setInput('')
    setIsThinking(true)
    setThinkingSteps([{ message: 'Thinking', done: false }])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: outboundMessages, scene })
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7)
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6))

              if (currentEvent === 'status') {
                setThinkingSteps(prev => {
                  const updated = prev.map(s => ({ ...s, done: true }))
                  const alreadyExists = updated.some(s => s.message === data.message && !s.done)
                  if (alreadyExists) return updated
                  return [...updated, { message: data.message, done: false, error: !!data.error }]
                })
              } else if (currentEvent === 'reasoning') {
                setMessages(prev => [...prev, makeMsg('reasoning', data.text)])
              } else if (currentEvent === 'result') {
                setMessages(prev => [...prev, makeMsg('assistant', data.response, {
                  images: data.images,
                  graphs: data.graphs,
                  requestId: data.requestId,
                  responseId: data.responseId
                })])
                if (data.newScene) setScene(data.newScene)
                setIsThinking(false)
                fetchRateInfo()
                return
              } else if (currentEvent === 'error') {
                setMessages(prev => [...prev, makeMsg('assistant', data.message, {
                  requestId: data.requestId,
                  responseId: data.responseId
                })])
                setIsThinking(false)
                fetchRateInfo()
                return
              } else if (currentEvent) {
                console.warn('[VFBchat] Unrecognized SSE event:', currentEvent, data)
              }
            } catch (parseError) {
              console.error('Failed to parse streaming data:', parseError, 'raw line:', line)
            }
          }
        }
      }
    } catch (error) {
      setMessages(prev => [...prev, makeMsg('assistant', 'Sorry, there was an error processing your request. Please try again.')])
      setIsThinking(false)
      fetchRateInfo()
    }
  }

  // Custom renderers for react-markdown
  const normalizeMarkdownHref = (rawHref) => {
    const href = typeof rawHref === 'string' ? rawHref.trim() : ''
    if (!href) return ''

    // Repair malformed href values like:
    // [virtualflybrain.org/reports/FBbt_...](https://virtualflybrain.org/reports/FBbt_...)
    const nestedMarkdownHref = href.match(/^\[[^\]]+\]\((https?:\/\/[^)\s]+)\)$/i)
    if (nestedMarkdownHref?.[1]) {
      return nestedMarkdownHref[1]
    }

    if (!href.startsWith('http') && !href.startsWith('/') && href.includes('.')) {
      return `https://${href}`
    }

    return href
  }

  const renderLink = ({ href, children }) => {
    const normalizedHref = normalizeMarkdownHref(href)
    let url = normalizedHref
    let title = undefined
    let isQueryLink = false
    
    // Handle chat.virtualflybrain.org query links
    if (normalizedHref && normalizedHref.startsWith('https://chat.virtualflybrain.org?query=')) {
      isQueryLink = true
      const params = new URLSearchParams(normalizedHref.split('?')[1])
      const queryText = params.get('query')
      
      if (isQueryLink) {
        return (
          <a
            href={normalizedHref}
            onClick={(e) => {
              e.preventDefault()
              if (queryText) {
                handleSend(queryText)
              }
            }}
            style={{ 
              color: '#66d9ff', 
              textDecoration: 'underline', 
              textDecorationColor: '#66d9ff40',
              cursor: 'pointer'
            }}
            title={`Ask: ${queryText}`}
          >
            {children}
          </a>
        )
      }
    }
    
    if (normalizedHref && !normalizedHref.startsWith('http')) {
      if (normalizedHref.startsWith('/')) {
        return (
          <a
            href={normalizedHref}
            style={{ color: '#66d9ff', textDecoration: 'underline', textDecorationColor: '#66d9ff40' }}
          >
            {children}
          </a>
        )
      }

      if (normalizedHref.startsWith('FBrf')) {
        // FlyBase references should link to FlyBase
        url = `https://flybase.org/reports/${normalizedHref}`
        title = 'View in FlyBase'
      } else if (normalizedHref.startsWith('VFB') || normalizedHref.startsWith('FBbt')) {
        // VFB and FBbt IDs should link to VFB
        url = `https://v2.virtualflybrain.org/org.geppetto.frontend/geppetto?id=${normalizedHref}`
        title = 'View in VFB'
      }
    }
    
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#66d9ff', textDecoration: 'underline', textDecorationColor: '#66d9ff40' }}
        title={title}
      >
        {children}<span className="sr-only"> (opens in new tab)</span>
      </a>
    )
  }

  const renderImage = ({ src, alt }) => {
    const isThumbnail = src && src.includes('virtualflybrain.org/data/VFB')
    if (!isThumbnail) {
      return (
        <span style={{ display: 'inline-block', margin: '4px', verticalAlign: 'middle' }}>
          <img src={src} alt={alt || 'Image'} style={{ maxWidth: '300px', maxHeight: '200px', borderRadius: '4px' }} />
        </span>
      )
    }
    // VFB thumbnail: compact with hover-to-expand
    return (
      <span className="vfb-thumb-wrap" style={{ display: 'inline-block', margin: '4px', verticalAlign: 'middle', position: 'relative' }}>
        <img
          src={src}
          alt={alt || 'VFB Image'}
          className="vfb-thumb"
          style={{
            maxWidth: '120px',
            maxHeight: '64px',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            border: '1px solid #444',
            borderRadius: '4px',
            cursor: 'pointer',
            verticalAlign: 'middle',
            transition: 'opacity 0.15s'
          }}
        />
        <span className="vfb-thumb-expanded" style={{
          position: 'absolute',
          bottom: '100%',
          left: '0',
          display: 'none',
          backgroundColor: '#111',
          border: '1px solid #444',
          borderRadius: '6px',
          padding: '6px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
          zIndex: 1000,
          whiteSpace: 'nowrap'
        }}>
          <img
            src={src}
            alt={alt || 'VFB Image'}
            style={{ maxWidth: '280px', maxHeight: '280px', borderRadius: '4px', display: 'block' }}
          />
          {alt && <span style={{ display: 'block', fontSize: '11px', color: '#aaa', marginTop: '4px', textAlign: 'center' }}>{alt}</span>}
        </span>
      </span>
    )
  }

  // Convert plain text URLs to clickable links or inline images
  // Handles:
  //   1. "Text https://chat.virtualflybrain.org?query=..." → clickable question link
  //   2. Standalone chat query URLs → clickable link with decoded query text
  //   3. VFB thumbnail URLs (plain text) → inline <img> with hover-to-expand
  const convertUrlsToLinks = (children) => {
    if (!children) return children
    
    if (typeof children === 'string') {
      const parts = []
      let lastIndex = 0
      
      // Unified regex: match EITHER a VFB thumbnail URL, a chat query URL,
      // or any other plain https:// URL that should become a clickable link
      const combinedRegex = /(https:\/\/www\.virtualflybrain\.org\/data\/VFB\/[^\s)]+\/thumbnail\.png)|(?:(\S.*?)\s+)?(https:\/\/chat\.virtualflybrain\.org\?query=[^\s)]+)|(https?:\/\/[^\s)<>]+)/g
      let match
      
      while ((match = combinedRegex.exec(children)) !== null) {
        // Add text before this match
        if (match.index > lastIndex) {
          parts.push(children.substring(lastIndex, match.index))
        }
        
        if (match[1]) {
          // ── VFB thumbnail URL ──
          const thumbUrl = match[1]
          // Try to extract a label from preceding text like "Thumbnail:" or surrounding context
          const precedingText = children.substring(Math.max(0, lastIndex), match.index).trim()
          const altText = precedingText.replace(/^[-•*]\s*/, '').replace(/:?\s*$/, '').trim() || 'VFB Image'
          
          parts.push(
            <span key={'thumb-' + match.index} className="vfb-thumb-wrap" style={{ display: 'inline-block', margin: '4px', verticalAlign: 'middle', position: 'relative' }}>
              <img
                src={thumbUrl}
                alt={altText}
                className="vfb-thumb"
                style={{
                  maxWidth: '120px',
                  maxHeight: '64px',
                  width: 'auto',
                  height: 'auto',
                  objectFit: 'contain',
                  border: '1px solid #444',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  verticalAlign: 'middle',
                  transition: 'opacity 0.15s'
                }}
              />
              <span className="vfb-thumb-expanded" style={{
                position: 'absolute',
                bottom: '100%',
                left: '0',
                display: 'none',
                backgroundColor: '#111',
                border: '1px solid #444',
                borderRadius: '6px',
                padding: '6px',
                boxShadow: '0 4px 16px rgba(0,0,0,0.7)',
                zIndex: 1000,
                whiteSpace: 'nowrap'
              }}>
                <img
                  src={thumbUrl}
                  alt={altText}
                  style={{ maxWidth: '280px', maxHeight: '280px', borderRadius: '4px', display: 'block' }}
                />
                <span style={{ display: 'block', fontSize: '11px', color: '#aaa', marginTop: '4px', textAlign: 'center' }}>{altText}</span>
              </span>
            </span>
          )
        } else if (match[3]) {
          // ── Chat query URL (with or without preceding text) ──
          const linkText = match[2] ? match[2].trim() : null
          const fullUrl = match[3]
          const params = new URLSearchParams(fullUrl.split('?')[1])
          const queryText = params.get('query')
          const decodedQuery = queryText ? decodeURIComponent(queryText) : fullUrl

          parts.push(
            <a
              key={fullUrl + match.index}
              href={fullUrl}
              onClick={(e) => {
                e.preventDefault()
                if (queryText) {
                  handleSend(decodeURIComponent(queryText))
                }
              }}
              style={{
                color: '#66d9ff',
                textDecoration: 'underline',
                textDecorationColor: '#66d9ff40',
                cursor: 'pointer'
              }}
              title={`Ask: ${decodedQuery}`}
            >
              {linkText || decodedQuery}
            </a>
          )
        } else if (match[4]) {
          // ── General URL (PubMed, DOI, bioRxiv, etc.) ──
          const trailingPunctRe = /[.,;:!?\)]+$/
          const plainUrl = match[4].replace(trailingPunctRe, '') // strip trailing punctuation
          const trailingPunct = match[4].substring(plainUrl.length)
          // Derive a short display label from the URL
          let displayText = plainUrl
          try {
            const urlObj = new URL(plainUrl)
            const hostname = urlObj.hostname.replace(/^www\./, '')
            displayText = hostname + urlObj.pathname.replace(/\/$/, '')
            if (displayText.length > 60) {
              displayText = hostname + '/...' + urlObj.pathname.slice(-30)
            }
          } catch (e) { /* use raw URL */ }

          parts.push(
            <a
              key={'url-' + match.index}
              href={plainUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: '#66d9ff',
                textDecoration: 'underline',
                textDecorationColor: '#66d9ff40'
              }}
            >
              {displayText}
            </a>
          )
          if (trailingPunct) {
            parts.push(trailingPunct)
          }
        }

        lastIndex = combinedRegex.lastIndex
      }
      
      // Add remaining text
      if (lastIndex < children.length) {
        parts.push(children.substring(lastIndex))
      }
      
      return parts.length > 0 && lastIndex > 0 ? parts : children
    }
    
    // If children is an array, process each element
    if (Array.isArray(children)) {
      return children.map((child, idx) => {
        if (typeof child === 'string') {
          const converted = convertUrlsToLinks(child)
          return <span key={`url-child-${idx}`}>{converted}</span>
        }
        return child
      })
    }
    
    return children
  }

  // Memoize markdown component renderers so they are referentially stable
  // across renders. This is critical for React.memo on ChatMessage to work.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  /* eslint-disable react-hooks/exhaustive-deps */
  const markdownComponents = useMemo(() => ({
    a: renderLink,
    img: renderImage,
    p: ({ children }) => <p style={{ margin: '0.4em 0' }}>{convertUrlsToLinks(children)}</p>,
    ul: ({ children }) => <ul style={{ margin: '0.4em 0', paddingLeft: '20px' }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: '0.4em 0', paddingLeft: '20px' }}>{children}</ol>,
    li: ({ children }) => <li style={{ margin: '0.2em 0' }}>{convertUrlsToLinks(children)}</li>,
    strong: ({ children }) => <strong style={{ color: '#fff' }}>{children}</strong>,
    h1: ({ children }) => <h3 style={{ color: '#fff', margin: '0.5em 0 0.3em' }}>{children}</h3>,
    h2: ({ children }) => <h4 style={{ color: '#fff', margin: '0.5em 0 0.3em' }}>{children}</h4>,
    h3: ({ children }) => <h5 style={{ color: '#fff', margin: '0.5em 0 0.3em' }}>{children}</h5>,
    code: ({ children }) => <code style={{ backgroundColor: '#1a1a2e', padding: '2px 4px', borderRadius: '3px', fontSize: '0.9em' }}>{children}</code>,
    table: ({ children }) => <table style={{ borderCollapse: 'collapse', margin: '0.5em 0', width: '100%', fontSize: '0.9em' }}>{children}</table>,
    thead: ({ children }) => <thead>{children}</thead>,
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => <tr>{children}</tr>,
    th: ({ children }) => <th style={{ border: '1px solid #444', padding: '4px 8px', backgroundColor: '#1a1a2e', color: '#fff', textAlign: 'left' }}>{children}</th>,
    td: ({ children }) => <td style={{ border: '1px solid #444', padding: '4px 8px', color: '#e0e0e0' }}>{children}</td>,
  }), []) // stable – renderLink/renderImage/convertUrlsToLinks use handleSend which is stable via closure
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div style={{
      backgroundColor: '#000',
      color: '#e0e0e0',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      padding: '12px 16px',
      boxSizing: 'border-box',
      overflow: 'hidden'
    }}>
      {/* Skip to main content link for keyboard/screen reader users */}
      <a
        href="#chat-input"
        style={{
          position: 'absolute',
          left: '-9999px',
          top: '0',
          zIndex: 100,
          padding: '8px 16px',
          backgroundColor: '#4a9eff',
          color: '#fff',
          textDecoration: 'none',
          fontWeight: 600
        }}
        onFocus={e => { e.target.style.left = '16px' }}
        onBlur={e => { e.target.style.left = '-9999px' }}
      >
        Skip to chat input
      </a>

      <header>
        <h1 style={{
          color: '#fff',
          margin: '0 0 8px 0',
          fontSize: '1.3em',
          fontWeight: 600,
          flexShrink: 0
        }}>
          Virtual Fly Brain
        </h1>
      </header>

      {/* Chat messages area - fills available space */}
      <main
        role="log"
        aria-label="Chat conversation"
        aria-live="polite"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px',
          backgroundColor: '#0a0a0a',
          border: '1px solid #222',
          borderRadius: '8px',
          minHeight: 0
        }}
      >
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            msg={msg}
            markdownComponents={markdownComponents}
            feedbackState={feedbackStateByResponseId[msg.responseId]}
            onSubmitHelpful={handleSubmitHelpful}
            onSelectNeedsWork={handleSelectNeedsWork}
            onSubmitFeedbackReason={handleSubmitFeedbackReason}
            onToggleIncludeConversation={handleToggleIncludeConversation}
          />
        ))}
        {isThinking && (
          <div
            role="status"
            aria-live="polite"
            style={{
              marginBottom: '12px',
              padding: '8px 12px',
              fontSize: '0.85em',
              color: '#999',
              borderLeft: '3px solid #333',
              borderRadius: '6px'
            }}
          >
            {thinkingSteps.map((step, i) => (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                marginBottom: i < thinkingSteps.length - 1 ? '3px' : 0,
                color: step.error ? '#ef4444' : step.done ? '#6b7280' : '#999'
              }}>
                <span style={{ fontSize: '0.9em', width: '16px', textAlign: 'center' }}>
                  {step.error ? '\u2717' : step.done ? '\u2713' : '\u25CB'}
                </span>
                <span style={{ fontStyle: step.done ? 'normal' : 'italic' }}>
                  {step.message}{!step.done && !step.error ? thinkingDots : ''}
                </span>
              </div>
            ))}
          </div>
        )}
        <div ref={chatEndRef} />
      </main>

      {/* Input area */}
      <div style={{
        display: 'flex',
        gap: '8px',
        marginTop: '8px',
        alignItems: 'center',
        flexShrink: 0
      }}>
        <label htmlFor="chat-input" className="sr-only">Ask about Drosophila neuroanatomy</label>
        <input
          id="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="Ask about Drosophila neuroanatomy..."
          style={{
            flex: 1,
            padding: '10px 14px',
            backgroundColor: '#111',
            color: '#fff',
            border: '1px solid #333',
            borderRadius: '6px',
            fontSize: '14px'
          }}
        />
        <div
          aria-label={`${rateInfo.used} of ${rateInfo.limit} daily queries used`}
          style={{
            fontSize: '10px',
            color: 'rgb(255, 255, 255)',
            opacity: 0.4,
            fontFamily: 'monospace',
            whiteSpace: 'nowrap'
          }}
        >
          {`${rateInfo.used}/${rateInfo.limit}`}
        </div>
        <button
          onClick={handleSend}
          disabled={isThinking}
          aria-label={isThinking ? 'Sending message, please wait' : 'Send message'}
          style={{
            padding: '10px 20px',
            backgroundColor: isThinking ? '#333' : '#4a9eff',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: isThinking ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: 600
          }}
        >
          Send
        </button>
      </div>

      {/* VFB Browser link */}
      {scene.id && (
        <div style={{ marginTop: '6px', flexShrink: 0 }}>
          <a
            href={createVFBUrl(scene)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#66d9ff', textDecoration: 'none', fontSize: '0.85em' }}
          >
            Open in VFB 3D Browser (opens in new tab) &rarr;
          </a>
        </div>
      )}

      {/* Footer disclaimer */}
      <footer style={{
        marginTop: '12px',
        padding: '8px 12px',
        backgroundColor: '#1a1a1a',
        border: '1px solid #333',
        borderRadius: '4px',
        fontSize: '0.75em',
        color: '#aaa',
        lineHeight: '1.3',
        flexShrink: 0
      }}>
        <strong>AI Response Notice:</strong> This tool provides AI-generated information based on Virtual Fly Brain data.
        {' '}Always verify critical information with primary sources. We log limited technical and usage data,
        including IP addresses for abuse prevention, and retain raw security logs for up to 30 days.
        {' '}We do not store full chat content for routine analytics, except when you explicitly attach a conversation while reporting a problem for short-term investigation. See our{' '}
        <a href="/privacy" style={{ color: '#66d9ff', textDecoration: 'underline' }}>
          Privacy Notice
        </a>{' | '}
        <a href="/accessibility" style={{ color: '#66d9ff', textDecoration: 'underline' }}>
          Accessibility Statement
        </a>.
      </footer>

      <style jsx global>{`
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        .vfb-thumb-wrap:hover .vfb-thumb-expanded {
          display: block !important;
        }
        .vfb-thumb-wrap:hover .vfb-thumb {
          opacity: 0.7;
        }
        *:focus-visible {
          outline: 2px solid #4a9eff;
          outline-offset: 2px;
        }
      `}</style>
    </div>
  )
}
