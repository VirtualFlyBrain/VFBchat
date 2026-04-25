#!/usr/bin/env node

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(__filename), '..')

const PROVENANCE_PROMPT = `Answer the following question about Drosophila neuroscience. For every claim you make, state where the information comes from - for example: the specific database, dataset, or tool query you used; the publication (with full citation); or your general training knowledge. If you are uncertain or do not have a source, say so explicitly rather than guessing.`

function parseArgs(argv) {
  const options = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue

    const [rawName, inlineValue] = arg.slice(2).split('=', 2)
    const name = rawName.trim()
    const value = inlineValue !== undefined ? inlineValue : argv[i + 1]

    if (name === 'dry-run') {
      options.dryRun = true
    } else if (name === 'start-server') {
      options.startServer = true
    } else if (name === 'no-start-server') {
      options.startServer = false
    } else if (name === 'help') {
      options.help = true
    } else {
      if (inlineValue === undefined) i += 1
      options[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    }
  }

  return options
}

function printHelp() {
  console.log(`Usage:
  npm run benchmark:task-battery -- [options]

Options:
  --task-file <path>          Markdown task battery. Defaults to TASK_BATTERY_FILE or ../vfb-paper/task_battery.md.
  --base-url <url>            Existing VFBchat server. If omitted, the runner starts a local server.
  --start-server              Start a local server even when --base-url is supplied.
  --no-start-server           Use --base-url without starting a server.
  --server-command <dev|start> Server command for local runs. Default: dev.
  --port <number>             Local server port. Default: 3210.
  --repetitions <number>      Repetitions per question. Default: 1.
  --limit <number>            Limit number of selected tasks.
  --ids <csv>                 Comma-separated task IDs, e.g. T1.1,T3.4.
  --tier <number>             Run a single tier, e.g. 1.
  --out <path>                Output JSON path. Default: test-results/task-battery/<run-id>.json.
  --output-dir <path>         Output directory. Default: test-results/task-battery.
  --timeout-ms <number>       Per-question timeout. Default: 300000.
  --dry-run                   Parse and list selected tasks without calling the server.`)
}

function envOrOption(options, optionName, envName, defaultValue = '') {
  return options[optionName] ?? process.env[envName] ?? defaultValue
}

function normalizeInteger(value, defaultValue, min, max) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return defaultValue
  return Math.min(Math.max(parsed, min), max)
}

function candidateTaskFiles(options) {
  return [
    options.taskFile,
    process.env.TASK_BATTERY_FILE,
    process.env.VFB_TASK_BATTERY_FILE,
    path.join(REPO_ROOT, '..', 'vfb-paper', 'task_battery.md'),
    path.join(REPO_ROOT, 'vfb-paper', 'task_battery.md'),
    path.join(REPO_ROOT, 'tests', 'task-battery', 'task_battery.md')
  ].filter(Boolean)
}

function resolveExistingFile(candidates) {
  for (const candidate of candidates) {
    const resolved = path.resolve(REPO_ROOT, candidate)
    if (fsSync.existsSync(resolved)) return resolved
  }
  return null
}

function parseTaskBattery(markdown) {
  const headingRegex = /^###\s+(T\d+\.\d+)\s+[—-]\s+(.+)$/gm
  const headings = []
  let match

  while ((match = headingRegex.exec(markdown)) !== null) {
    headings.push({
      id: match[1],
      title: match[2].trim(),
      start: match.index,
      bodyStart: headingRegex.lastIndex
    })
  }

  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? markdown.length
    const body = markdown.slice(heading.bodyStart, end)
    const question = body.match(/\*\*Question\*\*:\s*["“]([^"”\n]+)["”]/)?.[1]?.trim()

    if (!question) {
      throw new Error(`Could not parse question for ${heading.id}`)
    }

    return {
      id: heading.id,
      tier: Number.parseInt(heading.id.match(/^T(\d+)/)?.[1] || '0', 10),
      title: heading.title,
      question
    }
  })
}

function selectTasks(tasks, options) {
  let selected = tasks
  const ids = String(options.ids || process.env.TASK_BATTERY_IDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)

  if (ids.length > 0) {
    const idSet = new Set(ids)
    selected = selected.filter(task => idSet.has(task.id))
  }

  const tier = Number.parseInt(options.tier || process.env.TASK_BATTERY_TIER || '', 10)
  if (Number.isFinite(tier)) {
    selected = selected.filter(task => task.tier === tier)
  }

  const limit = Number.parseInt(options.limit || process.env.TASK_BATTERY_LIMIT || '', 10)
  if (Number.isFinite(limit) && limit > 0) {
    selected = selected.slice(0, limit)
  }

  return selected
}

function getGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    }).trim()
  } catch {
    return null
  }
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

