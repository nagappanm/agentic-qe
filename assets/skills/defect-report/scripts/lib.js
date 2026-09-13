'use strict';
/**
 * Shared helpers for the defect-report skill.
 *
 * Kept dependency-free on purpose: these scripts run inside `aqe init`-ed
 * projects that may not have installed anything yet.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SKILL_NAME = 'defect-report';
const SKILL_VERSION = '1.0.0';
const SCHEMA_VERSION = '1.0.0';

/** Parse `--flag value` / `--flag=value` / `--bool` argv into an object. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/** Build the AQE Tier-3 output envelope. */
function envelope(operation, status, output, extra = {}) {
  return {
    skillName: SKILL_NAME,
    version: SKILL_VERSION,
    timestamp: new Date().toISOString(),
    status,
    trustTier: 3,
    ...extra,
    output: { operation, ...output },
    metadata: {
      schemaVersion: SCHEMA_VERSION,
      ...(extra.metadata || {}),
    },
  };
}

/**
 * Emit an envelope and exit with the qe-browser-compatible code:
 *   0 success/partial, 1 failed, 2 skipped (environment unavailable).
 */
function emit(env, { pretty = true } = {}) {
  process.stdout.write(JSON.stringify(env, null, pretty ? 2 : 0) + '\n');
  const code = env.status === 'failed' ? 1 : env.status === 'skipped' ? 2 : 0;
  process.exit(code);
}

function fail(operation, summary, remediation = []) {
  emit(envelope(operation, 'failed', { summary, remediation }));
}

/** Stable id generators: C-01, EV-01, ... */
function componentId(index) {
  return `C-${String(index + 1).padStart(2, '0')}`;
}
function evidenceId(index) {
  return `EV-${String(index + 1).padStart(2, '0')}`;
}

/**
 * Deterministic dedupe fingerprint.
 *
 * Deliberately derived from STABLE facts only. Timestamps, trace ids, counts,
 * viewport sizes and any user data are excluded so that the same defect
 * observed by two people on two days hashes identically — which is the whole
 * point of having a fingerprint.
 */
function fingerprint(report) {
  const primary = (report.components || [])[0] || {};
  const boundary = report.boundary || {};
  const request = boundary.request || {};
  const parts = [
    normalizeToken(primary.framework_component || primary.selector || ''),
    normalizeToken(errorClassOf(report)),
    normalizeToken(request.method || ''),
    normalizeToken(stripUrlVariables(request.url || report.environment?.url || '')),
    String(request.status || ''),
    report.classification?.defect_type || '',
    report.fault_localization?.suspected_layer || '',
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Pull the error *class* out of the report — the part that stays constant
 * across occurrences. "TypeError: cannot read 'total' of undefined" and the
 * same error on a different field should not collapse together, but the same
 * error with a different request id must.
 */
function errorClassOf(report) {
  const fromEvidence = (report.evidence || []).find((e) =>
    ['js-exception', 'console-error', 'stack-trace'].includes(e.kind)
  );
  const text = fromEvidence?.summary || report.actual || '';
  const m = text.match(/([A-Z][A-Za-z]*(?:Error|Exception))\s*:?\s*([^.\n]{0,80})/);
  if (m) return `${m[1]}:${m[2]}`;
  return text.slice(0, 80);
}

/** Replace numeric/uuid path segments so /orders/8821 and /orders/9134 match. */
function stripUrlVariables(url) {
  let u = url;
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    u = parsed.pathname;
  } catch {
    /* treat as a bare path */
  }
  return u
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{uuid}')
    .replace(/\/\d+/g, '/{id}');
}

function normalizeToken(s) {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Order evidence into a timeline of ids, by offset_ms then timestamp. */
function buildTimeline(evidence) {
  return [...(evidence || [])]
    .filter((e) => e.offset_ms !== undefined || e.timestamp)
    .sort((a, b) => {
      if (a.offset_ms !== undefined && b.offset_ms !== undefined) return a.offset_ms - b.offset_ms;
      return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    })
    .map((e) => e.id);
}

/** Normalize absolute timestamps into offset_ms from the earliest item. */
function applyOffsets(evidence) {
  const stamped = (evidence || []).filter((e) => e.timestamp);
  if (stamped.length === 0) return evidence;
  const base = Math.min(...stamped.map((e) => Date.parse(e.timestamp)).filter((n) => !Number.isNaN(n)));
  if (!Number.isFinite(base)) return evidence;
  for (const e of evidence) {
    if (e.offset_ms === undefined && e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) e.offset_ms = t - base;
    }
  }
  return evidence;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Unwrap either a bare report or a Tier-3 envelope containing one. */
function extractReport(doc) {
  if (doc && doc.schema_version && doc.fingerprint !== undefined) return doc;
  if (doc && doc.output && doc.output.report) return doc.output.report;
  if (doc && doc.schema_version) return doc;
  return null;
}

module.exports = {
  SKILL_NAME,
  SKILL_VERSION,
  SCHEMA_VERSION,
  parseArgs,
  envelope,
  emit,
  fail,
  componentId,
  evidenceId,
  fingerprint,
  errorClassOf,
  stripUrlVariables,
  buildTimeline,
  applyOffsets,
  readJson,
  writeJson,
  extractReport,
};
