'use strict';
/**
 * Playwright backend — opt-in alternative engine (QE_BROWSER_ENGINE=playwright).
 *
 * Speaks the same argv vocabulary as the Vibium CLI so the five QE primitives
 * (assert, batch, visual-diff, check-injection, intent-score) run unchanged on
 * either engine.
 *
 * Statefulness: Vibium keeps a background daemon, so `go`, then `map`, then
 * `click @e1` are separate processes sharing one session. Playwright has no
 * such daemon, so this backend launches a browser *server* on first use and
 * persists its wsEndpoint plus the current ref map to a session file; every
 * later invocation reconnects to that same browser. Without this, each command
 * would start from a blank page and the primitives would silently misbehave.
 *
 * Why it exists: ADR-091 chose Vibium and explicitly declined a runtime
 * fallback, on the assumption that a second engine meant re-implementing the QE
 * primitives. It does not — the primitives sit on ~14 argv verbs, which is what
 * this file implements. Air-gapped and proxy-restricted hosts cannot fetch
 * Chrome for Testing, and this gives them a working engine.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ENGINE_ID = 'playwright';

const SESSION_DIR = process.env.QE_BROWSER_SESSION_DIR || path.join(os.homedir(), '.cache', 'qe-browser');
const SESSION_FILE = path.join(SESSION_DIR, 'playwright-session.json');

class EngineUnavailable extends Error {}

/**
 * Resolve Playwright from wherever it actually lives. Users install it as a
 * peer dependency; this container has it globally. A missing module is an
 * environment gap, reported the same way a missing vibium binary is.
 */
function loadPlaywright() {
  const candidates = [
    'playwright',
    'playwright-core',
    '/opt/node22/lib/node_modules/playwright',
    path.join(process.env.NODE_PATH || '', 'playwright'),
  ].filter(Boolean);
  for (const id of candidates) {
    try {
      return require(id);
    } catch (_err) {
      /* try next */
    }
  }
  throw new EngineUnavailable(
    'Playwright not found. Install it with `npm install -g playwright` (or add it to the project), ' +
      'or unset QE_BROWSER_ENGINE to use the default Vibium engine.'
  );
}

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function writeSession(session) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

/**
 * Connect to the persisted browser server, launching one if absent or stale.
 * Returns { browser, page, session }.
 */
async function connect(pw, { allowLaunch = true } = {}) {
  const existing = readSession();
  if (existing && existing.cdpEndpoint) {
    try {
      const browser = await pw.chromium.connectOverCDP(existing.cdpEndpoint, { timeout: 5000 });
      const context = browser.contexts()[0] || (await browser.newContext());
      const page = context.pages()[0] || (await context.newPage());
      await installRecorders(page);
      return { browser, page, session: existing };
    } catch (_err) {
      // Browser died between invocations — fall through and relaunch.
    }
  }
  if (!allowLaunch) throw new EngineUnavailable('No active Playwright session.');
  return launch(pw);
}

/**
 * Launch a detached Chrome with a CDP port and remember it.
 *
 * CDP rather than Playwright's own `launchServer` + `connect`: for a connected
 * browser, `browser.close()` clears the contexts that connection created, so
 * the page would be destroyed the moment a command finished and the next
 * command would see a blank tab. Over CDP the browser is an independent
 * process, pages belong to it rather than to the client, and disconnecting
 * leaves the session intact — which is what Vibium's daemon provides.
 */
async function launch(pw) {
  const { spawn } = require('node:child_process');
  const net = require('node:net');

  const port = await freePort(net);
  const userDataDir = path.join(SESSION_DIR, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  const executablePath =
    process.env.QE_BROWSER_EXECUTABLE_PATH || pw.chromium.executablePath();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
  ];
  if (process.env.QE_BROWSER_HEADED !== '1') args.push('--headless=new');
  if (process.env.QE_BROWSER_NO_SANDBOX === '1') args.push('--no-sandbox');

  let child;
  try {
    child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    throw new EngineUnavailable(`Playwright could not launch a browser: ${err.message}`);
  }

  const cdpEndpoint = `http://127.0.0.1:${port}`;
  const browser = await waitForCdp(pw, cdpEndpoint, 15000);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  await installRecorders(page);

  const session = { cdpEndpoint, port, pid: child.pid, refs: {}, startedAt: Date.now() };
  writeSession(session);
  return { browser, page, session };
}

