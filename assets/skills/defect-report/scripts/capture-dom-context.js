#!/usr/bin/env node
'use strict';
/**
 * capture-dom-context.js — turn a live failing page into defect-report evidence.
 *
 * Browser driving is qe-browser's job; this script goes through its engine layer
 * and shapes what comes back into `components[]` + `evidence[]` per
 * schemas/defect-report.json. Page facts are gathered by page-probe.js through
 * `eval`, so they do not depend on engine-specific commands whose output drifts
 * between releases. It honours the qe-browser environment contract: no usable
 * engine => status "skipped", vibiumUnavailable:true, exit 2.
 *
 * Usage:
 *   node capture-dom-context.js --url <url> [--selector <css>] [--testid <id>]
 *                               [--repo-root .] [--screenshot <path>] [--out <file>]
 *
 * The --selector/--testid narrows attribution to the element that actually
 * failed. Without either, the script reports the page-level component tree and
 * flags that the failing element is unidentified.
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');
const probe = require('./page-probe.js');
const {
  resolveComponentName,
  shouldResolveSource,
  targetComponent,
  containerComponent,
  stateEvidence,
} = require('./component-attribution.js');

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
function vibium(args, { allowFail = false, input } = {}) {
  const res = engine.run(args, { timeoutMs: 60000, input });
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

  // Probes catch their own failures, so they get the throwing wrapper.
  const run = (a, o = {}) => vibium(a, o);
  const engineName = engine.selectedEngine();
  const framework = probe.probeFramework(run);
  const ctx = { repoRoot, warnings, resolveSource: shouldResolveSource(String(args.url), args) };
  if (!ctx.resolveSource) {
    warnings.push('Skipped source-file lookup: the page is not local and no --repo-root was given, so grepping this checkout would attribute the component to an unrelated file.');
  }

  // --- Attribute the failing element ---------------------------------------
  const wanted = args.selector || args.testid;
  if (wanted) {
    const t = probe.probeTarget(run, { selector: args.selector, testid: args.testid });
    if (t && t.found) {
      if (t.count > 1) warnings.push(`${t.query} matched ${t.count} elements; attributed the first.`);
      components.push(targetComponent(t, framework, ctx));
      if (t.container) components.push(containerComponent(t.container, framework));
      evidence.push(stateEvidence(t));
    } else {
      warnings.push(t && t.error ? t.error : `No element matched ${wanted}; falling back to page-level attribution.`);
    }
  } else {
    warnings.push('Neither --selector nor --testid given: the failing element is unidentified. Attribution is page-level.');
  }

  if (components.length === 0) {
    const elements = probe.parseMap(vibiumJson(['map'], { allowFail: true }));
    if (elements.length === 0) warnings.push('The engine map returned no interactive elements, so there is nothing to attribute.');
    elements.slice(0, 3).forEach((el, i) => {
      const { name, method } = resolveComponentName(el);
      components.push({
        id: lib.componentId(i),
        role_in_defect: 'container',
        selector: el.selector || el.ref,
        framework_component: name,
        framework,
        detection_method: method,
        ...(el.text ? { text_content: String(el.text).slice(0, 400) } : {}),
      });
    });
  }

  // --- Console + network evidence ------------------------------------------
  // An engine that cannot observe console or network must say so. An empty
  // list reads as "nothing went wrong", which is a different and false claim.
  const con = probe.probeConsole(run);
  if (con.unsupported) {
    warnings.push(
      `Console messages were NOT captured: ${con.reason} (engine: ${engineName}). This does not mean no errors occurred. ` +
        'Re-run with QE_BROWSER_ENGINE=playwright, which records them, or add them to evidence[] by hand.'
    );
  }
  for (const msg of con.entries) {
    const level = String(msg.level || msg.type || 'log').toLowerCase();
    if (!['error', 'warning', 'warn', 'severe'].includes(level)) continue;
    evidence.push({
      id: lib.evidenceId(evidence.length),
      layer: 'ui',
      kind: level.startsWith('warn') ? 'console-warning' : 'console-error',
      summary: String(msg.text || msg.message || '').slice(0, 600),
      ...(msg.timestamp ? { timestamp: new Date(msg.timestamp).toISOString() } : {}),
      ...(msg.stack ? { detail: String(msg.stack).slice(0, 20000) } : {}),
      source: con.source === 'engine' ? 'browser-console' : con.source,
      ...(components[0] ? { component_ref: components[0].id } : {}),
    });
  }

  const net = probe.probeNetwork(run);
  if (net.unsupported) {
    warnings.push(`Network activity was NOT captured: ${net.reason} (engine: ${engineName}), and the Resource Timing fallback was unavailable.`);
  } else if (net.source === 'resource-timing') {
    warnings.push(
      `Network evidence came from the browser's Resource Timing API because ${net.engineGap}: URLs, status and timing only — no methods or headers, so no correlation ID.`
    );
  }
  if (!net.unsupported && net.entries.length === 0) warnings.push('No fetch/XHR requests were observed on this page.');
  for (const req of net.entries) {
    const status = req.status || req.response?.status;
    if (net.source === 'resource-timing' && !status) {
      evidence.push({
        id: lib.evidenceId(evidence.length),
        layer: 'network',
        kind: 'http-request',
        summary: `${req.initiator} ${String(req.url || '').slice(0, 400)} (status not exposed by the browser)`,
        ...(req.timestamp ? { timestamp: new Date(req.timestamp).toISOString() } : {}),
        ...(req.duration !== undefined ? { detail: `duration_ms=${req.duration}` } : {}),
        source: 'resource-timing',
      });
      continue;
    }
    const failed = status === undefined || status === 0 || status >= 400;
    const headers = req.response?.headers || req.responseHeaders || {};
    const correlation =
      headers['x-request-id'] || headers['traceparent'] || headers['x-trace-id'] || headers['x-correlation-id'];
    evidence.push({
      id: lib.evidenceId(evidence.length),
      layer: 'network',
      kind: failed ? 'failed-request' : 'http-response',
      summary: `${req.method || req.initiator || 'GET'} ${String(req.url || '').slice(0, 400)} -> ${status ?? 'no response'}`,
      ...(req.timestamp ? { timestamp: new Date(req.timestamp).toISOString() } : {}),
      ...(correlation ? { correlation_id: String(correlation) } : {}),
      ...(req.duration !== undefined ? { detail: `duration_ms=${req.duration}` } : {}),
      source: net.source === 'engine' ? `${engineName}-network` : net.source,
    });
  }

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

  // `partial` whenever something the report would want is missing — the named
  // element was not found, or the engine could not observe console/network —
  // so a caller never mistakes an incomplete capture for a complete one.
  const targetMissing = Boolean(wanted) && components[0]?.role_in_defect !== 'failing';
  const complete = !targetMissing && !con.unsupported && !net.unsupported && evidence.length > 0;

  lib.emit(
    lib.envelope(
      OP,
      complete ? 'success' : 'partial',
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