async function waitForServer(baseUrl, timeoutMs = 90000, serverProcess = null) {
  const startedAt = Date.now()
  const healthUrl = new URL('/api/rate-info', baseUrl)
  let lastError = null
  let serverExit = null

  const onExit = (code, signal) => {
    serverExit = { code, signal }
  }

  if (serverProcess) {
    serverProcess.once('exit', onExit)
  }

  while (Date.now() - startedAt < timeoutMs) {
    if (serverExit) {
      if (serverProcess) serverProcess.off('exit', onExit)
      throw new Error(`Server exited before health check passed (code ${serverExit.code}, signal ${serverExit.signal || 'none'}).`)
    }

    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        if (serverProcess) serverProcess.off('exit', onExit)
        return
      }
      lastError = new Error(`Health check returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }

    await new Promise(resolve => setTimeout(resolve, 1000))
  }

  if (serverProcess) serverProcess.off('exit', onExit)
  throw new Error(`Timed out waiting for ${healthUrl}. Last error: ${lastError?.message || 'unknown'}`)
}

function startServer({ port, command, runId }) {
  const args = command === 'start'
    ? ['run', 'start', '--', '-p', String(port), '-H', '127.0.0.1']
    : ['run', 'dev', '--', '-p', String(port), '-H', '127.0.0.1']

  const child = spawn('npm', args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RATE_LIMIT_PER_IP: process.env.RATE_LIMIT_PER_IP || '10000',
      LOG_ROOT_DIR: process.env.LOG_ROOT_DIR || path.join('/tmp', `vfbchat-task-battery-logs-${runId}`)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  child.stdout.on('data', chunk => process.stdout.write(`[server] ${chunk}`))
  child.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`))

  return child
}

function stopServer(child) {
  if (!child || child.killed) return
  child.kill('SIGTERM')
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/)
  let event = 'message'
  const dataLines = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  const rawData = dataLines.join('\n')
  let data = rawData
  try {
    data = JSON.parse(rawData)
  } catch {
    // Keep raw SSE data when it is not JSON.
  }

  return { event, data }
}

async function readSseResponse(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response did not include a readable body')

  const decoder = new TextDecoder()
  let buffer = ''
  const statuses = []
  let eventCount = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')

    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim()
      buffer = buffer.slice(boundary + 2)

      if (block) {
        const parsed = parseSseBlock(block)
        eventCount += 1

        if (parsed.event === 'status') {
          statuses.push(parsed.data)
        } else if (parsed.event === 'result') {
          return { ok: true, result: parsed.data, statuses, eventCount }
        } else if (parsed.event === 'error') {
          return { ok: false, error: parsed.data, statuses, eventCount }
        }
      }

      boundary = buffer.indexOf('\n\n')
    }
  }

  throw new Error('SSE stream ended without a result or error event')
}

async function runWithTimeout(work, timeoutMs) {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), timeoutMs)

  try {
    return await work(abortController.signal)
  } finally {
    clearTimeout(timeout)
  }
}

