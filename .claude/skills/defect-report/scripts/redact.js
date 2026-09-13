#!/usr/bin/env node
'use strict';
/**
 * redact.js — blocking secret/PII gate, run before any render or file operation.
 *
 * Filing to Jira or GitHub publishes the report to an external service where it
 * may be cached or indexed even if later deleted. A HAR capture or a server log
 * routinely carries session cookies and bearer tokens, so this gate is not
 * advisory: without --write (which produces a cleaned copy) or an explicit
 * --acknowledge, a report with findings exits non-zero and must not be filed.
 *
 * Usage:
 *   node redact.js --in <report.json>                  # report findings, exit 1 if any
 *   node redact.js --in <report.json> --write <out>     # emit a cleaned copy, exit 0
 *   node redact.js --in <report.json> --acknowledge     # accept the risk, exit 0
 */

const fs = require('fs');
const lib = require('./lib.js');

const OP = 'redact';

/**
 * Patterns ordered so the most specific wins: a GitHub token would also match
 * the generic high-entropy rule, and reporting it as "github-token" tells the
 * reader what to go rotate.
 *
 * `action: 'removed'` replaces the value outright — masking a token still
 * leaks its prefix and length, and a masked cookie is useless evidence anyway.
 * `action: 'flagged'` only annotates: the value may be legitimate diagnostic
 * content a human should judge.
 */
