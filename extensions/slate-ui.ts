/** Slate UI: flat panels, theme-colored left rail, quiet footer. */
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type Component,
	type EditorTheme,
	HStack,
	isViewportTUI,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { sep } from "node:path";

// Replaced before returning rendered output; identifies the base editor's boundary
// without mistaking a prompt containing horizontal rules for a border.
const PANEL_END = "\x1b_pi-slate-panel-end\x1b\\";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SCREEN_BACKGROUND_ANSI = "\x1b[48;2;31;31;40m"; // #1F1F28
const SIDE_GUTTER = 3;

interface CompletionPopup {
	owner: Component;
	renderer: TUI;
	handle?: OverlayHandle;
	options: OverlayOptions;
	lines: string[];
	lineOffset: number;
	displayHeight: number;
	selectedRow: number;
	cursorRow: number;
	cursorCol: number;
	width: number;
	visible: boolean;
}

// Preserve explicit child backgrounds, but map SGR default/reset backgrounds to
// the application canvas. Skip extended color operands (RGB values can be 0/49).
function restoresDefaultBackground(parameters: string): boolean {
	const codes = parameters.split(";");
	let reset = false;
	for (let i = 0; i < codes.length; i++) {
		const code = Number(codes[i].split(":")[0]);
		if (code === 0 || code === 49) reset = true;
		else if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) reset = false;
		if ((code === 38 || code === 48 || code === 58) && !codes[i].includes(":")) {
			const mode = Number(codes[i + 1]);
			if (mode === 2) i += 4;
			else if (mode === 5) i += 2;
		}
	}
	return reset;
}

