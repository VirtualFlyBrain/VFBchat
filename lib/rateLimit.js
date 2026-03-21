import fs from 'fs'
import path from 'path'

const DATA_DIR = process.env.RATE_LIMIT_DATA_DIR || path.join(process.cwd(), 'data')
const DATA_FILE = path.join(DATA_DIR, 'rate-limits.json')
export const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_IP) || 50

function readData() {
  const today = new Date().toISOString().slice(0, 10)
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data.date !== today) {
      return { date: today, ips: {} }
    }
    return data
  } catch {
    return { date: today, ips: {} }
  }
}

function writeData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8')
  fs.renameSync(tmp, DATA_FILE)
}

export function checkAndIncrement(clientIp) {
  const data = readData()
  const used = data.ips[clientIp] || 0
  if (used >= RATE_LIMIT) {
    return { allowed: false, used, limit: RATE_LIMIT }
  }
  data.ips[clientIp] = used + 1
  writeData(data)
  return { allowed: true, used: used + 1, limit: RATE_LIMIT }
}

export function getRateInfo(clientIp) {
  const data = readData()
  const used = data.ips[clientIp] || 0
  return { used, limit: RATE_LIMIT, remaining: RATE_LIMIT - used }
}
