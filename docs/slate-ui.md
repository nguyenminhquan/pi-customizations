# Slate UI colors

The `slate-ui.ts` extension controls layout and paints the dark-slate canvas.
Accent colors are native Pi themes, not a separate extension setting.

## Choose a color

Run `/reload` once to discover the new themes, then open `/settings` → **Theme**:

| Theme | Accent |
| --- | --- |
| `slate-cyan` | `#56B6C2` |
| `slate-blue` | `#61AFEF` |
| `slate-violet` | `#BB9AF7` |
| `slate-rose` | `#F88FA6` |
| `slate-amber` | `#E5C07B` |
| `slate-green` | `#98C379` |

Theme changes apply immediately and Pi saves the selection. All six keep the
same slate canvas, panel backgrounds, text colors, and success/error colors.

You can also set the native `theme` key in `~/.pi/agent/settings.json`, for example:

```json
{
  "theme": "slate-violet"
}
```

## Customize a palette

Packaged themes live in `themes/slate-<color>.json` in this repository. Their `vars` contain:

- `accentColor`: primary accent, including the input rail and prompt label.
- `brightAccent`: headings, highlighted labels, and higher thinking levels.
- `secondaryAccent`: links, syntax keywords, and lower thinking levels.

For a local package install, edit those hex values here and run `/reload`.
To keep the supplied presets, copy a theme to a new filename and change its `name`
to match, then run `/reload` and select it in `/settings`. Personal variants may
also live in `~/.pi/agent/themes/` with unique names; active user themes hot-reload.
Keep the slate background variables unchanged to match the extension's canvas.

## Layout and compatibility

Slate UI paints the canvas as `#1F1F28`, independently of the terminal's default
background. Panel fills come from the selected theme; `accent` colors the rail
and prompt label. The package does not edit terminal configuration.

Fullscreen mode adds three character columns of canvas-colored padding on each
side. Gutters disappear below 12 columns. Slash-command and file-completion menus
float above the editor, covering history rather than shrinking its viewport.

The extension replaces Pi's editor, footer and working indicator. Other extensions
that replace those same components may conflict; choose one in `pi config`.
Built-in assistant messages are not converted into filled panels.

The renderer adapters depend on the internal `applyLineResets`, `compositeOverlays`
and fullscreen layout APIs. They are restored on shutdown and renderer changes.
The current regression suite targets Pi 1.0.0, testing cursor/mouse coordinates,
canvas colors, gutters, overlays, small terminals and lifecycle cleanup. Re-test
after Pi updates. Missing canvas hooks trigger a warning; missing overlay hooks
use inline autocomplete instead. Restart Pi after renderer-extension changes.
