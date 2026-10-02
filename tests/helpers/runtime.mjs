import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export const themesDirectory = join(packageRoot, 'themes');
export const extensionPath = join(packageRoot, 'extensions', 'slate-ui.ts');
export const agentRoot = process.env.PI_TEST_AGENT_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const agentRequire = createRequire(join(agentRoot, 'package.json'));
export const tuiEntry = pathToFileURL(agentRequire.resolve('@earendil-works/pi-tui')).href;
export const importAgent = (path) => import(pathToFileURL(join(agentRoot, 'dist', path)).href);

// Native theme discovery must never depend on the developer's personal Pi setup.
// Every process gets its own fixture, including rendering subprocesses.
export const fixtureDirectory = mkdtempSync(join(tmpdir(), 'pi-customizations-test-'));
export const agentDirectory = join(fixtureDirectory, 'agent');
mkdirSync(agentDirectory);
cpSync(themesDirectory, join(agentDirectory, 'themes'), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDirectory;
process.once('exit', () => rmSync(fixtureDirectory, { recursive: true, force: true }));
