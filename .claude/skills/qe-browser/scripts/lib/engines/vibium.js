'use strict';
/**
 * Vibium backend — the AQE default engine (ADR-091).
 *
 * This is a verbatim extraction of the spawnSync call that lived in
 * lib/vibium.js before the engine abstraction landed. It is deliberately
 * unchanged: the Vibium path is what every existing caller and all 11
 * migrated skills run today, so the refactor must not alter its behaviour.
 */

const { spawnSync } = require('node:child_process');

const ENGINE_ID = 'vibium';

/**
 * Add `--headless` only when resolveHeadless() says no window can open (CI,
 * containers, Linux without a display). Elsewhere the browser runs headed,
 * Vibium's own default. An explicit `--headless`/`--headed` from the caller
 * always wins — the smoke test and eval suite pass `--headless` themselves.
 */
function injectHeadless(args) {
  if (args.includes('--headless') || args.includes('--headed')) return args;
  // Required lazily: engine.js requires this module from backend().
  const { resolveHeadless } = require('../engine');
  return resolveHeadless().headless ? ['--headless', ...args] : args;
}

function isUnavailable(result) {
  return Boolean(result.error && result.error.code === 'ENOENT');
}

function run(args, { input, timeoutMs = 30000 } = {}) {
  const finalArgs = injectHeadless(args);
  const result = spawnSync('vibium', finalArgs, {
    encoding: 'utf8',
    input,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (isUnavailable(result)) {
    return {
      unavailable: true,
      message:
        'vibium binary not found on PATH. Install via `npm install -g vibium` or run `aqe init`.',
    };
  }

  return {
    status: result.status,
    stdout: (result.stdout || '').toString(),
    stderr: (result.stderr || '').toString(),
  };
}

module.exports = { ENGINE_ID, run };
