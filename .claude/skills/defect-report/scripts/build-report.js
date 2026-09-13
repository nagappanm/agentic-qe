#!/usr/bin/env node
'use strict';
/**
 * build-report.js — assemble a canonical defect report and validate it.
 *
 * Takes captured and/or hand-authored fragments, assigns stable ids, computes
 * offsets, derives the dedupe fingerprint, and validates the result against
 * schemas/defect-report.json.
 *
 * Validation is dependency-free (no ajv in this tree) and deliberately
 * emphasises *referential* integrity over full draft-07 conformance: a report
 * citing EV-07 that does not exist is the realistic failure mode, and it is
 * exactly what a downstream LLM would trip over.
 *
 * Usage:
 *   node build-report.js --fixture <report.json> [--out <file>]
 *   node build-report.js --report <partial.json> --capture <capture.json> [--out <file>]
 *   node build-report.js --fixture <f.json> --strict     # warnings become failures
 */

const fs = require('fs');
const path = require('path');
const lib = require('./lib.js');

const OP = 'build';
const SCHEMA = lib.readJson(path.join(__dirname, '..', 'schemas', 'defect-report.json'));

// ---------------------------------------------------------------------------
// Schema validation (subset: required, enum, pattern, length, array bounds)
// ---------------------------------------------------------------------------