function freePort(net) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdp(pw, endpoint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await pw.chromium.connectOverCDP(endpoint, { timeout: 2000 });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new EngineUnavailable(
    `Playwright launched a browser but could not reach its CDP endpoint: ${lastErr && lastErr.message}`
  );
}

/**
 * Record console messages and responses into page-scoped arrays that survive
 * across reconnects, because each CLI invocation is a fresh client process and
 * cannot rely on its own event listeners having been attached earlier.
 */
async function installRecorders(page) {
  await page.addInitScript(() => {
    if (window.__qeRecordersInstalled) return;
    window.__qeRecordersInstalled = true;
    window.__qeConsole = window.__qeConsole || [];
    window.__qeNetwork = window.__qeNetwork || [];
    for (const level of ['error', 'warn', 'log', 'info']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        try {
          window.__qeConsole.push({
            level: level === 'warn' ? 'warning' : level,
            text: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
            timestamp: Date.now(),
          });
        } catch (_e) { /* never break the page */ }
        original(...args);
      };
    }
    window.addEventListener('error', (e) => {
      try {
        window.__qeConsole.push({
          level: 'error',
          text: `${e.message}`,
          stack: e.error && e.error.stack,
          timestamp: Date.now(),
        });
      } catch (_e) { /* ignore */ }
    });
    // Async handlers are the norm in modern front-ends, and a throw inside one
    // surfaces as an unhandled rejection rather than an 'error' event. Missing
    // these would silently drop exactly the failures this tooling exists to
    // catch — an await'd fetch whose response does not match what the code
    // then dereferences.
    window.addEventListener('unhandledrejection', (e) => {
      try {
        const r = e.reason;
        window.__qeConsole.push({
          level: 'error',
          text: r && r.message ? `${r.name || 'Error'}: ${r.message}` : String(r),
          stack: r && r.stack,
          unhandledRejection: true,
          timestamp: Date.now(),
        });
      } catch (_e) { /* ignore */ }
    });
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = async (...args) => {
        const started = Date.now();
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
        try {
          const res = await origFetch(...args);
          window.__qeNetwork.push({
            method, url, status: res.status,
            duration: Date.now() - started, timestamp: started,
          });
          return res;
        } catch (err) {
          window.__qeNetwork.push({
            method, url, status: 0, failed: true,
            error: String(err), timestamp: started,
          });
          throw err;
        }
      };
    }
  });
}

/** Resolve a Vibium-style `@e1` ref, or pass a raw CSS selector through. */
function resolveTarget(target, session) {
  if (typeof target === 'string' && target.startsWith('@')) {
    const sel = session.refs && session.refs[target];
    if (!sel) throw new Error(`unknown ref ${target}; run \`map\` first`);
    return sel;
  }
  return target;
}

/** Build a stable, preferably testid-anchored selector for a mapped element. */
const MAP_SCRIPT = `(() => {
  const out = [];
  const nodes = document.querySelectorAll('a,button,input,select,textarea,[role],[data-testid],[onclick],summary,label');
  let i = 0;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    let selector;
    if (testid) selector = '[data-testid="' + testid + '"]';
    else if (el.id) selector = '#' + CSS.escape(el.id);
    else {
      const parts = [];
      for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
        let s = n.tagName.toLowerCase();
        if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
        const sibs = n.parentElement ? Array.from(n.parentElement.children).filter(c => c.tagName === n.tagName) : [];
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(n) + 1) + ')';
        parts.unshift(s);
      }
      selector = parts.join(' > ');
    }
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    out.push({
      ref: '@e' + (++i),
      tag: el.tagName.toLowerCase(),
      selector,
      text: (el.innerText || el.value || '').trim().slice(0, 200),
      role: el.getAttribute('role') || undefined,
      attributes: attrs,
      visible: r.width > 0 && r.height > 0,
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      disabled: el.disabled === true,
    });
  }
  return JSON.stringify({ elements: out, url: location.href, title: document.title });
})()`;