async function askQuestion(baseUrl, task, repetition, timeoutMs, runId) {
  const startedAt = Date.now()
  const chatUrl = new URL('/api/chat', baseUrl)

  return runWithTimeout(async (signal) => {
    const response = await fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `task-battery-${runId}`
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: PROVENANCE_PROMPT },
          { role: 'user', content: task.question }
        ],
        scene: {}
      }),
      signal
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`)
    }

    const parsed = await readSseResponse(response)
    const durationMs = Date.now() - startedAt

    if (!parsed.ok) {
      return {
        task_id: task.id,
        tier: task.tier,
        title: task.title,
        question: task.question,
        repetition,
        ok: false,
        duration_ms: durationMs,
        status_messages: parsed.statuses,
        event_count: parsed.eventCount,
        error: parsed.error?.message || parsed.error || 'Unknown SSE error',
        request_id: parsed.error?.requestId || null,
        response_id: parsed.error?.responseId || null
      }
    }

    return {
      task_id: task.id,
      tier: task.tier,
      title: task.title,
      question: task.question,
      repetition,
      ok: true,
      duration_ms: durationMs,
      status_messages: parsed.statuses,
      event_count: parsed.eventCount,
      request_id: parsed.result?.requestId || null,
      response_id: parsed.result?.responseId || null,
      images_count: Array.isArray(parsed.result?.images) ? parsed.result.images.length : 0,
      graphs_count: Array.isArray(parsed.result?.graphs) ? parsed.result.graphs.length : 0,
      response: parsed.result?.response || ''
    }
  }, timeoutMs)
}

function summariseResults(results) {
  const ok = results.filter(result => result.ok).length
  const errors = results.length - ok
  const byTier = {}

  for (const result of results) {
    const key = `T${result.tier}`
    byTier[key] = byTier[key] || { total: 0, ok: 0, errors: 0 }
    byTier[key].total += 1
    if (result.ok) byTier[key].ok += 1
    else byTier[key].errors += 1
  }

  return {
    total: results.length,
    ok,
    errors,
    by_tier: byTier,
    mean_duration_ms: results.length
      ? Math.round(results.reduce((sum, result) => sum + (result.duration_ms || 0), 0) / results.length)
      : 0
  }
}

async function writeResults(payload, options, runId) {
  const outputDir = path.resolve(REPO_ROOT, options.outputDir || process.env.VFBCHAT_BENCHMARK_OUTPUT_DIR || 'test-results/task-battery')
  const outputFile = path.resolve(REPO_ROOT, options.out || path.join(outputDir, `${runId}.json`))
  const latestFile = path.join(outputDir, 'latest.json')

  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  if (outputFile !== latestFile) {
    await fs.mkdir(outputDir, { recursive: true })
    await fs.writeFile(latestFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }

  return { outputFile, latestFile }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const taskFile = resolveExistingFile(candidateTaskFiles(options))
  if (!taskFile) {
    throw new Error(`Could not find task_battery.md. Checked: ${candidateTaskFiles(options).join(', ')}`)
  }

  const markdown = await fs.readFile(taskFile, 'utf8')
  const tasks = parseTaskBattery(markdown)
  const selectedTasks = selectTasks(tasks, options)
  const repetitions = normalizeInteger(envOrOption(options, 'repetitions', 'TASK_BATTERY_REPETITIONS', '1'), 1, 1, 10)
  const timeoutMs = normalizeInteger(envOrOption(options, 'timeoutMs', 'TASK_BATTERY_TIMEOUT_MS', '300000'), 300000, 30000, 1800000)
  const startedAt = new Date()
  const runId = `task-battery-${timestampForFile(startedAt)}`

  if (selectedTasks.length === 0) {
    throw new Error('No tasks selected.')
  }

  if (options.dryRun) {
    console.log(`Parsed ${tasks.length} tasks from ${taskFile}. Selected ${selectedTasks.length}:`)
    for (const task of selectedTasks) {
      console.log(`${task.id} T${task.tier} - ${task.title}: ${task.question}`)
    }
    return
  }

  const suppliedBaseUrl = envOrOption(options, 'baseUrl', 'VFBCHAT_BENCHMARK_BASE_URL', '')
  const shouldStartServer = options.startServer ?? !suppliedBaseUrl
  const port = normalizeInteger(envOrOption(options, 'port', 'VFBCHAT_BENCHMARK_PORT', '3210'), 3210, 1024, 65535)
  const serverCommand = envOrOption(options, 'serverCommand', 'VFBCHAT_BENCHMARK_SERVER_COMMAND', 'dev')
  const baseUrl = suppliedBaseUrl || `http://127.0.0.1:${port}`
  let server = null

  const payload = {
    metadata: {
      run_id: runId,
      started_at: startedAt.toISOString(),
      completed_at: null,
      git_sha: getGitSha(),
      task_file: taskFile,
      base_url: baseUrl,
      started_server: shouldStartServer,
      server_command: shouldStartServer ? serverCommand : null,
      repetitions,
      timeout_ms: timeoutMs
    },
    prompt: {
      provenance_instruction: PROVENANCE_PROMPT
    },
    summary: null,
    results: []
  }

  try {
    if (shouldStartServer) {
      server = startServer({ port, command: serverCommand, runId })
      await waitForServer(baseUrl, 90000, server)
    }

    console.log(`Running ${selectedTasks.length} task(s) x ${repetitions} repetition(s) against ${baseUrl}`)

    for (const task of selectedTasks) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const label = `${task.id} rep ${repetition}/${repetitions}`
        process.stdout.write(`${label} ... `)

        try {
          const result = await askQuestion(baseUrl, task, repetition, timeoutMs, runId)
          payload.results.push(result)
          console.log(result.ok ? `ok (${result.duration_ms} ms)` : `error (${result.duration_ms} ms)`)
        } catch (error) {
          payload.results.push({
            task_id: task.id,
            tier: task.tier,
            title: task.title,
            question: task.question,
            repetition,
            ok: false,
            duration_ms: null,
            error: error?.name === 'AbortError'
              ? `Timed out after ${timeoutMs} ms`
              : error?.message || 'Unknown error'
          })
          console.log('error')
        }
      }
    }
  } finally {
    stopServer(server)
  }

  payload.metadata.completed_at = new Date().toISOString()
  payload.summary = summariseResults(payload.results)

  const { outputFile, latestFile } = await writeResults(payload, options, runId)
  console.log(`Wrote ${outputFile}`)
  console.log(`Updated ${latestFile}`)

  if (payload.summary.errors > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error?.stack || error?.message || error)
  process.exitCode = 1
})
