/**
 * End-to-end check of the plugin's host half against a running DSH instance.
 *
 * Usage: node spike/host-api-check.mjs <base-url> <token> <project-root>
 *
 * The token is exchanged for the session cookie the browser would hold, so the
 * calls exercise the same authenticated `/api` channel the panel uses.
 */
const [base, token, root] = process.argv.slice(2)
if (base === undefined || token === undefined || root === undefined) {
  throw new Error('usage: node spike/host-api-check.mjs <base-url> <token> <project-root>')
}

let cookie = ''
const results = []

/** Call one route and report the outcome. */
async function call(label, path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie === '' ? {} : { cookie }) },
  })
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = text
  }
  results.push({ label, status: response.status, value })
  return { status: response.status, value }
}

/** POST a JSON body. */
function post(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

// Exchange the launch token for the auth cookie, exactly as the browser does.
const index = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
const setCookie = index.headers.getSetCookie?.() ?? []
cookie = setCookie.map(entry => entry.split(';')[0]).join('; ')
console.log(`auth: index ${String(index.status)}, cookie ${cookie === '' ? 'MISSING' : 'acquired'}`)

const scope = `sessionId=${encodeURIComponent('unknown-session')}&root=${encodeURIComponent(root)}`

await call('ping', '/api/novel/ping?sessionId=unknown-session')
await call('project before init', `/api/novel/project?${scope}`)
await call('init', '/api/novel/project', post({ sessionId: 'unknown-session', root, title: '测试之书' }))
await call('project after init', `/api/novel/project?${scope}`)
await call('chapter read', `/api/novel/chapter?${scope}&path=${encodeURIComponent('chapters/v01/c0001.md')}`)
await call('chapter write', '/api/novel/chapter', post({
  sessionId: 'unknown-session',
  root,
  path: 'chapters/v01/c0001.md',
  data: { id: 'c0001', volume: 1, number: 1, title: '楔子·雨夜', status: 'draft', targetWords: 3000 },
  body: '雨下了一整夜。\n\n陈默把半块青铜镜攥在手心，指节发白。\n',
}))
await call('chapter create', '/api/novel/chapter', post({
  sessionId: 'unknown-session',
  root,
  create: { volume: 1, title: '第二章 巡夜人' },
}))
await call('chapter create from plan', '/api/novel/chapter', post({
  sessionId: 'unknown-session',
  root,
  create: {
    volume: 1,
    title: '第三章 青铜镜',
    beats: ['陈默研究青铜镜', '巡夜人上门'],
    characters: ['chen-mo'],
    locations: ['qingshi-town'],
    summary: '青铜镜第一次显异。',
  },
}))
await call('cards', `/api/novel/cards?${scope}`)
await call('card create', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  createCard: { type: 'character', id: 'chen-mo', name: '陈默' },
}))
await call('card create duplicate', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  createCard: { type: 'character', id: 'chen-mo', name: '陈默' },
}))
await call('card create bad id', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  createCard: { type: 'character', id: '陈默', name: '陈默' },
}))
await call('card read', `/api/novel/doc?${scope}&path=${encodeURIComponent('settings/characters/chen-mo.md')}`)
await call('card write', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  path: 'settings/characters/chen-mo.md',
  data: { id: 'chen-mo', type: 'character', name: '陈默', aliases: ['默哥'], role: '主角' },
  body: '\n## 外貌\n十九岁，瘦。\n',
}))
await call('card archive', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  path: 'settings/characters/chen-mo.md',
  data: { id: 'chen-mo', type: 'character', name: '陈默', archived: true },
  body: '\n## 外貌\n十九岁，瘦。\n',
}))
await call('cards after archive', `/api/novel/cards?${scope}`)
await call('search a question', `/api/novel/search?${scope}&q=${encodeURIComponent('陈默上次出场在哪')}`)
await call('search a keyword', `/api/novel/search?${scope}&q=${encodeURIComponent('青铜镜')}`)
await call('search blank', `/api/novel/search?${scope}&q=`)
await call('checks', `/api/novel/checks?${scope}`)
await call('checks ignore one', '/api/novel/checks', post({
  sessionId: 'unknown-session',
  root,
  action: 'ignore',
  key: 'archived-ref:chapters/v01/c0003.md:chen-mo',
}))
await call('checks save report', '/api/novel/checks', post({
  sessionId: 'unknown-session',
  root,
  action: 'save',
}))
await call('checks bad action', '/api/novel/checks', post({
  sessionId: 'unknown-session',
  root,
  action: 'explode',
}))
await call('outline write', '/api/novel/doc', post({
  sessionId: 'unknown-session',
  root,
  path: 'outline/volumes/v01.md',
  data: {},
  body: '# 第一卷\n\n## 卷目标\n陈默在青石镇立足。\n',
}))
await call('outline read back', `/api/novel/doc?${scope}&path=${encodeURIComponent('outline/volumes/v01.md')}`)
await call('doc rejects novel.yaml', `/api/novel/doc?${scope}&path=${encodeURIComponent('novel.yaml')}`)
await call('doc rejects escape', `/api/novel/doc?${scope}&path=${encodeURIComponent('../../etc/hosts.md')}`)
await call('dir settings', `/api/novel/dir?${scope}&path=${encodeURIComponent('settings/characters')}`)
await call('dir absent', `/api/novel/dir?${scope}&path=${encodeURIComponent('settings/items')}`)
// P5's export: the preview (GET) and the write (POST) must agree, and an export
// is not a document — the list of what it wrote is the only record of it.
await call('export preview md', `/api/novel/export?${scope}&format=md&scope=book`)
await call('export preview txt', `/api/novel/export?${scope}&format=txt&scope=book`)
await call('export preview volume', `/api/novel/export?${scope}&format=md&scope=volume&volume=1`)
await call('export write', '/api/novel/export', post({
  sessionId: 'unknown-session',
  root,
  format: 'md',
  scope: 'book',
}))
await call('export missing chapter', '/api/novel/export', post({
  sessionId: 'unknown-session',
  root,
  format: 'md',
  scope: 'chapter',
  path: 'chapters/v01/c9999.md',
}))
await call('export volume without a volume', '/api/novel/export', post({
  sessionId: 'unknown-session',
  root,
  format: 'md',
  scope: 'volume',
}))
await call('dir exports', `/api/novel/dir?${scope}&path=${encodeURIComponent('exports')}`)
await call('no history for exports', `/api/novel/dir?${scope}&path=${encodeURIComponent('.novel/history/exports')}`)
await call('project after cards', `/api/novel/project?${scope}`)
await call('read back', `/api/novel/chapter?${scope}&path=${encodeURIComponent('chapters/v01/c0001.md')}`)
await call('escape guard', `/api/novel/chapter?${scope}&path=${encodeURIComponent('../../etc/passwd')}`)
await call('missing chapter', `/api/novel/chapter?${scope}&path=${encodeURIComponent('chapters/v01/c9999.md')}`)

for (const { label, status, value } of results) {
  const compact = typeof value === 'string' ? value.slice(0, 120) : JSON.stringify(value)
  console.log(`\n[${String(status)}] ${label}\n  ${(compact ?? '').slice(0, 400)}`)
}
