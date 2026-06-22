#!/usr/bin/env python3

import py_compile
import subprocess
import sys
from pathlib import Path

ROOT = Path('/media/binary-god/1tb-ssd/Floki-v2')
INSTALLER = ROOT / 'bin/floki-neural-interface-full-function-repair-v22.py'
LAUNCHER_REL = 'bin/run-floki-v22-repair.py'


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def main():
    if not INSTALLER.is_file():
        raise RuntimeError(f'installer is missing: {INSTALLER}')

    text = INSTALLER.read_text(encoding='utf-8')
    text = text.replace("\\'use strict\\';", "'use strict';")

    text = replace_once(
        text,
        "        if git('diff', '--cached', '--name-only') or git('diff', '--name-only'): raise RepairError('tracked tree must be clean')",
        "        staged_before = [item for item in git('diff', '--cached', '--name-only').splitlines() if item]\n        dirty_before = [item for item in git('diff', '--name-only').splitlines() if item]\n        unexpected_before = [item for item in staged_before + dirty_before if item != str(SELF)]\n        if unexpected_before: raise RepairError('tracked tree must be clean outside the installer: ' + ', '.join(unexpected_before))",
        'installer clean-tree allowance',
    )
    text = replace_once(
        text,
        "      'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs', 'package.json', str(SELF)",
        "      'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs', 'package.json', str(SELF), '" + LAUNCHER_REL + "'",
        'launcher target registration',
    )
    text = replace_once(
        text,
        "        (ROOT / SELF).unlink()",
        "        (ROOT / SELF).unlink()\n        (ROOT / '" + LAUNCHER_REL + "').unlink()",
        'self-cleanup registration',
    )

    INSTALLER.write_text(text, encoding='utf-8')
    py_compile.compile(str(INSTALLER), doraise=True)

    result = subprocess.run([sys.executable, str(INSTALLER)], cwd=str(ROOT))
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
