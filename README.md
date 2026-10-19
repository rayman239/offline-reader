# Offline Reader

A quiet, offline-first place to read the articles and PDFs you save. Clips go into themed Markdown files in an Obsidian vault.

**App:** https://rayman239.github.io/offline-reader/

This repo holds only the app's code. Saved content lives in two private repos:

| Repo | What's in it |
|---|---|
| `offline-reader-library` (private) | Saved articles and PDFs, images, highlights, reading state, and the GitHub Action that processes new saves |
| `offline-reader-vault` (private) | Theme files: the Obsidian vault |

## Pieces

- **The app** (`index.html`, `js/`, `css/`) is plain HTML, CSS and JavaScript with no build step. It's served by GitHub Pages. It mirrors both private repos into the browser's storage (IndexedDB) so everything works offline. Changes go into an outbox and are sent to GitHub when online.
- **Saving:** the app (paste a link or choose a PDF), the [iPhone Share sheet shortcut](docs/iphone-shortcut.md), or `?add=<url>`. Each save writes a file into `queue/` in the library repo, which triggers the processing Action there.
- **Obsidian bridge** (`tools/mac-sync/`): a launchd job that syncs the vault repo with `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Offline Reader` every 5 minutes. Install or update it on a Mac with:
  ```
  curl -fsSL https://rayman239.github.io/offline-reader/tools/mac-sync/install.sh | bash
  ```
  Remove it with the same command followed by `-s -- --uninstall`. The log is at `~/Library/Logs/OfflineReader-sync.log`.

## Clip format

Each clip is appended to `<Theme>.md` and never rewritten:

```markdown
> The quoted passage.

— *Article title* · [source](<https://…>) · 19 Oct 2026

**Thought:** Optional comment.
%% clip:abc123 %%
```

The `%% clip: %%` marker is hidden in Obsidian's reading view. The sync job uses it to merge safely when a file was edited in Obsidian and clipped to at the same time.

Fonts: iA Writer Quattro and Mono, © iA Inc., SIL Open Font License (see `fonts/LICENSE.md`).
