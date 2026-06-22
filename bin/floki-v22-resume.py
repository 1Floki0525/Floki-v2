#!/usr/bin/env python3

import py_compile
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path('/media/binary-god/1tb-ssd/Floki-v2')
REMOTE_INSTALLER = 'bin/floki-neural-interface-full-function-repair-v22.py'
BROKEN_LAUNCHER = 'bin/run-floki-v22-repair.py'
RESUME_SCRIPT = 'bin/floki-v22-resume.py'
LOCAL_ONLY_PATH = '/docs/snapshot-terminal-command.md'
ALLOWED_DIRTY = {REMOTE_INSTALLER, BROKEN_LAUNCHER}


def run(args, *, check=True):
    result = subprocess.run([str(item) for item in args], cwd=str(ROOT), text=True, capture_output=True)
    if result.stdout:
        print(result.stdout, end='' if result.stdout.endswith('\n') else '\n', flush=True)
    if result.stderr:
        print(result.stderr, end='' if result.stderr.endswith('\n') else '\n', file=sys.stderr, flush=True)
    if check and result.returncode != 0:
        raise RuntimeError('command failed (%d): %s' % (result.returncode, ' '.join(map(str, args))))
    return result


def git_output(*args):
    result = subprocess.run(['git', *args], cwd=str(ROOT), text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or 'git command failed')
    return result.stdout.strip()


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def ensure_local_only_exclude():
    exclude_file = ROOT / '.git' / 'info' / 'exclude'
    exclude_file.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude_file.read_text(encoding='utf-8') if exclude_file.exists() else ''
    entries = {line.strip() for line in existing.splitlines()}
    if LOCAL_ONLY_PATH not in entries:
        with exclude_file.open('a', encoding='utf-8') as handle:
            if existing and not existing.endswith('\n'):
                handle.write('\n')
            handle.write(LOCAL_ONLY_PATH + '\n')
    print('[floki-v22] local-only Git exclusion verified: ' + LOCAL_ONLY_PATH, flush=True)


def main():
    if not (ROOT / '.git').is_dir():
        raise RuntimeError(f'Floki-v2 repository is missing: {ROOT}')
    if git_output('branch', '--show-current') != 'main':
        raise RuntimeError('main branch is required')

    ensure_local_only_exclude()

    staged = {line for line in git_output('diff', '--cached', '--name-only').splitlines() if line}
    unstaged = {line for line in git_output('diff', '--name-only').splitlines() if line}
    unexpected = sorted((staged | unstaged) - ALLOWED_DIRTY)
    if unexpected:
        raise RuntimeError('unrelated tracked changes must be preserved: ' + ', '.join(unexpected))

    run(['git', 'fetch', 'origin', 'main'])
    local = git_output('rev-parse', 'HEAD')
    remote = git_output('rev-parse', 'origin/main')
    if local != remote:
        if git_output('merge-base', 'HEAD', 'origin/main') != local:
            raise RuntimeError('local main is not a safe fast-forward of origin/main')
        run(['git', 'merge', '--ff-only', 'origin/main'])

    pristine = git_output('show', f'origin/main:{REMOTE_INSTALLER}')
    patched = pristine.replace(r"\'use strict\';", "'use strict';")
    patched = replace_once(
        patched,
        "        if git('diff', '--cached', '--name-only') or git('diff', '--name-only'): raise RepairError('tracked tree must be clean')",
        "        staged_before = [item for item in git('diff', '--cached', '--name-only').splitlines() if item]\n        dirty_before = [item for item in git('diff', '--name-only').splitlines() if item]\n        allowed_dirty = {str(SELF), 'bin/run-floki-v22-repair.py'}\n        unexpected_before = [item for item in staged_before + dirty_before if item not in allowed_dirty]\n        if unexpected_before: raise RepairError('unrelated tracked changes must be preserved: ' + ', '.join(sorted(set(unexpected_before))))",
        'clean-tree guard',
    )
    patched = replace_once(
        patched,
        "      'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs', 'package.json', str(SELF)",
        "      'tests/manual-nap-contract-test.cjs', 'apps/floki-neural-interface/tests/functional-controls-contract.cjs', 'package.json', str(SELF), 'bin/run-floki-v22-repair.py', 'bin/floki-v22-resume.py', 'tests/chat-local-single-runtime-contract-test.cjs', 'tests/chat-local-interface-lifecycle-transcript-contract-test.cjs'",
        'repair-file target list',
    )
    patched = replace_once(
        patched,
        "        (ROOT / SELF).unlink()",
        "        (ROOT / SELF).unlink(missing_ok=True)\n        (ROOT / 'bin/run-floki-v22-repair.py').unlink(missing_ok=True)\n        (ROOT / 'bin/floki-v22-resume.py').unlink(missing_ok=True)",
        'repair-file cleanup',
    )
    patched = replace_once(
        patched,
        "        if 'start_hhmm: 23:00' not in (ROOT / 'config/chat.config.yaml').read_text() or 'end_hhmm: 07:00' not in (ROOT / 'config/chat.config.yaml').read_text(): raise RepairError('nightly schedule changed')",
        "        run(['bash', 'bin/floki-node24-run.sh', 'node', '-e', \"const { loadYamlFile } = require('./src/config/yaml-lite.cjs'); const sleep = loadYamlFile('./config/chat.config.yaml').sleep || {}; if (String(sleep.start_hhmm) !== '23:00' || String(sleep.end_hhmm) !== '07:00') { console.error(JSON.stringify({ start_hhmm: sleep.start_hhmm, end_hhmm: sleep.end_hhmm })); process.exit(1); } console.log('FLOKI_V22_NIGHTLY_SCHEDULE_SEMANTIC_PASS');\"], timeout=120)",
        'nightly schedule semantic verification',
    )
    patched = replace_once(
        patched,
        "        patch_files()",
        "        patch_files()\n        old_gate_assertion = \"  assert.match(runtime, /await liveAudio\\\\.setAwake\\\\(enableSenses\\\\)/);\\n\"\n        new_gate_assertions = \"  assert.match(runtime, /await liveAudio\\\\.setAwake\\\\(hearingEnabled\\\\)/);\\n  assert.match(runtime, /const visionEnabled = awake && state\\\\.client_ready === true/);\\n  assert.match(runtime, /if \\\\(!visionEnabled\\\\)/);\\n\"\n        for contract_relative in ['tests/chat-local-single-runtime-contract-test.cjs', 'tests/chat-local-interface-lifecycle-transcript-contract-test.cjs']:\n            contract_path = ROOT / contract_relative\n            contract_text = contract_path.read_text(encoding='utf-8')\n            contract_text = replace(contract_text, old_gate_assertion, new_gate_assertions, 'split hearing and vision lifecycle contract')\n            contract_path.write_text(contract_text, encoding='utf-8')",
        'split sensory lifecycle contract updates',
    )

    temp = tempfile.TemporaryDirectory(prefix='floki-v22-resume-', dir='/tmp')
    try:
        installer = Path(temp.name) / 'floki-v22-fixed-installer.py'
        bytecode = Path(temp.name) / 'floki-v22-fixed-installer.pyc'
        installer.write_text(patched + '\n', encoding='utf-8')
        py_compile.compile(str(installer), cfile=str(bytecode), doraise=True)
        result = subprocess.run([sys.executable, str(installer)], cwd=str(ROOT))
        raise SystemExit(result.returncode)
    finally:
        temp.cleanup()


if __name__ == '__main__':
    main()
