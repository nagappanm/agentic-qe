#!/usr/bin/env node
'use strict';
/**
 * capture-dom-context.js — turn a live failing page into defect-report evidence.
 *
 * Browser driving is qe-browser's job; this script only shells out to `vibium`
 * and shapes the result into `components[]` + `evidence[]` per
 * schemas/defect-report.json. It honours the qe-browser environment contract:
 * no vibium on PATH => status "skipped", vibiumUnavailable:true, exit 2.
 *
 * Usage:
 *   node capture-dom-context.js --url <url> [--selector <css>] [--testid <id>]
 *                               [--repo-root .] [--screenshot <path>] [--out <file>]
 *
 * The --selector/--testid narrows attribution to the element that actually
 * failed. Without either, the script reports the page-level component tree and
 * flags that the failing element is unidentified.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const OP = 'capture';

/**
 * Browser driving belongs to qe-browser, so this script goes through its engine
 * layer rather than spawning a browser binary itself. That means defect-report
 * inherits whichever engine qe-browser is configured for — Vibium by default,
 * Playwright via QE_BROWSER_ENGINE=playwright — with no code here that knows
 * the difference.
 */
function loadEngine() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'qe-browser', 'scripts', 'lib', 'engine.js'),
    path.resolve(process.cwd(), '.claude', 'skills', 'qe-browser', 'scripts', 'lib', 'engine.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      try {
        return require(c);
      } catch (_err) {
        /* try next */
      }
    }
  }
  return null;
}

const engine = loadEngine();

function engineAvailable() {
  return engine !== null;
}

/**
 * Run one engine command, returning stdout or null.
 * Engine stderr is captured by the backends rather than inherited, so the
 * single JSON envelope this script writes to stdout stays parseable even when
 * a caller redirects 2>&1.
 */
