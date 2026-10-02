import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extensionPath, fixtureDirectory, importAgent, packageRoot } from './helpers/runtime.mjs';

const { DefaultResourceLoader } = await importAgent('core/resource-loader.js');
const { SettingsManager } = await importAgent('core/settings-manager.js');
const { setThemeJsonValidator } = await importAgent('modes/interactive/theme/theme.js');
const { validateThemeJson } = await importAgent('modes/interactive/theme/theme-json.js');
setThemeJsonValidator(validateThemeJson);

const expectedThemes = ['amber', 'blue', 'cyan', 'green', 'rose', 'violet'].map(color => `slate-${color}`);

async function loadPackage(source, name) {
  const directory = join(fixtureDirectory, name);
  mkdirSync(directory);
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ packages: [source] }),
    noContextFiles: true,
  });
  await loader.reload();
  return loader;
}

function verifyThemes(loader) {
  const { themes, diagnostics } = loader.getThemes();
  assert.deepEqual(diagnostics, []);
  const names = themes.map(theme => theme.name);
  for (const name of expectedThemes) assert(names.includes(name), `missing packaged theme ${name}`);
  assert.equal(new Set(names).size, names.length, 'duplicate theme names');
}

test('native Pi discovery loads the package extension and all six themes', async () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert(manifest.keywords.includes('pi-package'));
  assert(!manifest.dependencies, 'host-provided Pi libraries must not be runtime dependencies');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-coding-agent'], '*');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-tui'], '*');
  const loader = await loadPackage(packageRoot, 'full-package');
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const paths = loaded.extensions.filter(extension => extension.path.startsWith(packageRoot)).map(extension => extension.path);
  assert(paths.includes(extensionPath), 'Slate UI missing from package discovery');
  assert.equal(new Set(paths).size, paths.length, 'duplicate extension discovery');
  verifyThemes(loader);
});

test('package filtering can disable Slate UI without disabling the themes', async () => {
  const loader = await loadPackage({ source: packageRoot, extensions: [] }, 'themes-only');
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert(!loaded.extensions.some(extension => extension.path === extensionPath));
  verifyThemes(loader);
});
