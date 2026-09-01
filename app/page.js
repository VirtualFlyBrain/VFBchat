'use client'

import SiteFooter from './SiteFooter'
import { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import ReactMarkdown from 'react-markdown'
import { NEGATIVE_FEEDBACK_REASON_CODES } from '../lib/feedback.js'
import {
  GRAPH_PALETTE,
  GRAPH_ROLE_STYLES,
  GRAPH_EDGE_NEUTRAL,
  GRAPH_SUBCLASS_COLOR,
  GRAPH_SUBCLASS_WIDTH,
  GRAPH_SUBCLASS_DASH,
  GRAPH_EDGE_WEIGHT_BANDS,
  getEdgeWeightBand,
  shouldColorEdgesByWeight,
  shouldUseStructuralColoring,
  summariseEdgeWeights,
  formatGraphWeight,
  formatEdgeTooltip,
  formatNodeTooltip
} from '../lib/graphVisual.mjs'

const FEEDBACK_REASON_LABELS = {
  helpful: 'Helpful',
  wrong: 'Wrong',
  unclear: 'Unclear',
  missing_citation_links: 'Missing citation/link',
  not_specific_enough: 'Not specific enough',
  tool_failed: 'Tool failed',
  out_of_scope_refusal: 'Out of scope/refusal'
}

// VFB reports count -1 when it did not establish an exact total. That is two
// different situations (see lib/termInfoDigest.mjs): 'many' — the rows are
// final but there are more than the counting cap of them — and 'unknown' — the
// query has not been run yet. Neither may be printed as a number; before this,
// a -1 rendered literally as "— -1 results".
function tableCountLabel(tbl) {
  const kind = tbl?.countKind || (typeof tbl?.count === 'number' && tbl.count < 0 ? 'unknown' : 'exact')
  if (kind === 'many') return ` — more than ${tbl.countCap || 1000} results`
  if (kind === 'unknown') return ''
  if (typeof tbl?.count !== 'number') return ''
  return ` — ${tbl.count} result${tbl.count === 1 ? '' : 's'}`
}

// Whether the "view all" footer link should appear, and what it should say. A
// 'many' table always has more rows than the preview shows; an 'unknown' one
// might, and the honest offer there is to run the query rather than to promise
// a total.
function tableViewAllLabel(tbl) {
  const shown = tbl?.rows ? tbl.rows.length : 0
  const kind = tbl?.countKind || (typeof tbl?.count === 'number' && tbl.count < 0 ? 'unknown' : 'exact')
  if (kind === 'many') return 'View all in VFB'
  if (kind === 'unknown') return 'Run this query in VFB'
  if (typeof tbl?.count === 'number' && tbl.count > shown) return `View all ${tbl.count} in VFB`
  return ''
}

function hashString(value = '') {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

// Arrowhead size in user units, fixed rather than scaled by stroke width.
// The node padding below (targetPad) leaves room for exactly this much.
const GRAPH_ARROW_SIZE = 10

function normalizeGraphGroup(value = '') {
  return typeof value === 'string' ? value.trim() : ''
}

function getGraphNodeRole(stats = {}, directed = true) {
  const indegree = Number(stats.indegree) || 0
  const outdegree = Number(stats.outdegree) || 0

  if (!directed) {
    return indegree > 0 || outdegree > 0 ? 'bridge' : 'isolated'
  }

  if (outdegree > 0 && indegree === 0) return 'source'
  if (indegree > 0 && outdegree === 0) return 'target'
  if (indegree > 0 || outdegree > 0) return 'bridge'
  return 'isolated'
}

// Wrap a long node label onto multiple lines (by word) so it fits under the node
// instead of overflowing the SVG edge. Caps at maxLines, ellipsising the last.
function wrapGraphLabel(label = '', maxChars = 20, maxLines = 3) {
  const words = String(label).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  let line = ''
  for (const w of words) {
    if (!line) { line = w }
    else if ((line.length + 1 + w.length) <= maxChars) { line += ` ${w}` }
    else { lines.push(line); line = w }
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines) {
    // If words remain unplaced, mark truncation on the last visible line.
    const placed = lines.join(' ').split(/\s+/).length
    if (placed < words.length) lines[maxLines - 1] = `${lines[maxLines - 1]}…`
  }
  return lines
}

const BasicGraphView = memo(function BasicGraphView({ graph }) {
  const containerRef = useRef(null)
  const [dimensions, setDimensions] = useState({ width: 640, height: 400 })

  const nodes = useMemo(() => (Array.isArray(graph?.nodes) ? graph.nodes : []), [graph?.nodes])
  const edges = useMemo(() => (Array.isArray(graph?.edges) ? graph.edges : []), [graph?.edges])
  const isDirected = graph?.directed !== false

  const visualGrouping = useMemo(() => {
    const nodeStats = new Map(nodes.map(node => [String(node.id), { indegree: 0, outdegree: 0 }]))

    edges.forEach(edge => {
      const sourceId = String(edge.source)
      const targetId = String(edge.target)
      const sourceStats = nodeStats.get(sourceId)
      const targetStats = nodeStats.get(targetId)
      if (sourceStats) sourceStats.outdegree += 1
      if (targetStats) targetStats.indegree += 1
    })

    const roleCounts = { source: 0, target: 0, bridge: 0, isolated: 0 }
    const roleByNodeId = {}

    nodes.forEach(node => {
      const id = String(node.id)
      const role = getGraphNodeRole(nodeStats.get(id), isDirected)
      roleByNodeId[id] = role
      roleCounts[role] += 1
    })

    const groupCounts = nodes.reduce((acc, node) => {
      const group = normalizeGraphGroup(node.group)
      if (group) acc[group] = (acc[group] || 0) + 1
      return acc
    }, {})
    const providedGroups = Object.keys(groupCounts)
    const largestProvidedGroup = Object.values(groupCounts).reduce((max, count) => Math.max(max, count), 0)
    const hasDirectionalStructure = roleCounts.source > 0 && roleCounts.target > 0
    const useStructuralColoring = shouldUseStructuralColoring({
      providedGroupCount: providedGroups.length,
      largestProvidedGroup,
      nodeCount: nodes.length,
      isDirected,
      hasDirectionalStructure
    })

    if (useStructuralColoring) {
      const legend = Object.entries(GRAPH_ROLE_STYLES)
        .filter(([role]) => roleCounts[role] > 0)
        .map(([role, style]) => ({
          key: role,
          label: style.label,
          color: style.color
        }))

      return {
        useStructuralColoring,
        legend,
        byNodeId: nodes.reduce((acc, node) => {
          const id = String(node.id)
          const role = roleByNodeId[id] || 'bridge'
          acc[id] = {
            key: role,
            label: GRAPH_ROLE_STYLES[role].label,
            color: node.color || GRAPH_ROLE_STYLES[role].color
          }
          return acc
        }, {})
      }
    }

    const legend = providedGroups.map((group, index) => ({
      key: group,
      label: group,
      color: GRAPH_PALETTE[index % GRAPH_PALETTE.length]
    }))
    const paletteByGroup = Object.fromEntries(legend.map(entry => [entry.key, entry.color]))

    return {
      useStructuralColoring,
      legend,
      byNodeId: nodes.reduce((acc, node) => {
        const id = String(node.id)
        const group = normalizeGraphGroup(node.group)
        acc[id] = {
          key: group || id,
          label: group || '',
          color: node.color || paletteByGroup[group] || GRAPH_PALETTE[hashString(node.label || node.id) % GRAPH_PALETTE.length]
        }
        return acc
      }, {})
    }
  }, [nodes, edges, isDirected])

  const elements = useMemo(() => {
    const nodeIds = new Set(nodes.map(n => String(n.id)))
    const maxWeight = Math.max(1, ...edges.map(e => Number(e.weight) || 1))
    const cyNodes = nodes.map(n => {
      const id = String(n.id)
      const visualGroup = visualGrouping.byNodeId[id] || {}
      return {
        data: {
          id,
          label: n.label || n.id,
          group: visualGroup.label || normalizeGraphGroup(n.group),
          originalGroup: normalizeGraphGroup(n.group),
          color: visualGroup.color || n.color || GRAPH_PALETTE[hashString(n.label || n.id) % GRAPH_PALETTE.length],
          size: Math.max(20, 20 + (n.size || 1) * 10)
        }
      }
    })
    const cyEdges = edges
      .filter(e => nodeIds.has(String(e.source)) && nodeIds.has(String(e.target)))
      .map((e, i) => ({
        data: {
          id: `e${i}`,
          source: String(e.source),
          target: String(e.target),
          relation: e.relation || null,
          // Structural edges carry no weight; don't stamp "subclass of" on each.
          label: e.relation === 'SUBCLASSOF'
            ? ''
            : (e.label || (Number.isFinite(Number(e.weight)) ? String(e.weight) : '')),
          weight: Number(e.weight) || 1,
          width: Math.max(1, 1 + ((Number(e.weight) || 1) / maxWeight) * 4)
        }
      }))
    return [...cyNodes, ...cyEdges]
  }, [nodes, edges, visualGrouping])

  const svgSize = useMemo(() => ({
    width: Math.max(280, dimensions.width - 20),
    height: dimensions.height
  }), [dimensions])

  const svgGraph = useMemo(() => {
    const graphNodes = elements.filter(element => !element.data?.source)
    const graphEdges = elements.filter(element => element.data?.source && element.data?.target)
    // Horizontal gutter must leave room for the (wrapped) node labels that sit
    // under the left/right column nodes — a narrow margin clipped long class names
    // like "adult octopaminergic and glutamatergic neuron" off the left edge.
    const marginX = Math.min(140, Math.max(70, svgSize.width * 0.18))
    const marginY = 40
    const margin = marginX
    const availableHeight = Math.max(1, svgSize.height - (marginY * 2))
    const availableWidth = Math.max(1, svgSize.width - (marginX * 2))
    const statsByNodeId = new Map(graphNodes.map(node => [node.data.id, { indegree: 0, outdegree: 0 }]))

    graphEdges.forEach(edge => {
      const sourceStats = statsByNodeId.get(edge.data.source)
      const targetStats = statsByNodeId.get(edge.data.target)
      if (sourceStats) sourceStats.outdegree += 1
      if (targetStats) targetStats.indegree += 1
    })

    const sortedNodes = graphNodes.slice().sort((a, b) => String(a.data.label).localeCompare(String(b.data.label)))
    const positions = new Map()
    const directedRoles = ['source', 'bridge', 'target', 'isolated']
    const roleBuckets = Object.fromEntries(directedRoles.map(role => [role, []]))

    sortedNodes.forEach(node => {
      const role = getGraphNodeRole(statsByNodeId.get(node.data.id), isDirected)
      roleBuckets[role].push(node)
    })

    const useDirectionalLayout = isDirected && roleBuckets.source.length > 0 && roleBuckets.target.length > 0

    if (useDirectionalLayout) {
      const roleColumns = {
        source: margin,
        bridge: margin + (availableWidth * 0.5),
        target: margin + availableWidth,
        isolated: margin + (availableWidth * 0.5)
      }

      directedRoles.forEach(role => {
        const bucket = roleBuckets[role]
        bucket.forEach((node, index) => {
          positions.set(node.data.id, {
            x: roleColumns[role],
            y: marginY + ((index + 1) * availableHeight / (bucket.length + 1))
          })
        })
      })
    } else {
      const radius = Math.max(60, Math.min(availableWidth, availableHeight) * 0.38)
      const centerX = svgSize.width / 2
      const centerY = svgSize.height / 2
      sortedNodes.forEach((node, index) => {
        const angle = (-Math.PI / 2) + ((Math.PI * 2 * index) / Math.max(1, sortedNodes.length))
        positions.set(node.data.id, {
          x: centerX + Math.cos(angle) * radius,
          y: centerY + Math.sin(angle) * radius
        })
      })
    }

    const laidOutNodes = graphNodes.map(node => ({
      id: node.data.id,
      label: node.data.label,
      group: node.data.group,
      color: node.data.color,
      radius: Math.max(14, Math.min(32, Number(node.data.size) / 2 || 18)),
      ...(positions.get(node.data.id) || { x: svgSize.width / 2, y: svgSize.height / 2 })
    }))
    const laidOutNodeById = new Map(laidOutNodes.map(node => [node.id, node]))

    // Weight banding is about connectivity edges; structural (SUBCLASSOF) edges
    // have no weight and would otherwise flatten the scale.
    const connectivityEdges = graphEdges.filter(edge => edge.data.relation !== 'SUBCLASSOF')
    const edgeWeights = connectivityEdges.map(edge => Number(edge.data.weight) || 1)
    const maxEdgeWeight = Math.max(1, ...edgeWeights)
    const weightsVary = shouldColorEdgesByWeight(edgeWeights)

    return {
      nodes: laidOutNodes,
      weightsVary,
      edges: graphEdges
        .map(edge => {
          const source = laidOutNodeById.get(edge.data.source)
          const target = laidOutNodeById.get(edge.data.target)
          if (!source || !target) return null
          const isSubclass = edge.data.relation === 'SUBCLASSOF'
          const band = (!isSubclass && weightsVary)
            ? getEdgeWeightBand(edge.data.weight, maxEdgeWeight)
            : null
          return {
            id: edge.data.id,
            label: edge.data.label,
            width: isSubclass ? GRAPH_SUBCLASS_WIDTH : edge.data.width,
            dashed: isSubclass,
            band: isSubclass ? 'subclass' : (band?.key || null),
            color: isSubclass ? GRAPH_SUBCLASS_COLOR : (band?.color || GRAPH_EDGE_NEUTRAL),
            title: isSubclass
              ? `${source.label} is a subclass of ${target.label}`
              : formatEdgeTooltip({
                  sourceLabel: source.label,
                  targetLabel: target.label,
                  label: edge.data.label,
                  bandLabel: band?.label || '',
                  directed: isDirected
                }),
            source,
            target
          }
        })
        .filter(Boolean)
    }
  }, [elements, isDirected, svgSize.height, svgSize.width])

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

  if (nodes.length === 0 || edges.length === 0) return null

  const legendEntries = visualGrouping.legend
  const weightStats = summariseEdgeWeights(edges)
  const showWeightKey = svgGraph.weightsVary && isDirected

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
      {visualGrouping.useStructuralColoring && (
        <div style={{ fontSize: '0.72em', color: '#8f9aad', marginBottom: '6px' }}>
          Colours show connectivity role so the source and target sides are easier to scan.
        </div>
      )}
      {legendEntries.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '6px', fontSize: '0.72em' }}>
          {legendEntries.map(e => (
            <span key={e.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ccc' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: e.color, display: 'inline-block' }} />
              {e.label}
            </span>
          ))}
        </div>
      )}
      {showWeightKey && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '6px', fontSize: '0.72em', color: '#8f9aad' }}>
          <span>Connection strength</span>
          {GRAPH_EDGE_WEIGHT_BANDS.map(band => (
            <span key={band.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: '#ccc' }}>
              <span style={{ width: 14, height: 2, backgroundColor: band.color, display: 'inline-block' }} />
              {band.label}
            </span>
          ))}
        </div>
      )}
      {weightStats && weightStats.edges > 1 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))',
          gap: '6px',
          marginBottom: '8px',
          fontSize: '0.7em'
        }}>
          {[
            ['Connections', weightStats.edges],
            ['Total weight', formatGraphWeight(weightStats.total)],
            ['Min', formatGraphWeight(weightStats.min)],
            ['Max', formatGraphWeight(weightStats.max)],
            ['Mean', formatGraphWeight(weightStats.mean)],
            ['Median', formatGraphWeight(weightStats.median)]
          ].map(([label, value]) => (
            <div key={label} style={{ backgroundColor: '#1a1a24', borderRadius: '6px', padding: '4px 6px' }}>
              <div style={{ color: '#8f9aad' }}>{label}</div>
              <div style={{ color: '#e5e7eb', fontWeight: 600 }}>{value}</div>
            </div>
          ))}
        </div>
      )}
      <div
        style={{ width: svgSize.width, height: svgSize.height, backgroundColor: '#0f0f12' }}
      >
        <svg
          role="img"
          aria-label={graph?.title || 'Graph visualisation'}
          width="100%"
          height="100%"
          viewBox={`0 0 ${svgSize.width} ${svgSize.height}`}
          style={{ display: 'block' }}
        >
          <defs>
            {/* One marker per edge colour so the arrowhead matches its line.
                Ids are static rather than per-instance: every graph on the page
                defines the same markers with the same fills, so a collision
                between two graphs resolves to an identical arrow. */}
            {[{ key: 'neutral', color: GRAPH_EDGE_NEUTRAL },
              { key: 'subclass', color: GRAPH_SUBCLASS_COLOR },
              ...GRAPH_EDGE_WEIGHT_BANDS].map(band => (
              <marker
                key={band.key}
                id={`graph-arrow-${band.key}`}
                markerWidth={GRAPH_ARROW_SIZE}
                markerHeight={GRAPH_ARROW_SIZE}
                refX={GRAPH_ARROW_SIZE - 1}
                refY={GRAPH_ARROW_SIZE / 2}
                orient="auto"
                // userSpaceOnUse, not the SVG default of strokeWidth: line width
                // already carries the weight, and scaling the arrowhead by it
                // too grew a heavy edge's head to five times the node radius,
                // swallowing the node it pointed at.
                markerUnits="userSpaceOnUse"
              >
                <path
                  d={`M0,0 L${GRAPH_ARROW_SIZE},${GRAPH_ARROW_SIZE / 2} L0,${GRAPH_ARROW_SIZE} Z`}
                  fill={band.color}
                />
              </marker>
            ))}
          </defs>
          {svgGraph.edges.map(edge => {
            const dx = edge.target.x - edge.source.x
            const dy = edge.target.y - edge.source.y
            const distance = Math.max(1, Math.sqrt((dx * dx) + (dy * dy)))
            const sourcePad = edge.source.radius + 2
            const targetPad = edge.target.radius + (isDirected ? GRAPH_ARROW_SIZE : 2)
            const x1 = edge.source.x + (dx / distance) * sourcePad
            const y1 = edge.source.y + (dy / distance) * sourcePad
            const x2 = edge.target.x - (dx / distance) * targetPad
            const y2 = edge.target.y - (dy / distance) * targetPad
            const midX = (x1 + x2) / 2
            const midY = (y1 + y2) / 2

            return (
              <g key={edge.id}>
                {edge.title && <title>{edge.title}</title>}
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={edge.color}
                  strokeWidth={edge.width}
                  strokeDasharray={edge.dashed ? GRAPH_SUBCLASS_DASH : undefined}
                  markerEnd={isDirected ? `url(#graph-arrow-${edge.band || 'neutral'})` : undefined}
                />
                {edge.label && (
                  <text
                    x={midX}
                    y={midY - 4}
                    textAnchor="middle"
                    fill="#8f9aad"
                    fontSize="9"
                    paintOrder="stroke"
                    stroke="#0f0f12"
                    strokeWidth="3"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
          {svgGraph.nodes.map(node => (
            <g key={node.id}>
              <title>{formatNodeTooltip({ label: node.label, group: node.group })}</title>
              <circle
                cx={node.x}
                cy={node.y}
                r={node.radius}
                fill={node.color}
                stroke="#1a1a2e"
                strokeWidth="1"
              />
              <text
                x={node.x}
                y={node.y + node.radius + 13}
                textAnchor="middle"
                fill="#e5e7eb"
                fontSize="11"
                paintOrder="stroke"
                stroke="#0f0f12"
                strokeWidth="3"
              >
                {wrapGraphLabel(node.label).map((line, i) => (
                  <tspan key={i} x={node.x} dy={i === 0 ? 0 : 12}>{line}</tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
})

// ── Memoized single-message bubble ──────────────────────────────────
// A VFB thumbnail: height-capped, click opens the entity in VFB (new tab), and
// hovering shows a larger floating preview near the cursor so details are visible.
function VfbThumbnail({ src, alt, href, maxHeight = 48 }) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  if (!src) return null
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const clamp = (v, max) => Math.max(8, Math.min(v, max))
  const img = (
    <img src={src} alt={alt || ''} style={{ maxHeight, borderRadius: 3, border: '1px solid #333', display: 'block', cursor: 'zoom-in' }} />
  )
  const inner = (
    <>
      {img}
      {hover && (
        <div style={{ position: 'fixed', left: clamp(pos.x + 18, vw - 360), top: clamp(pos.y + 18, vh - 360), zIndex: 10000, pointerEvents: 'none', background: '#000', padding: 4, border: '1px solid #555', borderRadius: 6, boxShadow: '0 6px 24px rgba(0,0,0,0.7)' }}>
          <img src={src} alt={alt || ''} style={{ maxHeight: 320, maxWidth: 340, display: 'block' }} />
          {alt ? <div style={{ color: '#cbd5e1', fontSize: '0.72em', marginTop: 3, maxWidth: 340 }}>{alt}</div> : null}
        </div>
      )}
    </>
  )
  const handlers = {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onMouseMove: (e) => setPos({ x: e.clientX, y: e.clientY })
  }
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={`Open ${alt || 'image'} in VFB (new tab)`} style={{ display: 'inline-block', lineHeight: 0 }} {...handlers}>{inner}</a>
    : <span style={{ display: 'inline-block', lineHeight: 0 }} {...handlers}>{inner}</span>
}

// Feedback prompt — rendered ONCE at the bottom of the conversation (for the
// latest assistant response), not repeated on every message.
function FeedbackPrompt({ msg, feedbackState, onSubmitHelpful, onSelectNeedsWork, onSubmitFeedbackReason, onToggleIncludeConversation }) {
  if (!msg || msg.role !== 'assistant' || !msg.requestId || !msg.responseId) return null
  const isSubmittingFeedback = feedbackState?.status === 'submitting'
  const isFeedbackSubmitted = feedbackState?.status === 'submitted'
  return (
    <div style={{ marginTop: '4px', padding: '8px 12px', borderTop: '1px solid #1f1f1f' }}>
      {isFeedbackSubmitted ? (
        <div style={{ fontSize: '0.75em', color: '#7ec699' }}>Feedback recorded. Thank you.</div>
      ) : (
        <>
          <div style={{ fontSize: '0.75em', color: '#aaa', marginBottom: '6px' }}>Was this conversation useful?</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => onSubmitHelpful(msg)}
              disabled={isSubmittingFeedback}
              style={{ padding: '4px 10px', backgroundColor: '#173522', color: '#dff7e7', border: '1px solid #29543a', borderRadius: '999px', cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer', fontSize: '0.75em' }}
            >
              Helpful
            </button>
            <button
              type="button"
              onClick={() => onSelectNeedsWork(msg)}
              disabled={isSubmittingFeedback}
              style={{ padding: '4px 10px', backgroundColor: feedbackState?.selectedRating === 'down' ? '#3b1d22' : '#25161a', color: '#ffdede', border: '1px solid #5d2a33', borderRadius: '999px', cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer', fontSize: '0.75em' }}
            >
              Needs work
            </button>
          </div>
          {feedbackState?.selectedRating === 'down' && (
            <>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '10px', fontSize: '0.75em', color: '#b8d7ff', cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer' }}>
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
                    style={{ padding: '4px 10px', backgroundColor: '#101820', color: '#c9e6ff', border: '1px solid #284055', borderRadius: '999px', cursor: isSubmittingFeedback ? 'not-allowed' : 'pointer', fontSize: '0.72em' }}
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
  )
}

/**
 * The identifier for one answer, shown so it can be quoted.
 *
 * The DPIA describes a data-subject-rights route in which someone asks about
 * the data held on a particular exchange by quoting its response identifier.
 * The identifier was generated and stored from the beginning and never shown,
 * so the route could not be exercised and an assessor could disprove it in a
 * browser in under a minute.
 *
 * On EVERY answer, not only the latest. The feedback prompt is deliberately
 * rendered once at the foot of the conversation, but the response someone wants
 * to ask about is often not the last one, and an identifier that is only
 * available for the newest answer does not support the route the DPIA sets out.
 *
 * Quiet by design — 0.68em, muted, below the sources line — and selectable, with
 * a copy button for the common case. The clipboard API is unavailable over plain
 * HTTP and in some embedded browsers, so the text itself is always selectable
 * and the button degrades to saying so rather than to nothing.
 */
function ResponseIdentifier({ responseId }) {
  const [copied, setCopied] = useState('')
  const copy = useCallback(() => {
    const write = globalThis.navigator?.clipboard?.writeText
    if (typeof write !== 'function') { setCopied('select and copy'); return }
    globalThis.navigator.clipboard.writeText(responseId)
      .then(() => setCopied('copied'))
      .catch(() => setCopied('select and copy'))
  }, [responseId])
  return (
    // #8a8a8a, not #6f6f6f: at 0.68em this is small text, so WCAG 2.2 AA wants
    // 4.5:1 and the old value measured 3.94:1 against the answer background.
    <div style={{ marginTop: '8px', fontSize: '0.68em', color: '#8a8a8a', display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
      <span>Response ID:</span>
      <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#9a9a9a', userSelect: 'all' }}>
        {responseId}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy response ID ${responseId}`}
        style={{ background: 'none', border: '1px solid #2c2c2c', borderRadius: '4px', color: '#8f8f8f', cursor: 'pointer', fontSize: '1em', padding: '1px 6px' }}
      >
        Copy
      </button>
      {copied ? <span role="status">{copied}</span> : null}
    </div>
  )
}

// Only re-renders when its own props change, NOT when sibling messages
// are added or the thinking indicator ticks.
const ChatMessage = memo(function ChatMessage({
  msg,
  markdownComponents,
  onAskFollowOn
}) {
  const getDisplayName = (role) => {
    if (role === 'user') return 'Researcher'
    if (role === 'assistant') return 'VFB'
    if (role === 'reasoning') return 'VFB'
    return role
  }

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
      {/* Scrollable result tables (detailed query results with thumbnails). */}
      {msg.role === 'assistant' && Array.isArray(msg.tables) && msg.tables.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          {msg.tables.map((tbl, ti) => (
            <div key={`tbl-${ti}`} style={{ marginBottom: '12px', border: '1px solid #222', borderRadius: '6px', overflow: 'hidden' }}>
              <div style={{ fontSize: '0.78em', color: '#bbb', padding: '6px 10px', background: '#111', borderBottom: '1px solid #222' }}>
                {tbl.title}{tableCountLabel(tbl)}
              </div>
              <div style={{ maxHeight: '320px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8em' }}>
                  <tbody>
                    {(tbl.rows || []).map((r, ri) => (
                      <tr key={ri} style={{ borderTop: ri ? '1px solid #1a1a1a' : 'none' }}>
                        <td style={{ padding: '4px 8px', verticalAlign: 'middle' }}>
                          <VfbThumbnail src={r.thumbnail} alt={r.name} href={r.reportUrl} maxHeight={48} />
                        </td>
                        <td style={{ padding: '4px 8px', verticalAlign: 'middle' }}>
                          <a href={r.reportUrl} target="_blank" rel="noopener noreferrer" title={`Open ${r.name} in VFB (new tab)`} style={{ color: '#9ecbff', textDecoration: 'none' }}>{r.name}</a>
                          {Array.isArray(r.tags) && r.tags.length > 0 && (
                            // #8a8a8a, not #777: these tags render at about 11px
                            // inside a table row, so they are small text and
                            // #777 measured 4.42:1 — just under the 4.5:1 that
                            // WCAG 2.2 AA requires.
                            <div style={{ color: '#8a8a8a', fontSize: '0.85em', marginTop: '2px' }}>{r.tags.join(' · ')}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {tbl.queryUrl && tableViewAllLabel(tbl) && (
                <div style={{ padding: '6px 10px', borderTop: '1px solid #222', fontSize: '0.75em' }}>
                  <a href={tbl.queryUrl} target="_blank" rel="noopener noreferrer" title="Run this query in Virtual Fly Brain (new tab)" style={{ color: '#9ecbff' }}>
                    {tableViewAllLabel(tbl)} ↗
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Image gallery from API images field */}
      {msg.images && msg.images.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {msg.images.map((img, i) => (
            <div key={i} style={{ display: 'inline-block' }}>
              <VfbThumbnail
                src={img.thumbnail}
                alt={img.label}
                href={img.id ? `https://www.virtualflybrain.org/reports/${img.id}` : undefined}
                maxHeight={80}
              />
            </div>
          ))}
        </div>
      )}
      {/* Explore: follow-on chips (ask = run a chat query; vfb = open in VFB).
          Two distinct styles + hover tooltips so the user knows what a click does. */}
      {msg.role === 'assistant' && Array.isArray(msg.followOns) && msg.followOns.length > 0 && (
        <div style={{ marginTop: '10px' }}>
          <div aria-hidden="true" style={{ fontSize: '0.7em', color: '#888', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '5px' }}>
            Explore ▸
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {msg.followOns.map((chip, i) => chip.kind === 'vfb' ? (
              <a
                key={`fo-${i}`}
                href={chip.url}
                target="_blank"
                rel="noopener noreferrer"
                title={chip.title || `Open in Virtual Fly Brain (new tab)`}
                style={{
                  padding: '4px 10px', fontSize: '0.75em', borderRadius: '999px',
                  background: '#101820', color: '#9ecbff', border: '1px solid #284a6b',
                  textDecoration: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                }}
              >
                {chip.label} <span aria-hidden="true">↗</span>
              </a>
            ) : (
              <button
                key={`fo-${i}`}
                type="button"
                onClick={() => onAskFollowOn && onAskFollowOn(chip.query, chip.id && chip.query_type ? { id: chip.id, query_type: chip.query_type } : null)}
                title={chip.title || `Ask VFB: ${chip.query}`}
                style={{
                  padding: '4px 10px', fontSize: '0.75em', borderRadius: '999px',
                  background: '#173522', color: '#dff7e7', border: '1px solid #29543a',
                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px'
                }}
              >
                <span aria-hidden="true">↩</span> {chip.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Sources: clickable provenance — the VFB term pages, documentation pages
          and publications the answer was built on. Three kinds, one line, and the
          hover text says which: a term report, a VFB documentation page and a
          paper on PubMed are different promises about what is behind the link,
          and the label alone does not distinguish them. Deliberately quiet —
          0.72em, muted — so it sits under the answer rather than competing with
          it. Servers older than the kind field send none, hence the fallback. */}
      {msg.role === 'assistant' && Array.isArray(msg.sources) && msg.sources.length > 0 && (
        <div style={{ marginTop: '8px', fontSize: '0.72em', color: '#888' }}>
          Sources:{' '}
          {msg.sources.map((s, i) => (
            <span key={`src-${i}`}>
              {i > 0 ? ', ' : ''}
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                title={s.title || (s.id ? `Open ${s.label} term info in VFB (new tab)` : `Open ${s.label} (new tab)`)}
                style={{ color: '#7fb2e6' }}
              >
                {s.label}
              </a>
            </span>
          ))}
        </div>
      )}
      {msg.role === 'assistant' && msg.responseId ? <ResponseIdentifier responseId={msg.responseId} /> : null}
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
  // What the conversation has already resolved: ids, authoritative labels and
  // each term's query catalogue, as the server last merged them. The server is
  // stateless, so this round trip IS the session — without it, every turn
  // re-derives the subject from prose and turn 2 can fail to find a term turn 1
  // resolved, linked and built its own suggestion chips from. A ref rather than
  // state on purpose: nothing renders from it, and handleSend must read the
  // latest value synchronously rather than a value closed over at render time.
  const contextRef = useRef(null)
  const msgIdRef = useRef(0) // stable, incrementing message ID
  const streamingMsgIdRef = useRef(null) // id of the assistant bubble being streamed
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
- Do not share personal, confidential or sensitive information
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

  // Stable callback for follow-on chips → run the chip's query as a new message.
  // Uses a ref so ChatMessage's memo isn't busted every render.
  const handleSendRef = useRef(null)
  // `focus` is the chip's own {id, query_type} — the pair it was generated from.
  // Passing it through means a CLICKED suggestion is answered by running the
  // query it names, instead of being re-parsed from its English sentence as if
  // the user had typed it and the id had never been known.
  const handleAskFollowOn = useCallback((query, focus) => {
    if (typeof query === 'string' && query.trim() && handleSendRef.current) handleSendRef.current(query, focus)
  }, [])

  const handleSend = async (messageText = null, focus = null) => {
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
        body: JSON.stringify({
          messages: outboundMessages,
          scene,
          context: contextRef.current || undefined,
          focus: (focus && focus.id && focus.query_type)
            ? { id: focus.id, query_type: focus.query_type }
            : undefined
        })
      })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''
      streamingMsgIdRef.current = null

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
              } else if (currentEvent === 'delta') {
                // Stream synthesis tokens into a single live assistant bubble.
                const chunk = data.text || ''
                if (!chunk) { /* nothing to append */ }
                else if (streamingMsgIdRef.current == null) {
                  const msg = { id: ++msgIdRef.current, role: 'assistant', content: chunk, streaming: true }
                  streamingMsgIdRef.current = msg.id
                  setMessages(prev => [...prev, msg])
                  setThinkingSteps(prev => prev.map(s => ({ ...s, done: true })))
                } else {
                  const id = streamingMsgIdRef.current
                  setMessages(prev => prev.map(m => m.id === id ? { ...m, content: m.content + chunk } : m))
                }
              } else if (currentEvent === 'draft_discarded') {
                // The server abandoned the draft it streamed and is writing a
                // replacement. Deltas accumulate into one bubble, so the
                // replacement would otherwise be appended to the draft and the
                // reader would see the answer twice. Drop the bubble and clear
                // the ref, so the next delta opens a fresh one. The status line
                // the server sends alongside this says what is happening.
                const discardedId = streamingMsgIdRef.current
                if (discardedId != null) {
                  setMessages(prev => prev.filter(m => m.id !== discardedId))
                  streamingMsgIdRef.current = null
                }
                setIsThinking(true)
              } else if (currentEvent === 'result') {
                // Finalise: replace the streamed bubble (linkified, with images/graphs)
                // or, if nothing streamed, append a fresh assistant message.
                const finalMsg = makeMsg('assistant', data.response, {
                  images: data.images,
                  graphs: data.graphs,
                  tables: data.tables,
                  followOns: data.followOns,
                  sources: data.sources,
                  terms: data.terms,
                  requestId: data.requestId,
                  responseId: data.responseId
                })
                const streamId = streamingMsgIdRef.current
                if (streamId != null) {
                  setMessages(prev => prev.map(m => m.id === streamId
                    ? { ...finalMsg, id: streamId }
                    : m))
                } else {
                  setMessages(prev => [...prev, finalMsg])
                }
                streamingMsgIdRef.current = null
                // Keep the merged context for the next turn. Only ever replaced
                // by a fresh one — a result event that omits it (an older server,
                // a clarification path that did not reach the harness) must not
                // wipe what the conversation already knows.
                if (data.context) contextRef.current = data.context
                if (data.newScene) setScene(data.newScene)
                setIsThinking(false)
                fetchRateInfo()
                return
              } else if (currentEvent === 'error') {
                streamingMsgIdRef.current = null
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
  // Keep the ref pointing at the latest handleSend for follow-on chips.
  handleSendRef.current = handleSend

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

  const renderLink = ({ href, children, title: mdTitle }) => {
    const normalizedHref = normalizeMarkdownHref(href)
    let url = normalizedHref
    let title = mdTitle   // honour the markdown link's own title (hover tooltip)
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
      {/* role="log" USED to be on this element and was overriding the main
          landmark: an explicit role replaces the implicit one, so the page had
          no <main> for a screen-reader user to skip to, and axe reported both
          aria-allowed-role and landmark-one-main. aria-live and aria-label are
          allowed on main and do the announcing job on their own, so the role
          simply goes. */}
      <main
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
            onAskFollowOn={handleAskFollowOn}
          />
        ))}
        {/* One feedback prompt for the whole conversation (latest assistant reply). */}
        {!isThinking && (() => {
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.requestId && m.responseId)
          if (!lastAssistant) return null
          return (
            <FeedbackPrompt
              msg={lastAssistant}
              feedbackState={feedbackStateByResponseId[lastAssistant.responseId]}
              onSubmitHelpful={handleSubmitHelpful}
              onSelectNeedsWork={handleSelectNeedsWork}
              onSubmitFeedbackReason={handleSubmitFeedbackReason}
              onToggleIncludeConversation={handleToggleIncludeConversation}
            />
          )
        })()}
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

      {/* A labelled section is a region landmark, so the question box is
          reachable by landmark navigation instead of sitting outside every
          landmark on the page — which is what axe's `region` findings were.
          Same styles, same layout; only the element and the label are new. */}
      <section aria-label="Ask a question" style={{
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
        {/* WCAG 2.2 AA, SC 1.4.3. White at 0.4 opacity composites to #666 on
            black — 3.66:1 against the 4.5:1 this 10px text needs. Dimming with
            opacity is what hides that: the declared colour still reads as #fff.
            A solid #999 is 7.37:1 and looks the same.

            The aria-label also moved. On a plain <div> with no role, aria-label
            is prohibited (ARIA 1.2) and support is inconsistent, so the fuller
            sentence now lives in the visually-hidden span this page already has
            a class for, and the terse "0/10000" is hidden from assistive tech
            rather than read twice. */}
        <div
          style={{
            fontSize: '10px',
            color: '#999',
            fontFamily: 'monospace',
            whiteSpace: 'nowrap'
          }}
        >
          <span aria-hidden="true">{`${rateInfo.used}/${rateInfo.limit}`}</span>
          <span className="sr-only">{`${rateInfo.used} of ${rateInfo.limit} daily queries used`}</span>
        </div>
        <button
          onClick={handleSend}
          disabled={isThinking}
          aria-label={isThinking ? 'Sending message, please wait' : 'Send message'}
          style={{
            padding: '10px 20px',
            // WCAG 2.2 AA, SC 1.4.3. White on #4a9eff is 2.75:1, and 14px at
            // weight 600 is not large text, so it needs 4.5:1. #1565c0 is the
            // same blue a couple of steps darker and gives 5.75:1. The disabled
            // #333 was already fine at 12.6:1.
            backgroundColor: isThinking ? '#333' : '#1565c0',
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
      </section>

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

      {/* AI notice and policy links — shared with /privacy, /accessibility, /terms */}
      <SiteFooter variant="app" />

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