function vibium(args, { allowFail = false } = {}) {
  const res = engine.run(args, { timeoutMs: 60000 });
  if (res && res.unavailable) {
    const err = new Error(res.message);
    err.engineUnavailable = true;
    throw err;
  }
  if (res.status !== 0) {
    if (allowFail) return null;
    const err = new Error(`${args[0]} failed: ${(res.stderr || res.stdout || '').trim()}`);
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout;
}

/**
 * Distinguish "the browser engine cannot run here" from "the page did not
 * load". The first is an environment gap the caller should treat exactly like
 * a missing vibium binary — degrade to manual evidence, exit 2. The second is
 * a real result the caller needs to see, so it stays a failure.
 */
function isEngineUnavailable(message) {
  return [
    /cannot run as root/i,
    /chromedriver not found/i,
    /failed to launch browser/i,
    /failed to create session/i,
    /session not created/i,
    /only supports chrome version/i,
    /failed to fetch version info/i,
    /executable doesn't exist|no such file or directory.*chrome/i,
  ].some((re) => re.test(message));
}

function vibiumJson(args, { allowFail = false } = {}) {
  const raw = vibium([...args, '--json'], { allowFail });
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Detect the UI framework from page markers. Ordered most-specific first —
 * ng-version and data-reactroot are explicit, __vue__ is a runtime property,
 * so a page that somehow carries two markers is attributed to the explicit one.
 */
function detectFramework(html) {
  if (/ng-version=|_nghost-|ng-reflect-/.test(html)) return 'angular';
  if (/data-reactroot|__reactFiber\$|__reactProps\$|data-reactid/.test(html)) return 'react';
  if (/data-v-[0-9a-f]{8}|__vue__|v-cloak/.test(html)) return 'vue';
  if (/svelte-[0-9a-z]{6}/.test(html)) return 'svelte';
  if (/<[a-z]+-[a-z-]+[\s>]/.test(html) && /customElements/.test(html)) return 'web-components';
  if (/jquery|\$\(document\)\.ready/i.test(html)) return 'jquery';
  return 'unknown';
}

/**
 * Resolve a component name from an element record, most trustworthy source
 * first. detection_method is reported alongside so a reader can tell a
 * devtools-sourced name from an inference.
 */
function resolveComponentName(el) {
  const attrs = el.attributes || el.attrs || {};
  const candidates = [
    ['data-component', attrs['data-component']],
    ['data-component', attrs['data-component-name']],
    ['devtools-attribute', attrs['data-testid-component']],
    ['data-testid', attrs['data-testid'] || attrs['data-test-id'] || attrs['data-test']],
    ['aria-label', attrs['aria-label']],
  ];
  for (const [method, value] of candidates) {
    if (value) return { name: String(value), method };
  }
  if (el.role) return { name: `${el.tag || 'element'}[role=${el.role}]`, method: 'aria-label' };
  return { name: el.tag ? String(el.tag) : 'unknown', method: 'inferred' };
}

/**
 * Map a component name or testid back to the source file that defines it.
 * grep-based and therefore best-effort: source_basis records how the match was
 * made so a wrong guess is auditable rather than silently authoritative.
 */
function resolveSourceFile(name, repoRoot) {
  if (!name || name === 'unknown') return null;
  const bare = name.replace(/[^A-Za-z0-9_-]/g, '');
  if (bare.length < 3) return null;

  const attempts = [
    { pattern: `(function|const|class)\\s+${bare}\\b`, basis: `declaration of ${bare}` },
    { pattern: `data-testid=["']${bare}["']`, basis: `data-testid="${bare}" literal` },
    { pattern: `\\b${bare}\\b`, basis: `name occurrence ${bare}` },
  ];

  for (const { pattern, basis } of attempts) {
    const res = spawnSync(
      'grep',
      ['-rEl', '--include=*.tsx', '--include=*.jsx', '--include=*.ts', '--include=*.js',
       '--include=*.vue', '--include=*.svelte', '--include=*.html',
       '--exclude-dir=node_modules', '--exclude-dir=dist', '--exclude-dir=.git',
       pattern, repoRoot],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 }
    );
    if (res.status === 0) {
      const hits = String(res.stdout).trim().split('\n').filter(Boolean);
      if (hits.length > 0 && hits.length <= 5) {
        return { file: path.relative(repoRoot, hits[0]) || hits[0], basis, ambiguous: hits.length > 1 };
      }
    }
  }
  return null;
}

/** Most frequent recent author of a file — a triage hint, never an assignment. */
function resolveOwner(file, repoRoot) {
  if (!file) return null;
  const res = spawnSync('git', ['log', '-n', '20', '--format=%an', '--', file], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (res.status !== 0) return null;
  const counts = {};
  for (const author of String(res.stdout).trim().split('\n').filter(Boolean)) {
    counts[author] = (counts[author] || 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return ranked.length ? ranked[0][0] : null;
}


/**
 * Read a list out of an engine response regardless of which field it arrived
 * under. The engines disagree — qe-browser's assert.js reads a bare array or
 * `.entries`, while other responses use `.messages`/`.requests`. A mismatch
 * here is silent: it yields an empty list, so a page full of console errors
 * would look clean and the report would omit its most important evidence.
 */
function normalizeList(payload, fields) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const f of fields) {
    if (Array.isArray(payload[f])) return payload[f];
  }
  return [];
}


/** Current page URL, or null when there is no live session yet. */
function currentUrl() {
  try {
    const raw = vibium(['eval', '--json', 'location.href'], { allowFail: true });
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const value = parsed && (parsed.result !== undefined ? parsed.result : parsed);
    return typeof value === 'string' ? value.replace(/^"|"$/g, '') : null;
  } catch (_err) {
    return null;
  }
}

/** Compare URLs ignoring a trailing slash, so /checkout and /checkout/ match. */
function sameLocation(a, b) {
  const norm = (u) => String(u).replace(/\/+$/, '').replace(/^https?:\/\//, '');
  return norm(a) === norm(b);
}

function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const started = Date.now();

  if (!args.url) {
    lib.fail(OP, 'Missing required --url. Point it at the page where the defect surfaces.', [
      'node capture-dom-context.js --url https://app.example.com/checkout --testid order-summary',
    ]);
  }

  if (!engineAvailable()) {
    lib.emit(
      lib.envelope(
        OP,
        'skipped',
        {
          summary:
            'The qe-browser engine layer could not be loaded, so no DOM evidence could be captured. Build the report with manually supplied components and evidence instead — this is an environment gap, not a defect-report failure.',
          reason: 'browser-engine-unavailable',
          remediation: [
            'Install vibium globally: `npm install -g vibium`',
            'Or re-run `aqe init` to install via the AQE bootstrap',
            'Or hand-author components[]/evidence[] and pass them to build-report.js --evidence',
            'See .claude/skills/qe-browser/SKILL.md for the Linux ARM64 workaround',
          ],
        },
        { vibiumUnavailable: true }
      )
    );
  }

  const repoRoot = path.resolve(args['repo-root'] || process.cwd());
  const warnings = [];
  const components = [];
  const evidence = [];
  const attachments = [];

  // --- Navigate and map -----------------------------------------------------
  // Navigating resets the page, which discards the console errors and network
  // activity that led to the defect. So skip it when the browser is already on
  // the requested URL — the normal case, because you drive the page to the
  // failure (via qe-browser batch) and *then* capture. --no-navigate forces
  // the skip; --force-navigate forces a reload.
  let navigated = false;
  try {
    const current = currentUrl();
    const sameUrl = current && sameLocation(current, String(args.url));
    const skip = args['no-navigate'] === true || (sameUrl && args['force-navigate'] !== true);
    if (skip) {
      warnings.push(
        `Reused the browser's existing page at ${current} instead of reloading, so evidence from earlier interactions is preserved. Pass --force-navigate to reload.`
      );
    } else {
      vibium(['go', String(args.url)]);
      navigated = true;
    }
  } catch (err) {
    // The engine backends capture their child stderr rather than inheriting it,
    // and surface it on err.stderr.
    const detail = `${err.message || ''}\n${err.stderr || ''}`.trim();

    if (err.engineUnavailable || isEngineUnavailable(detail)) {
      lib.emit(
        lib.envelope(
          OP,
          'skipped',
          {
            summary:
              `The vibium binary is installed but its browser could not start, so no DOM evidence could be captured. ` +
              `Build the report with manually supplied components and evidence instead — this is an environment gap, not a defect-report failure. ` +
              `Engine said: ${detail.split('\n')[0].slice(0, 200)}`,
            reason: 'browser-engine-unavailable',
            remediation: [
              'Running as root? Set VIBIUM_CHROME_ARGS=--no-sandbox, or run as a non-root user (preferred — the sandbox is a security boundary)',
              'Missing or mismatched chromedriver? Run `vibium install` to fetch a matching Chrome for Testing pair',
              'Air-gapped or proxied host? `vibium install` needs googlechromelabs.github.io; see the qe-browser SKILL.md workaround for using a system chromium',
              'Or hand-author components[]/evidence[] and pass them to build-report.js --evidence',
            ],
          },
          { vibiumUnavailable: true }
        )
      );
    }

    lib.fail(OP, `vibium could not load ${args.url}: ${detail.slice(0, 300)}`, [
      'Confirm the URL is reachable from this machine',
      'For an authenticated page, restore session state first (see qe-browser Pattern 4)',
    ]);
  }

  const html = vibium(['source'], { allowFail: true }) || '';
  const framework = detectFramework(html);
  const map = vibiumJson(['map'], { allowFail: true });
  const elements = (map && (map.elements || map.refs || map.nodes)) || [];
  if (elements.length === 0) warnings.push('vibium map returned no elements; component attribution is page-level only.');

  // --- Pick the failing element --------------------------------------------
  const wanted = args.selector || args.testid;
  let target = null;
  if (wanted) {
    target = elements.find((el) => {
      const attrs = el.attributes || el.attrs || {};
      return (
        el.selector === wanted ||
        attrs['data-testid'] === args.testid ||
        attrs['data-test-id'] === args.testid ||
        (el.selector && args.selector && el.selector.includes(args.selector))
      );
    });
    if (!target) warnings.push(`No element matched ${wanted}; falling back to page-level attribution.`);
  } else {
    warnings.push('Neither --selector nor --testid given: the failing element is unidentified. Attribution is page-level.');
  }

  const chosen = target ? [target] : elements.slice(0, 3);
  chosen.forEach((el, i) => {
    const attrs = el.attributes || el.attrs || {};
    const { name, method } = resolveComponentName(el);
    const source = resolveSourceFile(name, repoRoot);
    if (source?.ambiguous) warnings.push(`source_file for ${name} matched multiple files; verify before trusting it.`);
    const owner = source ? resolveOwner(source.file, repoRoot) : null;

    components.push({
      id: lib.componentId(i),
      role_in_defect: target && i === 0 ? 'failing' : 'container',
      selector: el.selector || el.css || `*[data-testid="${attrs['data-testid'] || 'unknown'}"]`,
      dom_path: (el.path || el.ancestors || []).map((n) => ({
        tag: n.tag || n.tagName || 'div',
        ...(n.id ? { id: n.id } : {}),
        ...(n.classes ? { classes: [].concat(n.classes).slice(0, 30) } : {}),
        ...(n.role ? { role: n.role } : {}),
        ...(n.testid ? { testid: n.testid } : {}),
      })),
      framework_component: name,
      framework,
      detection_method: method,
      ...(attrs['data-testid'] ? { testid: attrs['data-testid'] } : {}),
      aria: {
        ...(el.role || attrs.role ? { role: el.role || attrs.role } : {}),
        ...(attrs['aria-label'] ? { label: attrs['aria-label'] } : {}),
      },
      ...(el.text ? { text_content: String(el.text).slice(0, 400) } : {}),
      ...(el.box || el.rect ? { bounding_box: el.box || el.rect } : {}),
      state_snapshot: {
        disabled: attrs.disabled !== undefined || el.disabled === true,
        ...(attrs['aria-invalid'] ? { 'aria-invalid': attrs['aria-invalid'] } : {}),
        ...(el.visible !== undefined ? { visible: el.visible } : {}),
        ...(attrs.value !== undefined ? { value: String(attrs.value).slice(0, 200) } : {}),
      },
      ...(source ? { source_file: source.file, source_basis: source.basis } : {}),
      ...(owner ? { owner } : {}),
    });
  });

  // --- Console + network evidence ------------------------------------------
  const consoleMsgs = vibiumJson(['console'], { allowFail: true });
  const consoleList = normalizeList(consoleMsgs, ['entries', 'messages', 'logs']);
  for (const msg of consoleList) {
    const level = String(msg.level || msg.type || 'log').toLowerCase();
    if (!['error', 'warning', 'warn', 'severe'].includes(level)) continue;
    evidence.push({
      id: lib.evidenceId(evidence.length),
      layer: 'ui',
      kind: level.startsWith('warn') ? 'console-warning' : 'console-error',
      summary: String(msg.text || msg.message || '').slice(0, 600),
      ...(msg.timestamp ? { timestamp: new Date(msg.timestamp).toISOString() } : {}),
      ...(msg.stack ? { detail: String(msg.stack).slice(0, 20000) } : {}),
      source: 'browser-console',
      ...(components[0] ? { component_ref: components[0].id } : {}),
    });
  }

  const net = vibiumJson(['network'], { allowFail: true });
  const requests = normalizeList(net, ['entries', 'requests']);
  for (const req of requests) {
    const status = req.status || req.response?.status;
    const failed = status === undefined || status === 0 || status >= 400;
    const headers = req.response?.headers || req.responseHeaders || {};
    const correlation =
      headers['x-request-id'] || headers['traceparent'] || headers['x-trace-id'] || headers['x-correlation-id'];
    evidence.push({
      id: lib.evidenceId(evidence.length),
      layer: 'network',
      kind: failed ? 'failed-request' : 'http-response',
      summary: `${req.method || 'GET'} ${String(req.url || '').slice(0, 400)} -> ${status ?? 'no response'}`,
      ...(req.timestamp ? { timestamp: new Date(req.timestamp).toISOString() } : {}),
      ...(correlation ? { correlation_id: String(correlation) } : {}),
      ...(req.duration !== undefined ? { detail: `duration_ms=${req.duration}` } : {}),
      source: 'vibium-network',
    });
  }
  if (requests.length === 0) warnings.push('No network activity captured; a cross-layer correlation ID may be unavailable.');

  // --- Screenshot -----------------------------------------------------------
  const shotPath = args.screenshot || path.join('.aqe', 'defect-reports', `capture-${Date.now()}.png`);
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  if (vibium(['screenshot', '-o', shotPath, '--full-page'], { allowFail: true }) !== null && fs.existsSync(shotPath)) {
    attachments.push({ kind: 'screenshot', path: shotPath, description: 'Page state at capture time', redacted: false });
  } else {
    warnings.push('Screenshot capture failed; report will have no visual evidence.');
  }

  lib.applyOffsets(evidence);

  const captured = { url: String(args.url), framework, components, evidence, attachments };
  if (args.out) lib.writeJson(args.out, captured);

  lib.emit(
    lib.envelope(
      OP,
      evidence.length === 0 ? 'partial' : 'success',
      {
        summary:
          `Captured ${components.length} component(s) and ${evidence.length} evidence item(s) from ${args.url} ` +
          `(framework: ${framework}).` +
          (args.out ? ` Written to ${args.out}.` : ' Pass --out to persist for build-report.js.'),
        capture: captured,
        warnings,
      },
      {
        metadata: {
          executionTimeMs: Date.now() - started,
          evidenceCount: evidence.length,
          componentCount: components.length,
        },
      }
    )
  );
}

main();
