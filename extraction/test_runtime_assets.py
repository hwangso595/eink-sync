"""
Guard: every module the spawned scripts import must actually ship.

RUNTIME_PY_FILES (scripts/runtime-assets.mjs) is hand-maintained, and it is
what both the embedded bundle and the dev install copy. A module missing from
it does not fail the build -- it fails at runtime, inside a subprocess, as an
ImportError that surfaces only as pages mysteriously not rendering. That is
exactly what happened when template_renderer.py was added.

So this walks the real import graph from the two entry points the TypeScript
bridge spawns and asserts the list covers it.
"""

import ast
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME_ASSETS_MJS = os.path.join(HERE, '..', 'scripts', 'runtime-assets.mjs')

# The scripts spawned by python-bridge.ts and page-image-renderer.ts.
ENTRY_POINTS = ['extract.py', 'render_pages.py']


def declared_runtime_files():
    """Parse RUNTIME_PY_FILES out of the .mjs single source of truth."""
    with open(RUNTIME_ASSETS_MJS, 'r', encoding='utf-8') as f:
        source = f.read()
    block = re.search(r'RUNTIME_PY_FILES\s*=\s*\[(.*?)\]', source, re.S)
    assert block, 'RUNTIME_PY_FILES not found in runtime-assets.mjs'
    return set(re.findall(r"'([^']+\.py)'", block.group(1)))


def local_imports(path):
    """Module names imported by `path` that resolve to files in extraction/."""
    with open(path, 'r', encoding='utf-8') as f:
        tree = ast.parse(f.read(), filename=path)

    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name.split('.')[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            # level > 0 would be a relative import; extraction/ is flat.
            if node.module and node.level == 0:
                names.add(node.module.split('.')[0])

    return {n for n in names if os.path.exists(os.path.join(HERE, f'{n}.py'))}


def import_closure(entry_points):
    """Transitive closure of local imports, including the entry points."""
    seen, queue = set(), list(entry_points)
    while queue:
        current = queue.pop()
        if current in seen:
            continue
        seen.add(current)
        for module in local_imports(os.path.join(HERE, current)):
            queue.append(f'{module}.py')
    return seen


class TestRuntimeAssets(unittest.TestCase):
    def test_every_imported_module_is_shipped(self):
        missing = import_closure(ENTRY_POINTS) - declared_runtime_files()
        self.assertEqual(
            missing, set(),
            f'These modules are imported at runtime but missing from '
            f'RUNTIME_PY_FILES, so they will not be installed: {sorted(missing)}',
        )

    def test_shipped_files_all_exist(self):
        absent = {f for f in declared_runtime_files()
                  if not os.path.exists(os.path.join(HERE, f))}
        self.assertEqual(absent, set(), f'Listed but missing from extraction/: {sorted(absent)}')

    def test_no_test_files_are_shipped(self):
        shipped = declared_runtime_files()
        self.assertEqual({f for f in shipped if f.startswith('test_')}, set())


if __name__ == '__main__':
    unittest.main()
