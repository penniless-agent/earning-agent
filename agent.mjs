/**
 * Always-on earning agent — runs on GitHub Actions cron (GitHub's servers, alive when the
 * home box is off). Dependency-free: Node 20+ global fetch only. Each run:
 *   1. reads on-chain balances of our receive-only wallets (real earnings show up here)
 *   2. scans Superteam's agent listings for new/open bounties we could win
 *   3. checks the paid x402 service is alive AND still serving the money path (402 gate)
 *   4. writes a timestamped status.md + appends history.jsonl, which the workflow commits
 *
 * Secrets (GitHub repo -> Settings -> Secrets): SUPERTEAM_API_KEY (optional; scan skipped without it).
 * No private keys ever live here — this process only READS. Earning/spending stays offline.
 */
import { writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs'

const EVM_WALLET = '0x335c177596Fd8E51C214B6B27C4Ded6E885dBf0B' // Base USDC receive-only
const SOL_WALLET = 'FWNiJ69gf9xESrSSwf22tkEU3qrYqiGUZBKAw7sogWg4' // Solana USDC + native SOL receive-only
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL_RPC = 'https://api.mainnet-beta.solana.com'
const SERVICE = 'https://token-intel-x402.meisburply.deno.net'
const now = new Date().toISOString()

async function baseUsdc() {
  try {
    const r = await fetch('https://mainnet.base.org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: BASE_USDC, data: '0x70a08231000000000000000000000000' + EVM_WALLET.slice(2) }, 'latest'],
      }),
    })
    const j = await r.json()
    return Number(BigInt(j.result || '0x0')) / 1e6
  } catch (e) { return `err:${e.message}` }
}

async function solUsdc() {
  try {
    const r = await fetch(SOL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
        params: [SOL_WALLET, { mint: SOL_USDC }, { encoding: 'jsonParsed' }],
      }),
    })
    const j = await r.json()
    return (j?.result?.value ?? []).reduce((s, a) => s + (Number(a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount) || 0), 0)
  } catch (e) { return `err:${e.message}` }
}

async function solNative() {
  try {
    const r = await fetch(SOL_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [SOL_WALLET] }),
    })
    const j = await r.json()
    return (j?.result?.value ?? 0) / 1e9
  } catch (e) { return `err:${e.message}` }
}