const PATTERNS = [
  { category: 'aws-access-key', severity: 'critical', action: 'removed', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { category: 'github-token', severity: 'critical', action: 'removed', re: /\bgh[pousr]_[A-Za-z0-9]{16,255}\b/g },
  { category: 'slack-token', severity: 'critical', action: 'removed', re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { category: 'private-key', severity: 'critical', action: 'removed', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g },
  { category: 'jwt', severity: 'critical', action: 'removed', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { category: 'bearer-token', severity: 'critical', action: 'removed', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{12,}=*/g },
  { category: 'authorization-header', severity: 'critical', action: 'removed', re: /"?authorization"?\s*[:=]\s*"?[^"',\s}]{8,}"?/gi },
  { category: 'cookie-header', severity: 'critical', action: 'removed', re: /"?(?:set-)?cookie"?\s*[:=]\s*"?[^"'\n}]{8,}"?/gi },
  { category: 'session-id', severity: 'high', action: 'removed', re: /\b(?:session|sess|sid|jsessionid|phpsessid)[_-]?(?:id|token)?\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}['"]?/gi },
  { category: 'api-key-assignment', severity: 'critical', action: 'removed', re: /\b(?:api[_-]?key|apikey|secret|password|passwd|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*['"]?[^\s'",;}]{6,}['"]?/gi },
  { category: 'connection-string', severity: 'critical', action: 'removed', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]*:[^\s'"@]+@[^\s'"]+/gi },
  { category: 'payment-card', severity: 'critical', action: 'removed', re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
  { category: 'us-ssn', severity: 'critical', action: 'removed', re: /\b(?!000|666|9)[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}\b/g },
  { category: 'email-address', severity: 'medium', action: 'flagged', re: /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|test\b|invalid\b|localhost\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { category: 'ipv4-address', severity: 'low', action: 'flagged', re: /\b(?!0\.|10\.|127\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.|255\.)(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g },
];

const PLACEHOLDER = '[REDACTED]';

/**
 * Walk every string in the report, recording a dotted path for each finding.
 *
 * Detection runs against the ORIGINAL value for every pattern before any
 * replacement is applied. Redacting as we go would hide overlapping patterns
 * from each other — a JWT replaced first stops the bearer-token and
 * api-key-assignment rules from ever matching — which would make the audit
 * trail understate what was actually in the report. Findings must be identical
 * whether or not --write was passed.
 */
function scan(node, pointer, findings, { write }) {
  if (typeof node === 'string') {
    const hits = [];
    for (const p of PATTERNS) {
      const matches = node.match(p.re);
      if (!matches) continue;
      hits.push(p);
      findings.push({
        category: p.category,
        path: pointer,
        severity: p.severity,
        action: p.action,
        occurrences: matches.length,
      });
    }
    if (!write) return node;
    let value = node;
    for (const p of hits) {
      if (p.action === 'removed') value = value.replace(p.re, `${PLACEHOLDER}:${p.category}`);
    }
    return value;
  }
  if (Array.isArray(node)) {
    return node.map((item, i) => scan(item, `${pointer}[${i}]`, findings, { write }));
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(node)) {
      out[key] = scan(val, pointer ? `${pointer}.${key}` : key, findings, { write });
    }
    return out;
  }
  return node;
}

function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const started = Date.now();

  if (!args.in) {
    lib.fail(OP, 'Missing required --in <report.json>.', ['node redact.js --in /tmp/report.json --write /tmp/report.clean.json']);
  }
  if (!fs.existsSync(args.in)) lib.fail(OP, `Input not found: ${args.in}`);

  let doc;
  try {
    doc = lib.readJson(args.in);
  } catch (err) {
    lib.fail(OP, `Could not parse ${args.in}: ${err.message}`);
  }
  const report = lib.extractReport(doc) || doc;

  const findings = [];
  const cleaned = scan(report, '', findings, { write: Boolean(args.write) });

  const blocking = findings.filter((f) => f.action === 'removed');
  const flagged = findings.filter((f) => f.action === 'flagged');
  const removedCount = blocking.reduce((n, f) => n + f.occurrences, 0);

  if (args.write) {
    cleaned.provenance = {
      ...(cleaned.provenance || {}),
      redaction: {
        applied: true,
        findings_removed: removedCount,
        categories: [...new Set(blocking.map((f) => f.category))],
      },
    };
    for (const att of cleaned.attachments || []) {
      // Attachments are files this script does not rewrite; say so rather than
      // marking them clean and implying a scan that never happened.
      if (att.redacted !== true) att.redacted = false;
    }
    lib.writeJson(args.write, cleaned);
  }

  const unresolved = blocking.length > 0 && !args.write && !args.acknowledge;
  const attachmentWarn = (report.attachments || []).some((a) => ['har', 'server-log', 'console-log', 'trace'].includes(a.kind) && a.redacted !== true);

  const warnings = [];
  if (attachmentWarn) {
    warnings.push(
      'One or more attachments are a HAR, log or trace and are not marked redacted. This script scans the report JSON only — it does not rewrite attachment files. Scrub or drop them before filing to an external tracker.'
    );
  }
  if (flagged.length) {
    warnings.push(`${flagged.length} flagged item(s) (emails, public IPs) left in place — confirm they are not customer data before filing.`);
  }

  const summary = blocking.length
    ? `Found ${blocking.length} secret/PII pattern(s) totalling ${removedCount} occurrence(s) in the report. ` +
      (args.write
        ? `A cleaned copy was written to ${args.write}; file that copy, not the original.`
        : args.acknowledge
          ? 'Acknowledged without cleaning — the report still contains these values, and filing it will publish them.'
          : 'Filing is BLOCKED. Re-run with --write <out> to produce a cleaned copy, or --acknowledge to accept the risk explicitly.')
    : `No secret or credential patterns found in the report JSON.${flagged.length ? ` ${flagged.length} lower-severity item(s) flagged for review.` : ''} Safe to render and file, subject to the attachment note above.`;

  lib.emit(
    lib.envelope(
      OP,
      unresolved ? 'failed' : warnings.length || flagged.length ? 'partial' : 'success',
      {
        summary,
        redaction: {
          blocked: unresolved,
          findings,
          findingsRemoved: args.write ? removedCount : 0,
        },
        warnings,
        ...(unresolved
          ? {
              remediation: [
                `node redact.js --in ${args.in} --write <cleaned.json>   # recommended`,
                `node redact.js --in ${args.in} --acknowledge            # only with a human decision on record`,
                'Drop the offending evidence entirely if it is not diagnostically necessary',
              ],
            }
          : {}),
      },
      { metadata: { executionTimeMs: Date.now() - started } }
    )
  );
}

main();