/**
 * Emit a list under every field name the QE primitives might read.
 *
 * assert.js accepts a bare array or `.entries`; other callers read `.messages`
 * or `.requests`. A shape mismatch here does not error — it reads as an empty
 * list, which turns a failing assertion into a passing one. Emitting all of
 * them keeps that failure mode impossible.
 */
function withEntryAliases(list, alias) {
  const arr = Array.isArray(list) ? list : [];
  const out = { entries: arr };
  out[alias] = arr;
  return out;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Execute one argv command. Mirrors the Vibium CLI vocabulary that batch.js,
 * assert.js, visual-diff.js, check-injection.js and intent-score.js emit.
 */
async function execute(args, { input } = {}) {
  const pw = loadPlaywright();
  const clean = args.filter((a) => a !== '--headless' && a !== '--headed' && a !== '--json');
  const [verb, ...rest] = clean;
  const wantsJson = args.includes('--json');

  const { browser, page, session } = await connect(pw);
  const ok = (value) => ({ status: 0, stdout: wantsJson ? JSON.stringify(value) : String(value ?? ''), stderr: '' });

  try {
    switch (verb) {
      case 'go':
      case 'navigate': {
        await page.goto(rest[0], { waitUntil: 'load', timeout: 30000 });
        return ok({ ok: true, url: page.url(), title: await page.title() });
      }
      case 'map': {
        const selector = flag(clean, '--selector');
        const raw = await page.evaluate(MAP_SCRIPT);
        const parsed = JSON.parse(raw);
        if (selector) parsed.elements = parsed.elements.filter((e) => e.selector.includes(selector));
        session.refs = Object.fromEntries(parsed.elements.map((e) => [e.ref, e.selector]));
        writeSession(session);
        return ok(parsed);
      }
      case 'click': {
        await page.click(resolveTarget(rest[0], session), { timeout: 15000 });
        return ok({ ok: true });
      }
      case 'fill': {
        await page.fill(resolveTarget(rest[0], session), rest[1] ?? '', { timeout: 15000 });
        return ok({ ok: true });
      }
      case 'type': {
        await page.type(resolveTarget(rest[0], session), rest[1] ?? '', { timeout: 15000 });
        return ok({ ok: true });
      }
      case 'press': {
        const [key, target] = rest;
        if (target) await page.press(resolveTarget(target, session), key, { timeout: 15000 });
        else await page.keyboard.press(key);
        return ok({ ok: true });
      }
      case 'wait': {
        const timeout = Number(flag(clean, '--timeout')) || 15000;
        const [kind, value] = rest;
        if (kind === 'url') await page.waitForURL((u) => String(u).includes(value), { timeout });
        else if (kind === 'text') await page.waitForFunction(
          (t) => document.body && document.body.innerText.includes(t), value, { timeout });
        else if (kind === 'load') await page.waitForLoadState('load', { timeout });
        else {
          const state = flag(clean, '--state') || 'visible';
          await page.waitForSelector(resolveTarget(kind, session), { state, timeout });
        }
        return ok({ ok: true, url: page.url() });
      }
      case 'screenshot': {
        // Accept `-o <path>`, `--output <path>`, or a bare positional path:
        // writing to an unexpected location is silent, and the caller then
        // reports 'screenshot failed' when the file simply is not where it looked.
        const positional = rest.find((a) => !a.startsWith('-'));
        const out = flag(clean, '-o') || flag(clean, '--output') || positional;
        const selector = flag(clean, '--selector');
        const fullPage = clean.includes('--full-page');
        const target = out || path.join(process.cwd(), `screenshot-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
        // Unlike Vibium v26.3.x, Playwright honours the directory in the output
        // path and supports element-scoped capture natively.
        if (selector) await page.locator(resolveTarget(selector, session)).screenshot({ path: target });
        else await page.screenshot({ path: target, fullPage });
        return ok({ ok: true, path: target });
      }
      case 'source': {
        return { status: 0, stdout: await page.content(), stderr: '' };
      }
      case 'console': {
        const raw = await page.evaluate('JSON.stringify(window.__qeConsole || [])');
        // `entries` is the field the QE primitives read (see assert.js
        // runConsoleCheck, which accepts a bare array or `.entries`). The
        // aliases are emitted for callers that read `.messages`/`.logs`.
        // Getting this wrong is silent: an unrecognised shape reads as zero
        // entries, so `no_console_errors` PASSES on a page full of errors.
        return ok(withEntryAliases(JSON.parse(raw), 'messages'));
      }
      case 'network': {
        const raw = await page.evaluate('JSON.stringify(window.__qeNetwork || [])');
        return ok(withEntryAliases(JSON.parse(raw), 'requests'));
      }
      case 'eval': {
        const script = input !== undefined ? input : rest.join(' ');
        const value = await page.evaluate(script);
        // Match Vibium's `{ ok, result }` envelope; result is a string there.
        return ok({ ok: true, result: typeof value === 'string' ? value : JSON.stringify(value) });
      }
      case 'storage': {
        if (rest[0] === 'restore') {
          const state = JSON.parse(fs.readFileSync(rest[1], 'utf8'));
          const context = await browser.newContext({ storageState: state });
          const newPage = await context.newPage();
          await installRecorders(newPage);
          return ok({ ok: true, restored: rest[1] });
        }
        const out = flag(clean, '-o') || rest[0];
        const state = await page.context().storageState();
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(state, null, 2));
        return ok({ ok: true, path: out });
      }
      case 'close': {
        if (session.pid) { try { process.kill(session.pid); } catch (_e) { /* already gone */ } }
        try { fs.unlinkSync(SESSION_FILE); } catch (_e) { /* already gone */ }
        return ok({ ok: true });
      }
      default:
        return { status: 2, stdout: '', stderr: `playwright backend: unsupported command "${verb}"` };
    }
  } catch (err) {
    if (err instanceof EngineUnavailable) throw err;
    return { status: 1, stdout: '', stderr: String(err && err.message ? err.message : err) };
  } finally {
    // Disconnect this client only. Over CDP the browser is a separate detached
    // process, so dropping the connection leaves the page and its state intact
    // for the next command — the daemon equivalent. Tearing it down here is
    // what an earlier version got wrong.
    try { await browser.close(); } catch (_e) { /* best effort */ }
  }
}

/**
 * Synchronous facade. The primitives call the engine synchronously, so the
 * async Playwright work runs in a short-lived child process and its result
 * comes back over stdout.
 */
function run(args, { input, timeoutMs = 30000 } = {}) {
  const { spawnSync } = require('node:child_process');
  const payload = JSON.stringify({ args, input });
  const result = spawnSync(process.execPath, [__filename, '--__exec'], {
    encoding: 'utf8',
    input: payload,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status === 3) {
    return { unavailable: true, message: (result.stderr || '').trim() || 'Playwright engine unavailable.' };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (_err) {
    return {
      status: result.status === null ? 1 : result.status,
      stdout: result.stdout || '',
      stderr: (result.stderr || '').trim() || 'playwright backend produced no parseable result',
    };
  }
}

// Child-process entry point: read {args, input}, run, print the result envelope.
if (process.argv[2] === '--__exec') {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', async () => {
    try {
      const { args, input } = JSON.parse(raw);
      const res = await execute(args, { input });
      process.stdout.write(JSON.stringify(res));
      process.exit(0);
    } catch (err) {
      if (err instanceof EngineUnavailable) {
        process.stderr.write(err.message);
        process.exit(3);
      }
      process.stdout.write(JSON.stringify({ status: 1, stdout: '', stderr: String(err.message || err) }));
      process.exit(0);
    }
  });
}

module.exports = { ENGINE_ID, run, EngineUnavailable };