function paintCanvasLine(line: string, width: number): string {
	// Graphics protocol payloads must pass through byte-for-byte untouched.
	if (line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
	const painted = line.replace(/\x1b\[([\d;:]*)m/g, (sequence, parameters: string) =>
		restoresDefaultBackground(parameters) ? sequence + SCREEN_BACKGROUND_ANSI : sequence,
	);
	const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
	return SCREEN_BACKGROUND_ANSI + painted + SCREEN_BACKGROUND_ANSI + padding;
}

function fitLine(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function alignColumns(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightText = truncateToWidth(right, width, "");
	const rightWidth = visibleWidth(rightText);
	if (rightWidth >= width) return rightText;
	const leftText = truncateToWidth(left, Math.max(0, width - rightWidth - 1), "");
	return leftText + " ".repeat(Math.max(1, width - visibleWidth(leftText) - rightWidth)) + rightText;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}${sep}`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function contextLabel(ctx: ExtensionContext): string {
	const percent = ctx.getContextUsage()?.percent;
	return percent == null ? "ctx ?" : `ctx ${Math.round(percent)}%`;
}

export default function (pi: ExtensionAPI) {
	let sessionActive = false;
	let canvasTui: TUI | undefined;
	let restoreCanvas: (() => void) | undefined;
	let popupSupported = false;
	let completionPopup: CompletionPopup | undefined;

	const closePopup = () => {
		completionPopup?.handle?.hide();
		completionPopup = undefined;
	};

	const releaseCanvas = () => {
		restoreCanvas?.();
		restoreCanvas = undefined;
		canvasTui = undefined;
		popupSupported = false;
	};

	const applyCanvas = (tuiReference: TUI, ctx: ExtensionContext) => {
		if (!sessionActive) return;
		// Extension factories receive a forwarding Proxy whose method identities
		// change on every read. A temporary symbol method returns its bound receiver
		// so we can attach/restore on the real renderer, including after mode switches.
		const probe = Symbol("slate-renderer");
		Reflect.set(tuiReference, probe, function (this: TUI) { return this; });
		const tui = Reflect.get(tuiReference, probe).call(tuiReference) as TUI;
		Reflect.deleteProperty(tui, probe);
		if (canvasTui === tui) return;
		closePopup();
		releaseCanvas();
		// Pi has no public canvas/background hook. Adapt its final line-normalization
		// step, after layout/overlays but before diffing/output. These internal hooks
		// are guarded and restored on shutdown; revisit if Pi changes them.
		type CanvasRenderer = TUI & {
			applyLineResets(lines: string[]): string[];
			compositeOverlays(lines: string[], width: number, height: number): string[];
		};
		const renderer = tui as CanvasRenderer;
		const original = renderer.applyLineResets;
		if (typeof original !== "function") {
			ctx.ui.notify("Slate UI canvas: this Pi version lacks the renderer adapter hook.", "warning");
			return;
		}
		const hadOwnMethod = Object.prototype.hasOwnProperty.call(renderer, "applyLineResets");
		const painted = function (this: CanvasRenderer, lines: string[]): string[] {
			const width = Math.max(1, this.terminal.columns);
			return original.call(this, lines.map((line) => paintCanvasLine(line, width)));
		};
		renderer.applyLineResets = painted;

		// Position a real, non-capturing overlay from the current frame's input
		// cursor, not last frame's layout or guessed footer/widget heights. This
		// runs after layout, so the popup never consumes transcript viewport rows.
		const originalComposite = renderer.compositeOverlays;
		const hadOwnComposite = Object.prototype.hasOwnProperty.call(renderer, "compositeOverlays");
		const composite = function (this: CanvasRenderer, lines: string[], width: number, height: number) {
			const popup = completionPopup;
			if (popup?.renderer === this) {
				const viewportStart = Math.max(0, lines.length - height);
				const cursorRow = lines.findIndex((line) => line.includes(CURSOR_MARKER));
				const inputTop = cursorRow - viewportStart - popup.cursorRow;
				popup.visible = sessionActive && popup.cursorRow >= 0 && cursorRow >= viewportStart && inputTop > 0;
				if (popup.visible) {
					popup.displayHeight = Math.min(popup.lines.length, inputTop);
					// At short heights keep the selected command visible, even when
					// the top padding or list counter cannot fit above the prompt.
					popup.lineOffset = Math.max(0, Math.min(
						popup.lines.length - popup.displayHeight,
						popup.selectedRow - popup.displayHeight + 1,
					));
					const markerColumn = visibleWidth(lines[cursorRow].split(CURSOR_MARKER)[0]);
					popup.options.col = Math.max(0, markerColumn - popup.cursorCol);
					popup.options.width = Math.min(popup.width, width);
					popup.options.row = inputTop - popup.displayHeight;
					popup.options.maxHeight = popup.displayHeight;
				}
			}
			return originalComposite.call(this, lines, width, height);
		};
		popupSupported = typeof originalComposite === "function";
		if (popupSupported) renderer.compositeOverlays = composite;

		let restoreLayout = () => {};
		if (isViewportTUI(tui)) {
			// Retain Pi's original scroll/editor/footer tree inside a real layout
			// inset. The engine now wraps at width - 6 and shifts cursor, mouse,
			// selections and links together; no final-frame clipping is needed.
			type LayoutRenderer = typeof tui & { layoutRoot?: Component };
			const viewport = tui as LayoutRenderer;
			const originalSetRoot = viewport.setLayoutRoot;
			const hadOwnSetter = Object.prototype.hasOwnProperty.call(viewport, "setLayoutRoot");
			let contentRoot = viewport.layoutRoot;
			let insetRoot: Component | undefined;
			const gutter: Component = {
				invalidate() {},
				render: (width) => [" ".repeat(Math.max(0, width))],
			};
			const inset = (component: Component) => new HStack([
				{ component: gutter, basis: SIDE_GUTTER, shrink: 0, visible: (size) => size.width >= 12 },
				{ component, basis: 0, grow: 1, minSize: 1 },
				{ component: gutter, basis: SIDE_GUTTER, shrink: 0, visible: (size) => size.width >= 12 },
			]);
			const setInsetRoot = function (this: LayoutRenderer, component: Component | undefined) {
				if (component !== insetRoot) {
					contentRoot = component;
					insetRoot = component ? inset(component) : undefined;
				}
				originalSetRoot.call(this, insetRoot);
			};
			viewport.setLayoutRoot = setInsetRoot;
			setInsetRoot.call(viewport, contentRoot);
			restoreLayout = () => {
				if (viewport.layoutRoot === insetRoot) originalSetRoot.call(viewport, contentRoot);
				if (viewport.setLayoutRoot !== setInsetRoot) return;
				if (hadOwnSetter) viewport.setLayoutRoot = originalSetRoot;
				else delete (viewport as Partial<LayoutRenderer>).setLayoutRoot;
			};
		}

		canvasTui = tui;
		restoreCanvas = () => {
			restoreLayout();
			if (renderer.compositeOverlays === composite) {
				if (hadOwnComposite) renderer.compositeOverlays = originalComposite;
				else delete (renderer as Partial<CanvasRenderer>).compositeOverlays;
			}
			if (renderer.applyLineResets === painted) {
				if (hadOwnMethod) renderer.applyLineResets = original;
				else delete (renderer as Partial<CanvasRenderer>).applyLineResets;
			}
			tui.requestRender(true);
		};
		tui.requestRender(true);
	};

	pi.on("session_shutdown", () => {
		sessionActive = false;
		closePopup();
		releaseCanvas();
	});

	const applySpinner = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({
			frames: SPINNER_FRAMES.map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 80,
		});
	};

	pi.on("agent_start", (_event, ctx) => applySpinner(ctx));
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionActive = true;
		applySpinner(ctx);

		ctx.ui.setFooter((tui, _theme, footerData) => ({
			dispose: footerData.onBranchChange(() => tui.requestRender()),
			invalidate() {},
			render(width: number): string[] {
				const theme = ctx.ui.theme;
				const branch = footerData.getGitBranch();
				const location = `${formatCwd(ctx.cwd)}${branch ? ` · ${branch}` : ""}`;
				let cost = 0;
				for (const entry of ctx.sessionManager.getBranch()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						cost += entry.message.usage.cost.total;
					}
				}
				const lines = [alignColumns(
					theme.fg("muted", location),
					theme.fg("muted", `${contextLabel(ctx)} · $${cost.toFixed(2)}`),
					width,
				)];
				// Keep other extensions' status information (including plan/AFT notices).
				const statuses = [...footerData.getExtensionStatuses().values()].filter(Boolean);
				if (statuses.length) lines.push(truncateToWidth(statuses.join("  "), width, ""));
				return lines;
			},
		}));

		class FlatPanelEditor extends CustomEditor {
			private autocompleteRowCount = 0;
			private autocompleteTopPadding = 0;
			private inlineAutocomplete = false;
			private basePanelEndRow = Infinity;
			private hiddenBelow = 0;

			constructor(private readonly tuiReference: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tuiReference, theme, keybindings, { paddingX: 1 });
			}

			protected renderTopBorder(width: number, hiddenLineCount: number): string {
				const label = hiddenLineCount ? ` ↑ ${hiddenLineCount} more` : "";
				return fitLine(ctx.ui.theme.fg("muted", label), width);
			}

			protected renderBottomBorder(_width: number, hiddenLineCount: number): string {
				this.hiddenBelow = hiddenLineCount;
				return PANEL_END;
			}

			render(width: number): string[] {
				applyCanvas(this.tuiReference, ctx);
				if (width <= 0) return [];
				const innerWidth = Math.max(1, width - 1);
				// The base word wrapper needs room for a wide grapheme; clip only
				// after layout when the entire terminal is narrower than that.
				const lines = super.render(Math.max(4, innerWidth));
				const boundary = lines.indexOf(PANEL_END);
				this.basePanelEndRow = boundary;
				const autocomplete = lines.slice(boundary + 1);
				this.autocompleteRowCount = autocomplete.length;
				this.autocompleteTopPadding = autocomplete.length ? 1 : 0;
				const theme = ctx.ui.theme;
				const backgroundAnsi = theme.getBgAnsi("selectedBg");
				const panelRow = (text: string) => {
					let padded = fitLine(text, innerWidth);
					// At tiny widths the base editor's end cursor can overflow. Keep its
					// zero-width IME marker in the last displayed cell when clipping.
					if (text.includes(CURSOR_MARKER) && !padded.includes(CURSOR_MARKER)) {
						const lastColumn = Math.max(0, innerWidth - 1);
						padded = sliceByColumn(padded, 0, lastColumn)
							+ CURSOR_MARKER + sliceByColumn(padded, lastColumn, innerWidth);
					}
					// The cursor and child styles reset background; restore the solid fill.
					const painted = padded
						.replaceAll("\x1b[0m", `\x1b[0m${backgroundAnsi}`)
						.replaceAll("\x1b[49m", `\x1b[49m${backgroundAnsi}`);
					const rail = width > 1 ? theme.fg("accent", "▏") : "";
					return `${rail}${backgroundAnsi}${painted}\x1b[49m`;
				};
				const model = ctx.model?.name ?? ctx.model?.id ?? "no model";
				const provider = ctx.model?.provider ?? "";
				const metadata = [
					theme.fg("accent", " Prompt"),
					theme.fg("text", model),
					theme.fg("muted", provider),
					theme.fg("warning", ctx.thinkingLevel ?? "off"),
				].filter(Boolean).join(theme.fg("muted", " · "));
				const result = lines.slice(0, boundary).map(panelRow);
				result.push(panelRow(this.hiddenBelow ? ` ↓ ${this.hiddenBelow} more` : ""));
				result.push(panelRow(metadata), panelRow(""));
				this.inlineAutocomplete = !popupSupported;
				if (this.inlineAutocomplete) {
					// Graceful fallback if a future Pi release removes the adapter hook.
					return autocomplete.length
						? [panelRow(""), ...autocomplete.map(panelRow), ...result] : result;
				}
				if (!autocomplete.length || !this.focused || !sessionActive || !canvasTui) {
					if (completionPopup?.owner === this) closePopup();
					return result;
				}
				if (completionPopup?.owner !== this) {
					closePopup();
					const popup: CompletionPopup = {
						owner: this, renderer: canvasTui,
						options: { nonCapturing: true }, lines: [],
						lineOffset: 0, displayHeight: 0, selectedRow: 0,
						cursorRow: -1, cursorCol: 0, width, visible: false,
					};
					popup.options.visible = () => popup.visible && this.focused && sessionActive;
					popup.handle = canvasTui.showOverlay({
						invalidate() {},
						render: () => popup.lines.slice(popup.lineOffset, popup.lineOffset + popup.displayHeight),
						handleInput: (data) => this.handleInput(data),
						handleMouse: (event) => this.handleCompletionMouse({ ...event, y: event.y + popup.lineOffset }),
					}, popup.options);
					completionPopup = popup;
				}
				const popup = completionPopup!;
				popup.lines = [panelRow(""), ...autocomplete.map(panelRow)];
				const selected = popup.lines.findIndex((line) =>
					stripTerminalSequences(line).replace(/^▏?\s*/, "").startsWith("→ "),
				);
				popup.selectedRow = selected < 0 ? 1 : selected;
				popup.cursorRow = result.findIndex((line) => line.includes(CURSOR_MARKER));
				popup.cursorCol = popup.cursorRow < 0 ? 0
					: visibleWidth(result[popup.cursorRow].split(CURSOR_MARKER)[0]);
				popup.width = width;
				return result;
			}

			private handleCompletionMouse(event: TuiMouseEvent) {
				if (event.y < this.autocompleteTopPadding) return { handled: true };
				const result = super.handleMouse({
					...event,
					x: Math.max(0, event.x - (event.width > 1 ? 1 : 0)),
					y: this.basePanelEndRow + 1 + event.y - this.autocompleteTopPadding,
					width: Math.max(4, event.width - 1),
					height: this.basePanelEndRow + 1 + this.autocompleteRowCount,
				});
				// Clicking suggestions must not transfer keyboard focus away from
				// the input, or hide its IME cursor. Keep native SelectList behavior.
				return result ? { ...result, focus: false, render: true } : undefined;
			}

			handleMouse(event: TuiMouseEvent) {
				const prefixRows = this.inlineAutocomplete
					? this.autocompleteTopPadding + this.autocompleteRowCount : 0;
				if (event.y < prefixRows) return this.handleCompletionMouse(event);
				const inputRow = event.y - prefixRows;
				if (inputRow >= this.basePanelEndRow) {
					return event.type === "click" ? { handled: true, focus: true } : undefined;
				}
				return super.handleMouse({
					...event,
					x: Math.max(0, event.x - (event.width > 1 ? 1 : 0)),
					y: inputRow,
					width: Math.max(4, event.width - 1),
					height: Math.max(1, event.height - 2 - prefixRows),
				});
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			closePopup();
			applyCanvas(tui, ctx);
			return new FlatPanelEditor(tui, theme, keybindings);
		});
	});
}