async function superteamLive() {
  const key = process.env.SUPERTEAM_API_KEY
  if (!key) return { skipped: 'no SUPERTEAM_API_KEY secret' }
  try {
    const r = await fetch('https://superteam.fun/api/agents/listings/live?take=50', {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!r.ok) return { error: `HTTP ${r.status}` }
    const d = await r.json()
    const items = Array.isArray(d) ? d : d.result || []
    const open = items.filter((l) => (l.deadline || '9999') > now)
      // agentAccess is the competition signal: AGENT_ONLY listings are hidden from human feeds,
      // so they are the highest-odds money. Surface access + reward so a low-competition
      // high-value drop is obvious the moment it lands.
      .map((l) => ({ slug: l.slug, type: l.type, reward: l.rewardAmount, token: l.token, access: l.agentAccess, deadline: (l.deadline || '').slice(0, 10) }))
      .sort((a, b) => (b.access === 'AGENT_ONLY' ? 1 : 0) - (a.access === 'AGENT_ONLY' ? 1 : 0) || (b.reward || 0) - (a.reward || 0))
    return { total: items.length, open }
  } catch (e) { return { error: e.message } }
}

async function serviceHealth() {
  try {
    const r = await fetch(`${SERVICE}/healthz`, { signal: AbortSignal.timeout(10000) })
    return r.ok ? 'live' : `down (HTTP ${r.status})`
  } catch (e) { return `unreachable: ${e.message}` }
}

// Verify the actual PAID route, not just /healthz: an unpaid GET must return 402 with a payment
// challenge. This is the money path — if it 404s/500s we are silently losing every sale, which a
// liveness ping on the free route would never catch. The unpaid probe costs nothing (no settlement).
async function paidRouteHealth() {
  try {
    const r = await fetch(`${SERVICE}/api/token-intel?mint=DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`, { signal: AbortSignal.timeout(10000) })
    if (r.status === 402 && r.headers.get('payment-required')) return 'gate-ok (402 challenge served)'
    return `BROKEN (HTTP ${r.status}) — sales path down`
  } catch (e) { return `unreachable: ${e.message}` }
}

// The /demo route runs the FULL intel pipeline for free — probing it catches silent upstream API
// drift that the 402 gate probe can't see (the gate never runs intel). Also probes MCP tools/list.
async function intelPipelineHealth() {
  try {
    const r = await fetch(`${SERVICE}/api/token-intel/demo`, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return `demo BROKEN (HTTP ${r.status}) — intel pipeline down`
    const d = await r.json()
    if (d?.safety?.score == null) return 'demo responds but intel shape wrong — pipeline degraded'
    let mcp = 'mcp-down'
    try {
      const m = await fetch(`${SERVICE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), signal: AbortSignal.timeout(10000) })
      const md = await m.json()
      const names = (md?.result?.tools ?? []).map((x) => x.name)
      mcp = names.includes('token_intel') && names.includes('token_intel_demo') ? 'mcp-ok' : `mcp DEGRADED (tools: ${names.join(',') || 'none'})`
    } catch { /* keep mcp-down */ }
    const sources = 1 + (d.dexScreener ? 1 : 0) + (d.rugCheck ? 1 : 0)
    return `pipeline-ok (demo score ${d.safety.score}, ${sources} sources, ${mcp})`
  } catch (e) { return `demo unreachable: ${e.message}` }
}

const usdc = await baseUsdc()
const solUsdcBal = await solUsdc()
const solNativeBal = await solNative()
const superteam = await superteamLive()
const service = await serviceHealth()
const paidRoute = await paidRouteHealth()
const intelPipeline = await intelPipelineHealth()

// Balance delta vs the previous run — a payment landing is THE profit event, so flag it loudly
// instead of leaving it as a quietly-changed number nobody reads.
let prevUsdc = null, prevSol = null, prevSolNative = null
try {
  const lines = readFileSync(new URL('./history.jsonl', import.meta.url), 'utf8').trim().split('\n')
  if (lines.length) {
    const p = JSON.parse(lines[lines.length - 1])
    if (typeof p.baseUsdc === 'number') prevUsdc = p.baseUsdc
    if (typeof p.solUsdc === 'number') prevSol = p.solUsdc
    if (typeof p.solNative === 'number') prevSolNative = p.solNative
  }
} catch {}
const delta = (typeof usdc === 'number' && typeof prevUsdc === 'number') ? usdc - prevUsdc : 0
const solDelta = (typeof solUsdcBal === 'number' && typeof prevSol === 'number') ? solUsdcBal - prevSol : 0
const solNativeDelta = (typeof solNativeBal === 'number' && typeof prevSolNative === 'number') ? solNativeBal - prevSolNative : 0

// Notify the human ONLY on the transition into a real event (money just landed) — the workflow turns
// this sentinel into a failed run, which GitHub emails the repo owner. Written only on the
// transition, so one event produces one email, not a failure on every subsequent run.
const notify = delta > 0 || solDelta > 0 || solNativeDelta > 0

// remember which listing slugs we have already seen, so we can flag genuinely NEW ones
let seen = []
try { seen = JSON.parse(readFileSync(new URL('./seen-listings.json', import.meta.url), 'utf8')) } catch {}
const openSlugs = (superteam.open || []).map((o) => o.slug)
const fresh = openSlugs.filter((s) => !seen.includes(s))
const freshDetail = (superteam.open || []).filter((o) => fresh.includes(o.slug))
writeFileSync(new URL('./seen-listings.json', import.meta.url), JSON.stringify([...new Set([...seen, ...openSlugs])], null, 0))

const snapshot = { ts: now, baseUsdc: usdc, solUsdc: solUsdcBal, solNative: solNativeBal, delta, solDelta, solNativeDelta, service, paidRoute, intelPipeline, superteam, newListings: fresh }
appendFileSync(new URL('./history.jsonl', import.meta.url), JSON.stringify(snapshot) + '\n')

const md = `# Earning agent status

_Last run: ${now} (UTC), on GitHub Actions._

## Wallet (real earnings land here)
- **Base USDC** \`${EVM_WALLET}\`: **${usdc}**${delta > 0 ? ` · +${delta.toFixed(6)} received since last run!` : ''}
- **Solana USDC** \`${SOL_WALLET}\`: **${solUsdcBal}**${solDelta > 0 ? ` · +${solDelta.toFixed(6)} received since last run!` : ''}
- **Solana native SOL** (same address): **${solNativeBal}**${solNativeDelta > 0 ? ` · +${solNativeDelta.toFixed(9)} SOL received since last run!` : ''}

## Paid service (Solana Token Intelligence, x402)
- ${SERVICE} — service **${service}** · paid-route **${paidRoute}** · intel **${intelPipeline}**

## Open agent listings (Superteam) — AGENT_ONLY first (lowest competition)
${superteam.skipped ? `_scan skipped: ${superteam.skipped}_`
  : superteam.error ? `_scan error: ${superteam.error}_`
  : (superteam.open?.length
      ? superteam.open.map((o) => `- ${o.access === 'AGENT_ONLY' ? '**AGENT_ONLY**' : 'open'} · \`${o.slug}\` — ${o.type} · ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')
      : '_none open right now_')}

${fresh.length ? `## New since last run\n${freshDetail.map((o) => `- ${o.access === 'AGENT_ONLY' ? 'AGENT_ONLY' : 'open'} · \`${o.slug}\` — ${o.reward} ${o.token || ''} · deadline ${o.deadline}`).join('\n')}` : ''}

---
_This file is rewritten by \`agent.mjs\` on every scheduled run. History in \`history.jsonl\`._
`
writeFileSync(new URL('./status.md', import.meta.url), md)

const NOTIFY = new URL('./NOTIFY.txt', import.meta.url)
if (notify) {
  const msg = `PAYMENT RECEIVED (${now}) — ${delta > 0 ? `+${delta.toFixed(6)} USDC on Base (total ${usdc})` : ''}${delta > 0 && solDelta > 0 ? ' + ' : ''}${solDelta > 0 ? `+${solDelta.toFixed(6)} USDC on Solana (total ${solUsdcBal})` : ''}${solNativeDelta > 0 ? ` +${solNativeDelta.toFixed(9)} native SOL (total ${solNativeBal})` : ''}`
  writeFileSync(NOTIFY, msg + '\n')
} else {
  try { unlinkSync(NOTIFY) } catch {}
}

console.log('status:', JSON.stringify(snapshot))
if (delta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${delta.toFixed(6)} USDC landed on Base — total ${usdc}`)
if (solDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solDelta.toFixed(6)} USDC landed on Solana — total ${solUsdcBal}`)
if (solNativeDelta > 0) console.log(`::notice title=PAYMENT RECEIVED::+${solNativeDelta.toFixed(9)} native SOL landed — total ${solNativeBal}`)
if (String(paidRoute).startsWith('BROKEN')) console.log(`::warning title=SALES PATH DOWN::${paidRoute}`)
if (freshDetail.length) console.log('::notice title=NEW LISTINGS::' + freshDetail.map((o) => `${o.slug} (${o.access}, ${o.reward} ${o.token})`).join(' | '))
