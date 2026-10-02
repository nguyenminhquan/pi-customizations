import assert from 'node:assert/strict';
import { join } from 'node:path';
import { importAgent, tuiEntry, extensionPath, packageRoot, themesDirectory, fixtureDirectory } from './runtime.mjs';
const { loadExtensions } = await importAgent('core/extensions/loader.js');
const { loadThemeFromPath, setThemeJsonValidator, setThemeInstance, getEditorTheme } = await importAgent('modes/interactive/theme/theme.js');
const { validateThemeJson } = await importAgent('modes/interactive/theme/theme-json.js');
const { KeybindingsManager } = await importAgent('core/keybindings.js');
const { createInteractiveTuiReference } = await importAgent('modes/interactive/tui-renderer.js');
const { createChatViewport } = await importAgent('modes/interactive/chat-viewport.js');
const { CURSOR_MARKER, visibleWidth, stripTerminalSequences, CombinedAutocompleteProvider, TuiAltScreen, TuiMainScreen, Text, Spacer } = await import(tuiEntry);
const strip = s => stripTerminalSequences(s);
setThemeJsonValidator(validateThemeJson);
const theme = loadThemeFromPath(process.env.SLATE_TEST_THEME ?? join(themesDirectory, 'slate-cyan.json'), 'truecolor');
setThemeInstance(theme);
assert.equal(theme.getBgAnsi('toolSuccessBg'), theme.getBgAnsi('toolPendingBg'));
const loaded = await loadExtensions([extensionPath], packageRoot);
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
let editorFactory, footerFactory, spinner, editor;
const writes = [];
const terminal = { rows: 30, columns: 120, write: data => writes.push(data), start() {}, stop() {}, hideCursor() {}, showCursor() {} };
const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
const originalNormalizer = tui.applyLineResets;
const originalSetRoot = tui.setLayoutRoot;
const originalComposite = tui.compositeOverlays;
let activeTui = tui;
const tuiReference = createInteractiveTuiReference(() => activeTui);
const exitListenersBefore = process.listenerCount('exit');
const ctx = {
  mode: 'tui', cwd: packageRoot, thinkingLevel: 'high',
  model: { id: 'test-model', name: 'Test Model', provider: 'test-provider' },
  getContextUsage: () => ({ percent: 36 }),
  sessionManager: { getBranch: () => [{ type: 'message', message: { role: 'assistant', usage: { cost: { total: 0.234 } } } }] },
  ui: { theme, setEditorComponent: f => { editorFactory = f; editor = f(tuiReference, getEditorTheme(), new KeybindingsManager()); }, setFooter: f => footerFactory = f, setWorkingIndicator: x => spinner = x },
};
for (const handler of extension.handlers.get('session_start')) await handler({ type: 'session_start' }, ctx);
assert.equal(spinner.frames.length, 10);
assert.deepEqual(writes, [], 'no terminal-default background controls');
assert.notEqual(tui.applyLineResets, originalNormalizer);
assert.equal(process.listenerCount('exit'), exitListenersBefore);
editor.focused = true;
let cases = 0;
for (const text of ['', 'hello', '你好 café 👋', '─'.repeat(90), 'x'.repeat(300), Array.from({length: 30}, (_, i) => `line ${i}`).join('\n')]) {
  editor.setText(text);
  for (const width of [1, 2, 3, 4, 10, 20, 80, 120]) {
    const lines = editor.render(width);
    assert(lines.every(line => visibleWidth(line) <= width), `overflow ${width}`);
    assert(lines.some(line => line.includes(CURSOR_MARKER)), `missing cursor ${width} for ${JSON.stringify(text)}`);
    assert(lines.every(line => !line.includes('pi-slate-panel-end')), 'sentinel leaked');
    assert(lines.every(line => !/[╭╮╰╯]/u.test(strip(line))), 'outline returned');
    assert(lines.every(line => line.includes(theme.getBgAnsi('selectedBg'))), 'missing panel fill');
    cases++;
  }
}
editor.setText('hello');
let lines = editor.render(80);
assert.equal(lines.length, 5);
assert(strip(lines[3]).includes('Prompt · Test Model · test-provider · high'));
editor.handleMouse({ type: 'click', button: 'left', x: 3, y: 1, width: 80, height: 5 });
assert.equal(editor.getCursor().col, 1, 'rail offset mouse positioning');
editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'settings', description: 'Settings' }, { name: 'session', description: 'Session' }], fixtureDirectory));
editor.setText('/s');
editor.handleInput('\t');
await new Promise(r => setTimeout(r, 150));
lines = editor.render(80);
assert.equal(lines.length, 5, 'autocomplete increased input layout height');
assert.equal(lines.findIndex(line => line.includes(CURSOR_MARKER)), 1, 'cursor moved with completions');
const preview = tui.compositeOverlays([...Array(terminal.rows - 5).fill(''), ...lines], terminal.columns, terminal.rows);
const popupPreview = tui.renderedOverlayLayouts.at(-1);
assert(popupPreview, 'autocomplete overlay missing');
assert.equal(popupPreview.row + popupPreview.height, terminal.rows - 5, 'popup not attached above prompt');
assert(preview.slice(popupPreview.row, popupPreview.row + popupPreview.height).some(line => strip(line).includes('settings')), 'floating commands missing');
assert.equal(strip(preview[popupPreview.row]).replace('▏', '').trim(), '', 'popup top padding is not blank');
const popupClick = y => tui.dispatchMouseToOverlay({ type: 'click', button: 'left', screenX: 4, screenY: popupPreview.row + y });
popupClick(0);
assert.equal(editor.getText(), '/s', 'popup padding click selected a command');
assert.equal(popupClick(1).result.focus, false, 'popup click stole input focus');
assert.equal(editor.getText(), '/settings ', 'floating autocomplete mouse row mapping');
// Keyboard navigation and dismissal remain native to the base editor.
editor.setText('/s');
editor.handleInput('\t');
await new Promise(r => setTimeout(r, 150));
editor.handleInput('\x1b[B');
editor.handleInput('\t');
assert.equal(editor.getText(), '/session ', 'keyboard completion selection changed');
editor.setText('/s');
editor.handleInput('\t');
await new Promise(r => setTimeout(r, 150));
editor.handleInput('\x1b');
assert.equal(editor.render(80).length, 5, 'Escape changed input height');
assert.equal(tui.hasOverlayEntries, false, 'Escape left a popup entry mounted');
const footer = footerFactory(tuiReference, theme, { getGitBranch: () => 'main', onBranchChange: () => () => {}, getExtensionStatuses: () => new Map([['test', 'AFT status']]) });
for (const width of [1, 2, 10, 80, 120]) assert(footer.render(width).every(line => visibleWidth(line) <= width));
assert(strip(footer.render(120)[0]).includes('ctx 36% · $0.23'));
assert(footer.render(120)[1].includes('AFT status'));
footer.dispose();
const shutdown = async () => { for (const h of extension.handlers.get('session_shutdown')) await h({ type: 'session_shutdown' }, ctx); };
const start = async (context = ctx) => { for (const h of extension.handlers.get('session_start')) await h({ type: 'session_start' }, context); };
const base = '31,31,40';
// Inspect the actual background painted under each character, not merely the
// presence of one color escape somewhere in a mocked terminal write.
function cellBackgrounds(line) {
  let bg = null;
  const result = [];
  for (const match of line.matchAll(/\x1b\[([\d;:]*)m|\x1b\][^\x07]*(?:\x07)|([^\x1b])/g)) {
    if (match[1] !== undefined) {
      const codes = match[1].split(';').map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0 || code === 49) bg = null;
        else if (code === 48 && codes[i + 1] === 2) { bg = codes.slice(i + 2, i + 5).join(','); i += 4; }
        else if (code === 48 && codes[i + 1] === 5) { bg = `index:${codes[i + 2]}`; i += 2; }
        else if ((code === 38 || code === 58) && codes[i + 1] === 2) i += 4;
        else if ((code === 38 || code === 58) && codes[i + 1] === 5) i += 2;
      }
    } else if (match[2]) {
      for (let n = 0; n < visibleWidth(match[2]); n++) result.push(bg);
    }
  }
  return result;
}
for (const sample of ['', 'hello', '\x1b[0mhello', '\x1b[mhello', '\x1b[39;49mhello', '\x1b[38;2;0;49;0mhello']) {
  const painted = tui.applyLineResets([sample])[0];
  const backgrounds = cellBackgrounds(painted);
  assert.equal(backgrounds.length, terminal.columns);
  assert(backgrounds.every(bg => bg === base), `default pixels in ${JSON.stringify(sample)}`);
}
const explicit = tui.applyLineResets(['\x1b[0;48;2;40;40;40mPanel\x1b[49m gap'])[0];
assert(cellBackgrounds(explicit).slice(0, 5).every(bg => bg === '40,40,40'), 'panel reset overwritten');
assert(cellBackgrounds(explicit).slice(5).every(bg => bg === base), 'gap not painted');
for (const image of ['\x1b_Ga=T;abc\x1b\\', '\x1b]1337;File=abc\x07']) {
  assert.equal(tui.applyLineResets([image])[0], image, 'image payload changed');
}
// Exercise the real fullscreen layout/diff/output pipeline and empty viewport rows.
editor.setText('hello');
const { transcript, root: layout } = createChatViewport({
  document: new Text(Array.from({ length: 100 }, (_, i) => `Assistant response ${String(i + 1).padStart(3, '0')}`).join('\n'), 0, 0),
  pendingMessages: new Spacer(0), status: new Spacer(1), editor, footer, scrollbar: 'hidden',
});
tui.setLayoutRoot(layout);
tui.setFocus(editor);
tui.start();
tui.renderNow(true);
function verifyFrame() {
  const frame = tui.getScreenLines();
  assert.equal(frame.length, terminal.rows);
  for (const row of frame) {
    const cells = cellBackgrounds(row);
    assert.equal(cells.length, terminal.columns, 'canvas width incorrect');
    assert(cells.every(bg => bg !== null), 'terminal-default pixel remains');
    if (terminal.columns >= 12) {
      assert(cells.slice(0, 3).every(bg => bg === base), 'left gutter not canvas colored');
      assert(cells.slice(-3).every(bg => bg === base), 'right gutter not canvas colored');
      assert.equal(strip(row).slice(0, 3), '   ', 'content in left gutter');
      assert.equal(strip(row).slice(-3), '   ', 'content in right gutter');
    }
  }
  // A narrower viewport must reflow this phrase rather than clip its edges.
  // At tiny widths follow-end can legitimately scroll the first word out.
  const response = terminal.columns >= 20 ? frame.find(row => strip(row).includes('Ass')) : frame[0];
  assert(response, `response missing at ${terminal.columns}x${terminal.rows}`);
  assert(cellBackgrounds(response).every(bg => bg === base));
  const footerRow = frame.find(row => strip(row).includes('ctx 36%'));
  if (footerRow) assert(cellBackgrounds(footerRow).every(bg => bg === base));
  assert(frame.some(row => row.includes(theme.getBgAnsi('selectedBg'))), 'input fill lost');
}
verifyFrame();
transcript.scrollTo(30);
tui.renderNow(true);
function findBox(box, component) {
  if (box.component === component) return box;
  for (const child of box.children) { const result = findBox(child, component); if (result) return result; }
}
function checkInputGeometry() {
  const box = findBox(tui.currentLayout.root, editor);
  const gutter = terminal.columns >= 12 ? 3 : 0;
  assert.equal(box.rect.x, gutter, 'editor not inset');
  assert.equal(box.rect.width, terminal.columns - 2 * gutter, 'editor not given narrower width');
  return box;
}
let box = checkInputGeometry();
const inputScreenRow = box.rect.y + 1;
const inputRectBefore = { ...box.rect };
const historyRectBefore = { ...findBox(tui.currentLayout.root, transcript).rect };
const historyScrollBefore = transcript.scrollTop;
const historyBefore = tui.getScreenLines().slice(0, historyRectBefore.height);
// Dispatch global mouse coordinates through Pi's actual fullscreen hit-testing.
tui.handleTerminalInput(`\x1b[<0;${box.rect.x + 4};${box.rect.y + 2}M`);
tui.handleTerminalInput(`\x1b[<0;${box.rect.x + 4};${box.rect.y + 2}m`);
assert.equal(editor.getCursor().col, 1, 'inset editor global mouse positioning');
editor.setText('/s');
editor.handleInput('\t');
await new Promise(r => setTimeout(r, 150));
tui.renderNow(true);
box = checkInputGeometry();
assert.deepEqual(box.rect, inputRectBefore, 'popup resized/moved input');
assert.deepEqual(findBox(tui.currentLayout.root, transcript).rect, historyRectBefore, 'popup resized history');
assert.equal(transcript.scrollTop, historyScrollBefore, 'popup changed history scroll position');
let popupBounds = tui.renderedOverlayLayouts.at(-1);
assert.equal(popupBounds.row + popupBounds.height, box.rect.y, 'popup not directly above input');
assert.equal(popupBounds.col, box.rect.x, 'popup not aligned with inset input');
assert.equal(popupBounds.width, box.rect.width, 'popup width differs from input');
assert(tui.getScreenLines().slice(popupBounds.row, box.rect.y).some(row => strip(row).includes('settings')), 'commands do not cover history');
assert.deepEqual(tui.getScreenLines().slice(0, popupBounds.row), historyBefore.slice(0, popupBounds.row), 'uncovered history moved');
assert.equal(box.rect.y + 1, inputScreenRow, 'popup shifted prompt cursor row');
assert.equal(editor.focused, true, 'non-capturing popup stole keyboard focus');
// Input clicks remain at their original coordinates while the overlay is open.
tui.handleTerminalInput(`\x1b[<0;${box.rect.x + 4};${box.rect.y + 2}M`);
tui.handleTerminalInput(`\x1b[<0;${box.rect.x + 4};${box.rect.y + 2}m`);
assert.equal(editor.getCursor().col, 1, 'prompt mouse position wrong with upper list');
// Complete at the end of /s; clicking inside the token intentionally changes
// the base provider's prefix and preserves the suffix after the cursor.
editor.handleInput('\x05');
await new Promise(r => setTimeout(r, 150));
tui.renderNow(true);
box = checkInputGeometry();
popupBounds = tui.renderedOverlayLayouts.at(-1);
tui.handleTerminalInput(`\x1b[<0;${popupBounds.col + 5};${popupBounds.row + 1}M`);
tui.handleTerminalInput(`\x1b[<0;${popupBounds.col + 5};${popupBounds.row + 1}m`);
assert.equal(editor.getText(), '/s', 'global popup padding click selected a command');
tui.handleTerminalInput(`\x1b[<0;${popupBounds.col + 5};${popupBounds.row + 2}M`);
tui.handleTerminalInput(`\x1b[<0;${popupBounds.col + 5};${popupBounds.row + 2}m`);
assert.equal(editor.getText(), '/settings ', 'inset autocomplete global mouse mapping');
assert.equal(editor.focused, true, 'mouse selection moved focus to popup');
editor.setText('hello');
tui.renderNow(true);
assert.equal(tui.hasOverlayEntries, false, 'completion left overlay mounted');
assert.equal(transcript.scrollTop, historyScrollBefore, 'completion moved history');
assert.deepEqual(tui.getScreenLines().slice(0, historyRectBefore.height), historyBefore, 'covered history did not reappear unchanged');
const overlay = tui.showOverlay(new Text(theme.bg('selectedBg', 'Overlay'), 0, 0), { width: 20, anchor: 'center' });
tui.renderNow();
verifyFrame();
assert(tui.getScreenLines().some(row => strip(row).includes('Overlay')), 'overlay lost');
overlay.hide();
for (const [columns, rows] of [[80, 20], [20, 10], [12, 12], [11, 12], [8, 12]]) {
  terminal.columns = columns; terminal.rows = rows;
  tui.renderNow(true);
  verifyFrame();
  checkInputGeometry();
}
assert.equal(tui.currentLayout.primaryScrollView, transcript, 'scroll viewport identity changed');
// A long list must remain usable when only a few rows fit above the input.
const manyCommands = new CombinedAutocompleteProvider(Array.from({ length: 20 }, (_, i) => ({ name: `cmd${String(i + 1).padStart(2, '0')}`, description: 'Command' })), fixtureDirectory);
editor.setAutocompleteProvider(manyCommands);
for (const [columns, rows] of [[80, 12], [20, 10], [12, 8], [11, 8], [8, 6]]) {
  terminal.columns = columns; terminal.rows = rows;
  editor.setText('/c'); editor.handleInput('\x1b'); tui.renderNow(true);
  const inputBefore = { ...checkInputGeometry().rect };
  const scrollBefore = transcript.scrollTop;
  const viewportBefore = { ...findBox(tui.currentLayout.root, transcript).rect };
  editor.handleInput('\t'); await new Promise(r => setTimeout(r, 150)); tui.renderNow(true);
  assert.deepEqual(checkInputGeometry().rect, inputBefore, 'short-screen popup changed input');
  assert.deepEqual(findBox(tui.currentLayout.root, transcript).rect, viewportBefore, 'short-screen popup resized history');
  assert.equal(transcript.scrollTop, scrollBefore, 'short-screen popup moved history');
  for (let i = 0; i < 9; i++) tui.handleTerminalInput('\x1b[B');
  tui.renderNow(true);
  const popup = tui.renderedOverlayLayouts.at(-1);
  if (popup) {
    assert(popup.row + popup.height <= inputBefore.y, 'short-screen popup covered input');
    const rows = tui.getScreenLines().slice(popup.row, popup.row + popup.height);
    const selected = rows.findIndex(line => strip(line).includes('→ '));
    assert(selected >= 0, 'selected command clipped out of popup');
    const x = popup.col + Math.min(4, popup.width - 1) + 1;
    const y = popup.row + selected + 1;
    // Scroll inside the list, not the conversation; then click the selected row.
    tui.handleTerminalInput(`\x1b[<65;${x};${y}M`);
    tui.renderNow(true);
    assert.equal(transcript.scrollTop, scrollBefore, 'popup wheel scrolled conversation');
    const updated = tui.renderedOverlayLayouts.at(-1);
    const newSelected = tui.getScreenLines().slice(updated.row, updated.row + updated.height).findIndex(line => strip(line).includes('→ '));
    const clickY = updated.row + newSelected + 1;
    tui.handleTerminalInput(`\x1b[<0;${x};${clickY}M`);
    tui.handleTerminalInput(`\x1b[<0;${x};${clickY}m`);
    assert.equal(editor.getText(), '/cmd11 ', 'clipped/scrolling popup mouse mapping');
    assert.equal(editor.focused, true, 'short-screen popup stole focus');
  } else {
    assert.equal(tui.hasOverlay(), false, 'popup visible without room above input');
    tui.handleTerminalInput('\t');
    assert.equal(editor.getText(), '/cmd10 ', 'keyboard completion broken without popup space');
  }
  editor.handleInput('\x1b'); editor.setText('hello'); tui.renderNow(true);
  assert.equal(tui.hasOverlayEntries, false, 'small-screen popup leaked');
}
// Resize an already-open popup: geometry must use the current frame, not
// last frame's rectangles or guessed footer/widget heights.
terminal.columns = 120; terminal.rows = 30;
editor.setText('/c'); editor.handleInput('\t'); await new Promise(r => setTimeout(r, 150)); tui.renderNow(true);
for (const [columns, rows] of [[80, 12], [20, 10], [11, 8], [120, 30]]) {
  terminal.columns = columns; terminal.rows = rows; tui.renderNow(true);
  const input = checkInputGeometry();
  const bounds = tui.renderedOverlayLayouts.at(-1);
  assert.equal(bounds.row + bounds.height, input.rect.y, 'resize left stale popup row');
  assert.equal(bounds.col, input.rect.x, 'resize left stale popup column');
  assert.equal(bounds.width, input.rect.width, 'resize left stale popup width');
  for (const row of tui.getScreenLines()) {
    assert.equal(cellBackgrounds(row).length, columns, 'popup resize overflow');
    assert(cellBackgrounds(row).every(bg => bg !== null), 'popup resize exposed terminal background');
  }
}
// Filtering must update the same overlay, and Escape must reveal the history.
tui.handleTerminalInput('m'); tui.handleTerminalInput('d'); tui.handleTerminalInput('1');
await new Promise(r => setTimeout(r, 150)); tui.renderNow(true);
assert.equal(editor.getText(), '/cmd1');
assert(tui.getScreenLines().some(row => strip(row).includes('cmd10')), 'typing did not refresh popup');
tui.handleTerminalInput('\x1b'); tui.renderNow(true);
assert.equal(tui.hasOverlayEntries, false, 'typed popup survived Escape');
// Files use the same base completion list and should float as well.
editor.setAutocompleteProvider({
  shouldTriggerFileCompletion: () => true,
  getSuggestions: () => ({ prefix: 'fi', items: [{ value: 'file-a.ts', label: 'file-a.ts' }, { value: 'file-b.ts', label: 'file-b.ts' }] }),
  applyCompletion: (lines, line, col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
});
editor.setText('fi'); editor.handleInput('\t'); await new Promise(r => setTimeout(r, 150)); tui.renderNow(true);
assert.equal(checkInputGeometry().rect.height, 5, 'file autocomplete increased input height');
assert(tui.getScreenLines().some(row => strip(row).includes('file-a.ts')), 'file popup missing');
tui.handleTerminalInput('\x1b[B'); tui.handleTerminalInput('\t'); tui.renderNow(true);
assert.equal(editor.getText(), 'file-b.ts', 'file popup navigation broken');
assert.equal(tui.hasOverlayEntries, false, 'file popup not removed after completion');
editor.setAutocompleteProvider(manyCommands);
// Modal UI owns focus while open; autocomplete returns after it is dismissed.
terminal.columns = 80; terminal.rows = 20;
editor.setText('/c'); editor.handleInput('\t'); await new Promise(r => setTimeout(r, 150)); tui.renderNow(true);
const modal = tui.showOverlay(new Text('Modal', 0, 0), { width: 20 });
tui.renderNow(true);
assert.equal(editor.focused, false, 'modal did not own focus');
assert.equal(tui.renderedOverlayLayouts.length, 1, 'autocomplete covered modal UI');
modal.hide(); tui.renderNow(true);
assert.equal(editor.focused, true, 'modal did not restore editor focus');
assert(tui.getScreenLines().some(row => strip(row).includes('cmd')), 'autocomplete did not return after modal');
tui.stop();
await shutdown();
assert.equal(tui.applyLineResets, originalNormalizer, 'normalizer not restored');
assert.equal(Object.hasOwn(tui, 'applyLineResets'), false, 'prototype shadow not removed');
assert.equal(tui.setLayoutRoot, originalSetRoot, 'layout setter not restored');
assert.equal(tui.compositeOverlays, originalComposite, 'overlay compositor not restored');
assert.equal(Object.hasOwn(tui, 'compositeOverlays'), false, 'compositor shadow leaked');
assert.equal(tui.hasOverlayEntries, false, 'shutdown left autocomplete mounted');
assert.equal(tui.layoutRoot, layout, 'original tree not restored');
editor.render(80);
assert.equal(tui.applyLineResets, originalNormalizer, 'late editor render reinstalled adapter after shutdown');
assert.equal(tui.layoutRoot, layout, 'late editor render reinstalled gutters after shutdown');
await shutdown();
await start({ ...ctx, thinkingLevel: undefined });
editor.setText('hello');
assert(strip(editor.render(80)[3]).trimEnd().endsWith('· off'), 'missing thinking level did not default safely');
await shutdown();
await start({ ...ctx, mode: 'print' });
assert.equal(tui.applyLineResets, originalNormalizer, 'non-TUI installed canvas');
await start();
await start();
// Mode changes replace the renderer behind the same factory-facing Proxy.
const replacement = new TuiAltScreen(terminal, false, undefined, { mouse: true });
const replacementOriginal = replacement.applyLineResets;
activeTui = replacement;
editorFactory(tuiReference, getEditorTheme(), new KeybindingsManager());
assert.equal(tui.applyLineResets, originalNormalizer, 'old renderer not restored on mode change');
assert.notEqual(replacement.applyLineResets, replacementOriginal, 'new renderer not painted');
assert.equal(Object.getOwnPropertySymbols(replacement).filter(s => s.description === 'slate-renderer').length, 0, 'probe symbol leaked');
await shutdown();
assert.equal(replacement.applyLineResets, replacementOriginal, 'replacement not restored');
assert.equal(Object.hasOwn(replacement, 'setLayoutRoot'), false, 'replacement layout setter not restored');
activeTui = tui;
assert.equal(tui.applyLineResets, originalNormalizer, 'repeated session setup leaked adapter');
// Regular-mode composition also overlays an existing long transcript without
// adding lines. Main-screen mouse routing remains owned by the terminal.
const regular = new TuiMainScreen(terminal, false);
const regularNormalizer = regular.applyLineResets;
const regularComposite = regular.compositeOverlays;
activeTui = regular;
await start();
editor.focused = true;
regular.addChild(new Text(Array.from({ length: 60 }, (_, i) => `History ${i}`).join('\n'), 0, 0));
regular.addChild(editor);
regular.addChild(footer);
editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'settings' }, { name: 'session' }], fixtureDirectory));
editor.setText('/s');
const regularLinesBefore = regular.render(terminal.columns);
editor.handleInput('\t'); await new Promise(r => setTimeout(r, 150));
const regularLines = regular.render(terminal.columns);
assert.equal(regularLines.length, regularLinesBefore.length, 'regular popup added transcript lines');
const regularFrame = regular.compositeOverlays(regularLines, terminal.columns, terminal.rows);
assert.equal(regularFrame.length, regularLines.length, 'regular overlay grew scrollback');
assert(regularFrame.some(line => strip(line).includes('settings')), 'regular popup missing');
await shutdown();
assert.equal(regular.applyLineResets, regularNormalizer);
assert.equal(regular.compositeOverlays, regularComposite);
assert.equal(regular.hasOverlayEntries, false);
activeTui = tui;
assert.equal(process.listenerCount('exit'), exitListenersBefore, 'exit listener leak');
assert(writes.every(write => !write.includes('\x1b]11;') && !write.includes('\x1b]111')), 'OSC background controls remain');
console.log(`PASS: ${cases} editor render cases, cursor/autocomplete/footer, real fullscreen canvas through Pi's forwarding Proxy including floating padded autocomplete in both modes, unchanged history viewport/scroll, short-screen selection/wheel/cropping, modal focus and cleanup, focus-safe mouse clicks, keyboard/Escape, bottom-anchored prompt, three-column gutters, real mouse/autocomplete hit-testing, narrow reflow/resizes, SGR colors, images, mode switches and tree/lifecycle cleanup`);
