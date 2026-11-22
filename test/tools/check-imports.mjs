/**
 * Verifies static and dynamic relative imports (and their named exports)
 * resolve to real modules. Run: node test/tools/check-imports.mjs
 */
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dirs = ['src', 'Solana', 'PostgreSQL', 'config', 'scripts', 'test'];
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
  }
}

for (const dir of dirs) {
  try {
    await walk(path.join(root, dir));
  } catch {
    // directory may not exist
  }
}

const staticImport = /^[ \t]*(?:import|export)\s+([^;]*?)\s+from\s+['"](\.[^'"]+)['"]/gm;
const sideEffectImport = /^\s*import\s+['"](\.[^'"]+)['"]/gm;
const dynamicImport = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

let problems = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const relative = path.relative(root, file);
  const specs = [];

  for (const match of source.matchAll(staticImport)) specs.push({ clause: match[1], spec: match[2] });
  for (const match of source.matchAll(sideEffectImport)) specs.push({ clause: '', spec: match[1] });
  for (const match of source.matchAll(dynamicImport)) specs.push({ clause: '', spec: match[1] });

  for (const { clause, spec } of specs) {
    const target = path.resolve(path.dirname(file), spec);

    try {
      await readFile(target.endsWith('.js') ? target : `${target}.js`);
    } catch (error) {
      problems += 1;
      console.log(`FAIL file ${relative} -> ${spec}: ${error.code ?? error.message}`);
      continue;
    }

    let module;

    try {
      module = await import(pathToFileURL(target).href);
    } catch (error) {
      problems += 1;
      console.log(`FAIL load ${relative} -> ${spec}: ${error.code ?? error.message}`);
      continue;
    }

    const named = [];

    if (clause.trim().startsWith('{')) {
      const inner = clause.slice(clause.indexOf('{') + 1, clause.lastIndexOf('}'));
      for (const part of inner.split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) named.push(name);
      }
    } else {
      const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/);
      if (defaultMatch && !clause.trim().startsWith('*')) named.push('default');

      const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (namespaceMatch) named.length = 0;
    }

    for (const name of named) {
      if (!(name in module)) {
        problems += 1;
        console.log(`FAIL export ${relative} -> ${spec}: missing "${name}"`);
      }
    }
  }
}

console.log(`checked ${files.length} files, problems: ${problems}`);
process.exitCode = problems === 0 ? 0 : 1;
