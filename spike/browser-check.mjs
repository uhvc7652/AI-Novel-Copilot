/**
 * Headless browser check for the P0-0 spike.
 *
 * Chrome is launched by this script with a TCP debugging port and connected
 * over CDP: the sandbox blocks the named pipes Playwright's own launcher uses,
 * but a plain WebSocket connection to an already-running browser is fine.
 *
 * Usage: node spike/browser-check.mjs <url>
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PROFILE = 'E:/GameProject/AI-Novel-Copilot/.spike-chrome'
const PORT = 9333

// Playwright is not a dependency of this package; it is resolved out of the
// DSH checkout's pnpm store, which is where the only copy on this machine lives.
const require = createRequire('E:/GameProject/deepseek-harness/package.json')
const { chromium } = require('E:/GameProject/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright')

const url = process.argv[2]
if (url === undefined) throw new Error('usage: node spike/browser-check.mjs <url>')

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' })

/** Poll the CDP endpoint until Chrome is listening. */
async function waitForCdp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('chrome CDP endpoint never came up')
}

try {
  const version = await waitForCdp()
  console.log(`chrome: ${String(version.Browser)}`)
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl)
  const context = browser.contexts()[0]
  const page = await context.newPage()

  const problems = []
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => { problems.push(`pageerror: ${error.message}`) })

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(6000)

  const report = await page.evaluate(() => {
    const boot = globalThis.__DSH_BOOT__
    const ids = boot === undefined ? [] : boot.entries.map(entry => entry.id)
    return {
      title: document.title,
      bodyText: document.body.innerText.slice(0, 4000),
      bootHasUs: ids.includes('dsh-ai-novel-copilot'),
      entryCount: ids.length,
    }
  })

  console.log(`boot graph has dsh-ai-novel-copilot: ${String(report.bootHasUs)} (entries: ${String(report.entryCount)})`)
  console.log(`page found our tab label 小说: ${String(report.bodyText.includes('小说'))}`)
  console.log(`page found our guide copy 小说写作台: ${String(report.bodyText.includes('小说写作台'))}`)
  console.log('--- page text (first 1200 chars) ---')
  console.log(report.bodyText.slice(0, 1200))
  console.log('--- problems ---')
  console.log(problems.length === 0 ? '(none)' : problems.join('\n'))

  await browser.close()
} finally {
  chrome.kill()
}