function validateNode(value, schema, pointer, errors, defs) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const key = schema.$ref.replace('#/$defs/', '');
    return validateNode(value, defs[key], pointer, errors, defs);
  }

  const type = schema.type;
  if (type === 'object' || schema.properties) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${pointer}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
    for (const req of schema.required || []) {
      if (value[req] === undefined) errors.push(`${pointer}.${req}: required field missing`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${pointer}.${key}: property not allowed by schema`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) validateNode(value[key], sub, `${pointer}.${key}`, errors, defs);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${pointer}: expected array, got ${typeof value}`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: needs at least ${schema.minItems} item(s), has ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${pointer}: at most ${schema.maxItems} item(s) allowed, has ${value.length}`);
    }
    value.forEach((item, i) => validateNode(item, schema.items, `${pointer}[${i}]`, errors, defs));
    return;
  }

  // Scalars
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: ${value.length} chars, needs at least ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: ${value.length} chars, exceeds max ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer}: ${JSON.stringify(value.slice(0, 60))} does not match /${schema.pattern}/`);
    }
  }
  if (type === 'integer' && !Number.isInteger(value)) errors.push(`${pointer}: expected integer`);
  if (type === 'number' && typeof value !== 'number') errors.push(`${pointer}: expected number`);
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${pointer}: expected boolean`);
}

/**
 * Referential integrity — the checks that actually protect a consumer.
 * A dangling EV- reference makes the report unusable to an agent even though
 * every individual field is schema-valid.
 */
function validateReferences(report) {
  const errors = [];
  const warnings = [];
  const evidenceIds = new Set((report.evidence || []).map((e) => e.id));
  const componentIds = new Set((report.components || []).map((c) => c.id));

  const dupEv = findDuplicates((report.evidence || []).map((e) => e.id));
  if (dupEv.length) errors.push(`evidence: duplicate ids ${dupEv.join(', ')}`);
  const dupC = findDuplicates((report.components || []).map((c) => c.id));
  if (dupC.length) errors.push(`components: duplicate ids ${dupC.join(', ')}`);

  for (const ref of report.fault_localization?.evidence_refs || []) {
    if (!evidenceIds.has(ref)) errors.push(`fault_localization.evidence_refs: ${ref} does not exist in evidence[]`);
  }
  (report.fault_localization?.alternatives || []).forEach((alt, i) => {
    for (const ref of alt.ruled_out_by || []) {
      if (!evidenceIds.has(ref)) {
        errors.push(`fault_localization.alternatives[${i}].ruled_out_by: ${ref} does not exist in evidence[]`);
      }
    }
  });
  for (const ref of report.timeline || []) {
    if (!evidenceIds.has(ref)) errors.push(`timeline: ${ref} does not exist in evidence[]`);
  }
  (report.evidence || []).forEach((e, i) => {
    if (e.component_ref && !componentIds.has(e.component_ref)) {
      errors.push(`evidence[${i}].component_ref: ${e.component_ref} does not exist in components[]`);
    }
  });

  // The rationale must cite evidence — an uncited layer verdict is an opinion.
  const rationale = report.fault_localization?.rationale || '';
  if (!/EV-\d{2,3}/.test(rationale)) {
    errors.push('fault_localization.rationale: must cite at least one evidence id (EV-NN) — an uncited layer verdict is not actionable');
  } else {
    for (const cited of rationale.match(/EV-\d{2,3}/g) || []) {
      if (!evidenceIds.has(cited)) errors.push(`fault_localization.rationale: cites ${cited} which does not exist in evidence[]`);
    }
  }

  // Warnings: shape problems that reduce usefulness without invalidating.
  if (!report.boundary?.correlation_id && isIntegrationDefect(report)) {
    warnings.push('boundary.correlation_id is absent on an integration defect — cross-layer evidence cannot be tied together; capture a trace/request id if at all possible');
  }
  if (isIntegrationDefect(report) && !report.boundary?.contract_delta?.diffs?.length) {
    warnings.push('defect_type is integration-* but boundary.contract_delta.diffs is empty — the payload mismatch is the finding, so state it');
  }
  const layers = new Set((report.evidence || []).map((e) => e.layer));
  if (isIntegrationDefect(report) && !(layers.has('ui') && (layers.has('network') || layers.has('backend')))) {
    warnings.push('integration defect has evidence from only one layer — the correlation that makes it diagnosable is missing');
  }
  if (!(report.timeline || []).length && (report.evidence || []).length > 1) {
    warnings.push('timeline is empty — ordering across layers is what makes a 200-OK-but-broken-UI defect legible');
  } else if ((report.timeline || []).length) {
    // An explicit timeline that disagrees with the recorded times renders in a
    // visibly wrong order, which reads as a broken report even when every
    // field is valid. Left as a warning, not an error: an author may
    // deliberately order by causality rather than by clock.
    const chronological = lib.buildTimeline(report.evidence);
    const declared = report.timeline.filter((id) => chronological.includes(id));
    const outOfOrder = declared.join(',') !== chronological.filter((id) => declared.includes(id)).join(',');
    if (outOfOrder) {
      warnings.push(
        `timeline order disagrees with the recorded timestamps/offsets (declared ${declared.join(' → ')}, chronological ${chronological.join(' → ')}) — intentional only if you are ordering by causality rather than clock`
      );
    }
    const untracked = (report.evidence || []).filter((e) => !report.timeline.includes(e.id)).map((e) => e.id);
    if (untracked.length) {
      warnings.push(`timeline omits ${untracked.join(', ')} — every evidence item should appear, or a reader cannot tell when it was observed`);
    }
  }
  for (const c of report.components || []) {
    if (!c.source_file) warnings.push(`${c.id} (${c.framework_component || c.selector}) has no source_file — the assignee has to find the code themselves`);
    if (c.detection_method === 'inferred') warnings.push(`${c.id}: framework_component was inferred, not detected — verify before trusting it`);
  }
  if ((report.reproduction?.executable?.steps || []).length && !report.reproduction.executable.verified_replayable) {
    warnings.push('reproduction.executable present but verified_replayable is not true — run the steps before asserting they replay');
  }

  return { errors, warnings };
}

function isIntegrationDefect(report) {
  return String(report.classification?.defect_type || '').startsWith('integration-');
}

function findDuplicates(list) {
  const seen = new Set();
  const dupes = new Set();
  for (const item of list) {
    if (seen.has(item)) dupes.add(item);
    seen.add(item);
  }
  return [...dupes];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Renumber ids sequentially and rewrite every reference to match. */
function normalizeIds(report) {
  const evMap = {};
  (report.evidence || []).forEach((e, i) => {
    const next = lib.evidenceId(i);
    if (e.id && e.id !== next) evMap[e.id] = next;
    e.id = next;
  });
  const cMap = {};
  (report.components || []).forEach((c, i) => {
    const next = lib.componentId(i);
    if (c.id && c.id !== next) cMap[c.id] = next;
    c.id = next;
  });

  const remapEv = (id) => evMap[id] || id;
  if (report.fault_localization) {
    report.fault_localization.evidence_refs = (report.fault_localization.evidence_refs || []).map(remapEv);
    for (const alt of report.fault_localization.alternatives || []) {
      alt.ruled_out_by = (alt.ruled_out_by || []).map(remapEv);
    }
    if (report.fault_localization.rationale) {
      report.fault_localization.rationale = report.fault_localization.rationale.replace(
        /EV-\d{2,3}/g,
        (m) => remapEv(m)
      );
    }
  }
  report.timeline = (report.timeline || []).map(remapEv);
  for (const e of report.evidence || []) {
    if (e.component_ref) e.component_ref = cMap[e.component_ref] || e.component_ref;
  }
  return report;
}

function main() {
  const args = lib.parseArgs(process.argv.slice(2));
  const started = Date.now();
  const source = args.fixture || args.report;

  if (!source) {
    lib.fail(OP, 'Missing --fixture or --report: a draft report (any completeness) is required as input.', [
      'node build-report.js --fixture evals/fixtures/fe-be-contract-drift.json --out /tmp/report.json',
    ]);
  }
  if (!fs.existsSync(source)) lib.fail(OP, `Input not found: ${source}`);

  let report;
  try {
    report = lib.extractReport(lib.readJson(source)) || lib.readJson(source);
  } catch (err) {
    lib.fail(OP, `Could not parse ${source}: ${err.message}`);
  }

  // Fold in a capture produced by capture-dom-context.js.
  if (args.capture) {
    if (!fs.existsSync(args.capture)) lib.fail(OP, `Capture file not found: ${args.capture}`);
    const capDoc = lib.readJson(args.capture);
    const cap = capDoc.output?.capture || capDoc;
    report.components = [...(report.components || []), ...(cap.components || [])];
    report.evidence = [...(report.evidence || []), ...(cap.evidence || [])];
    report.attachments = [...(report.attachments || []), ...(cap.attachments || [])];
  }

  // Derived fields — always recomputed, never trusted from input.
  report.schema_version = lib.SCHEMA_VERSION;
  normalizeIds(report);
  lib.applyOffsets(report.evidence || []);
  if (!(report.timeline || []).length) report.timeline = lib.buildTimeline(report.evidence);
  report.fingerprint = lib.fingerprint(report);
  report.provenance = {
    ...(report.provenance || {}),
    generated_by: `${lib.SKILL_NAME}@${lib.SKILL_VERSION}`,
    generated_at: new Date().toISOString(),
    redaction: report.provenance?.redaction || { applied: false },
  };

  const errors = [];
  validateNode(report, SCHEMA, 'report', errors, SCHEMA.$defs || {});
  const refs = validateReferences(report);
  errors.push(...refs.errors);
  const warnings = refs.warnings;

  if (errors.length > 0) {
    lib.emit(
      lib.envelope(OP, 'failed', {
        summary: `Report failed validation with ${errors.length} error(s). It is not safe to file — a consumer would trip over these.`,
        report,
        fingerprint: report.fingerprint,
        errors,
        warnings,
        remediation: ['Fix each error above and re-run', 'Errors block filing; warnings do not'],
      })
    );
  }

  if (args.strict && warnings.length > 0) {
    lib.emit(
      lib.envelope(OP, 'failed', {
        summary: `Report is schema-valid but --strict was requested and ${warnings.length} warning(s) remain.`,
        report,
        fingerprint: report.fingerprint,
        warnings,
        remediation: ['Resolve the warnings, or drop --strict to accept them'],
      })
    );
  }

  if (args.out) lib.writeJson(args.out, report);

  const layers = [...new Set((report.evidence || []).map((e) => e.layer))].sort();
  lib.emit(
    lib.envelope(
      OP,
      warnings.length ? 'partial' : 'success',
      {
        summary:
          `Built a valid defect report: ${report.components.length} component(s), ${report.evidence.length} evidence item(s) ` +
          `across ${layers.length} layer(s) (${layers.join(', ')}), suspected layer "${report.fault_localization.suspected_layer}" ` +
          `at ${report.fault_localization.confidence} confidence. Fingerprint ${report.fingerprint} — search the tracker for it before filing.` +
          (warnings.length ? ` ${warnings.length} warning(s) to review.` : '') +
          (args.out ? ` Written to ${args.out}.` : ''),
        report,
        fingerprint: report.fingerprint,
        warnings,
      },
      {
        metadata: {
          executionTimeMs: Date.now() - started,
          evidenceCount: report.evidence.length,
          componentCount: report.components.length,
        },
      }
    )
  );
}

main();
