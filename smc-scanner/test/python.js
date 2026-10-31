'use strict';
// Python for the MT5 helper tests (mt5_bars.py): python3 on Linux and macOS, python on Windows;
// PYTHON overrides. On a PC without a working Python 3 (the MT5 expert route needs none, and on
// Windows "python" is often only the Microsoft Store shortcut) those tests are skipped with the
// reason. In CI (CI=true) they always run, so a missing Python fails there instead of hiding.
const { spawnSync } = require('node:child_process');

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const r = spawnSync(PY, ['-I', '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 20000 });
const works = !r.error && r.status === 0 && String(r.stdout || '').trim() === '3';
const skip = works || process.env.CI ? false
  : `needs Python 3 ("${PY}" did not run it). Only the MT5 Python route uses Python; the MT5 expert route does not.`;

module.exports = { PY, skip };
