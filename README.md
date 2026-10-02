# Pi Customizations

One Pi package for my custom extensions and themes. Install it once, then use
`pi config` to choose which extensions and themes to enable.

## Install

Review the source before installing: Pi extensions execute code with your user permissions.

```bash
pi install git:github.com/nguyenminhquan/pi-customizations
```

Restart Pi after installing Slate UI, then select a `slate-*` theme under
**`/settings → Theme`**. Pi saves your selection. This package does not overwrite
your settings or automatically change your chosen theme.

For a project-only installation, append `--local`. Project resources load after
project trust is granted.

## Included resources

### Slate UI

- Solid slate panels with theme-colored left rails instead of outlined boxes.
- Explicit dark-slate canvas (`#1F1F28`), including blank space and the footer.
- Three-column outer gutters in fullscreen mode; disabled below 12 columns.
- Slash-command and file-completion menus float above the input over history,
  without resizing the conversation or changing its scroll position.
- Padding, mouse selection, keyboard navigation, resizing and short-screen handling.
- Compact model/thinking metadata, footer and working indicator.

Six accent themes are included: **cyan, blue, violet, rose, amber and green**.
See [Slate UI colors and compatibility](docs/slate-ui.md) for customization details.

Fullscreen mode is recommended. Optional personal display preferences:

```json
{
  "tuiMode": "fullscreen",
  "fullscreenScrollbar": "hidden",
  "quietStartup": true,
  "theme": "slate-cyan"
}
```

Merge preferences into your own settings; do not replace the whole settings file.
Slate UI replaces the editor, footer and working indicator, so avoid enabling
another extension that replaces those same components at the same time.

**Compatibility:** tested against `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-tui` **1.0.0**. Requires Node.js 22.19+.
The canvas and autocomplete adapters use guarded internal renderer hooks, not
only public APIs. Pi updates can require changes; run the regression tests before
claiming compatibility with another version. Unsupported canvas hooks produce a
warning; unsupported overlay hooks fall back to inline autocomplete. Gutters need
fullscreen mode. No terminal configuration is changed.

## Local development

```bash
git clone https://github.com/nguyenminhquan/pi-customizations.git
cd pi-customizations
npm ci --ignore-scripts
npm run check
pi install "$PWD"
```

Local package installs load directly from this directory without copying it.
Edit files here, then run `/reload` (or restart Pi for renderer changes).

Do not keep the same extensions or theme names simultaneously installed as loose
files under `~/.pi/agent/extensions` or `~/.pi/agent/themes`. Remove old loose copies
after verifying the package. Likewise, use either a local install or a Git install
of this package, not both. Use `pi remove <old-source>` when switching sources.

The Pi libraries are runtime **peer dependencies**, supplied by the host. Pinned
copies in `devDependencies` exist only for type checking and renderer tests. Tests
use an isolated temporary agent directory; they do not read personal settings,
credentials or require an API key.

The pinned Pi 1.0.0 development package currently ships a shrinkwrap containing
`brace-expansion` 5.0.9. `npm audit` reports a high-severity denial-of-service
advisory for it; ordinary audit updates do not replace that shrinkwrapped copy.
These Pi development dependencies are not shipped in this package's tarball.
Re-test and update the pinned Pi versions when upstream releases a corrected
package; do not assume this package upgrades the host's dependencies.

## Add another extension or theme

A standalone TypeScript extension belongs in `extensions/my-extension.ts` and
exports a default function receiving `ExtensionAPI`. Multi-file extensions can
use `extensions/my-extension/index.ts`; keep helpers inside that directory.
Both forms are already included in the package manifest.

Put JSON themes in `themes/`. Use unique theme names matching their filenames.
Add documentation and tests for each new resource, then run:

```bash
npm run check
npm pack --dry-run
```

Consumers can use `pi config` to disable individual resources. Keep unrelated
features in separate extension files rather than making Slate UI a catch-all.
Only `extensions/`, `themes/`, `docs/`, the README and license are shipped in the
npm tarball. Never add credentials, sessions, personal settings or `.env` files.

## Releases

Commit and push changes yourself; repository setup does not publish anything.
For a reproducible Git release, update `package.json` and the lockfile together,
commit the release, and push a tag such as `v0.1.0`. Consumers can then pin it:

```bash
pi install git:github.com/nguyenminhquan/pi-customizations@v0.1.0
```

Pinned tags/commits do not automatically move to newer releases. Unpinned installs
can be updated using `pi update --extensions`.

Npm publication is optional. This repository is configured as
`@nguyenminhquan/pi-customizations`; check that you own that npm scope (or change
the name) before publishing. Inspect `npm pack --dry-run`, then publish with
`npm publish --access public` when ready.

## License

[MIT](LICENSE).
