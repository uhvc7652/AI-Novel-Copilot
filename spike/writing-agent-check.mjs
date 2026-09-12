/**
 * Smoke test for the isolated writing agent.
 *
 * Starts a run through the plugin's own route and polls it, so a failure in
 * `agents.create`, the scoped system-prompt section, the tool restriction, the
 * subagent classification, or the child's own `followup` shows up as text rather
 * than as a silent blank panel. Usage: node spike/writing-agent-check.mjs <base>
 * <token> <sessionId>
 *
 * The run this starts is a one-shot subagent child of `<sessionId>`, so the
 * check also proves the fix for "历史加载失败: session not found": the child must
 * not appear as an ordinary session in the author's list (its header carries
 * `origin: 'subagent'`).
 */
const [base, token, sessionId] = process.argv.slice(2)
if (base === undefined || token === undefined || sessionId === undefined) {
  throw new Error('usage: node spike/writing-agent-check.mjs <base> <token> <sessionId>')
}

const index = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const cookie = (index.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
const headers = { 'content-type': 'application/json', cookie }

const started = await fetch(`${base}/api/novel/task`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ sessionId, prompt: '只输出两个字：接通', label: '烟雾测试' }),
})
const startBody = await started.json()
console.log(`start [${String(started.status)}]:`, JSON.stringify(startBody).slice(0, 200))
if (startBody.ok !== true) process.exit(1)

const runId = startBody.runId
let sent = 0
for (let attempt = 0; attempt < 80; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 1000))
  const polled = await fetch(`${base}/api/novel/task?runId=${encodeURIComponent(runId)}`, { headers: { cookie } })
  const body = await polled.json()
  if (body.ok !== true) {
    console.log(`poll [${String(polled.status)}]:`, JSON.stringify(body).slice(0, 200))
    process.exit(1)
  }
  const run = body.run
  if (run.text.length > sent) {
    console.log(`+${String(run.text.length - sent)} chars:`, JSON.stringify(run.text.slice(sent, sent + 120)))
    sent = run.text.length
  }
  if (run.done) {
    console.log('done. reason:', run.reason ?? '(none)', '| error:', run.error ?? '(none)')
    console.log('full text:', JSON.stringify(run.text))
    process.exit(run.error === undefined ? 0 : 1)
  }
}
console.log('TIMEOUT after 80s; last text:', JSON.stringify(sent))
process.exit(1)
