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

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const OP = 'capture';

function vibiumAvailable() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['vibium'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && String(probe.stdout).trim().length > 0;
}

function vibium(args, { allowFail = false } = {}) {
  try {
    return execFileSync('vibium', args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
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

function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const started = Date.now();

  if (!args.url) {
    lib.fail(OP, 'Missing required --url. Point it at the page where the defect surfaces.', [
      'node capture-dom-context.js --url https://app.example.com/checkout --testid order-summary',
    ]);
  }

  if (!vibiumAvailable()) {
    lib.emit(
      lib.envelope(
        OP,
        'skipped',
        {
          summary:
            'vibium binary not found on PATH, so no DOM evidence could be captured. Build the report with manually supplied components and evidence instead — this is an environment gap, not a defect-report failure.',
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
  try {
    vibium(['go', String(args.url)]);
  } catch (err) {
    lib.fail(OP, `vibium could not load ${args.url}: ${String(err.message).slice(0, 300)}`, [
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
  const consoleList = (consoleMsgs && (consoleMsgs.messages || consoleMsgs.logs)) || [];
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
  const requests = (net && (net.requests || net.entries)) || [];
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
  if (vibium(['screenshot', shotPath], { allowFail: true }) !== null && fs.existsSync(shotPath)) {
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
