import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { importAgent, themesDirectory as directory } from './helpers/runtime.mjs';

const { loadThemeFromPath, setThemeJsonValidator, getAvailableThemes } = await importAgent('modes/interactive/theme/theme.js');
const { validateThemeJson } = await importAgent('modes/interactive/theme/theme-json.js');
setThemeJsonValidator(validateThemeJson);
const originalJson = JSON.parse(readFileSync(`${directory}/slate-cyan.json`, 'utf8'));
const original = loadThemeFromPath(`${directory}/slate-cyan.json`, 'truecolor');
const presets = {
  cyan: '#56B6C2', blue: '#61AFEF', violet: '#BB9AF7',
  rose: '#F88FA6', amber: '#E5C07B', green: '#98C379',
};
const ansi = hex => `\x1b[38;2;${hex.slice(1).match(/../g).map(v => parseInt(v, 16)).join(';')}m`;
const luminance = hex => hex.slice(1).match(/../g)
  .map(v => parseInt(v, 16) / 255)
  .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const available = getAvailableThemes();
for (const [color, hex] of Object.entries(presets)) {
  test(`slate-${color}: theme validation and rendering regressions`, () => {
    const name = `slate-${color}`;
    const path = `${directory}/${name}.json`;
    assert(available.includes(name), `${name} missing from native theme discovery`);
    const json = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(json.name, name);
    assert.deepEqual(json.export, originalJson.export, 'export backgrounds changed');
    for (const mode of ['truecolor', '256color']) {
      const theme = loadThemeFromPath(path, mode);
      assert.equal(theme.name, name);
      assert.equal(theme.appearance, 'dark');
      for (const role of ['selectedBg', 'searchMatchBg', 'userMessageBg', 'customMessageBg', 'toolPendingBg', 'toolSuccessBg', 'toolErrorBg']) {
        assert.equal(theme.getBgAnsi(role), loadThemeFromPath(`${directory}/slate-cyan.json`, mode).getBgAnsi(role), `${name}: ${role} changed`);
      }
      for (const role of ['text', 'muted', 'dim', 'success', 'error', 'warning', 'toolDiffAdded', 'toolDiffRemoved']) {
        assert.deepEqual(theme.colors[role], original.colors[role], `${name}: semantic color ${role} changed`);
      }
      if (mode === 'truecolor') {
        assert.equal(theme.getFgAnsi('accent'), ansi(hex));
        assert.equal(theme.getFgAnsi('borderAccent'), ansi(hex));
        assert.equal(theme.getFgAnsi('mdCode'), ansi(hex));
        if (color === 'cyan') assert.deepEqual(theme.colors, original.colors, 'cyan no longer matches the existing palette');
      }
    }
    for (const background of ['#1F1F28', '#292936', '#363646']) {
      for (const foreground of [json.vars.accentColor, json.vars.brightAccent]) {
        assert(contrast(foreground, background) >= 4.5, `${name}: accent contrast is too low on ${background}`);
      }
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./helpers/slate-rendering.mjs', import.meta.url))], {
      env: { ...process.env, SLATE_TEST_THEME: path }, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(result.status, 0, `${name}: rendering regressions failed\n${result.stdout}\n${result.stderr}`);
  });
}
