# Changelog

## Unreleased

## 1.3.0 - 2026-09-03

- Add a versioned `.rdwb` export format containing all workspaces, PDFs, reading state, annotations, notes, cards, chats, usage records and cached full-text indexes.
- Validate backup structure, references, lengths and SHA-256 digests before allowing atomic replacement or collision-safe merge import.
- Exclude model API keys by default and require an explicit opt-in for sensitive manual exports.
- Add configurable browser-local automatic snapshots with download, restore, retention and a clear same-origin storage warning.
- Add current-workspace search across titles, PDF text layers, notes, highlights, AI chats and paper cards.
- Build cancelable PDF text indexes on demand, persist them in IndexedDB, and jump search results back to their source page.
- Upgrade the IndexedDB schema from version 1 to version 2 without discarding existing user data.

## 1.2.0 - 2026-09-03

- Refine the document library, upload surface and reader toolbar with valid interactive structure, accessible names and visible keyboard focus.
- Keep collapsed and off-screen panels out of keyboard and screen-reader navigation, and add modal focus trapping and focus restoration.
- Label AI opinion paragraphs without discarding their inline Markdown formatting.
- Prevent compact form controls from triggering iOS Safari viewport zoom.
- Preserve the portable launchers, configurable local server and accurate AI privacy disclosure from the public edition.

## 1.1.0 - 2026-09-03

- Prepare the public user edition with an online demo, portable release package, cross-platform launchers, product documentation and clearer AI privacy disclosure.
- Publish the project under the MIT License with public contribution and issue guidance.

## 1.0.0 - 2026-09-03

- Package the local-first research reading workbench for its first repository release.
- Add bounded, cancelable PDF rendering and release off-screen canvas memory.
- Upgrade the local PDF.js runtime and disable unsafe PDF evaluation paths.
- Add continuous reading, annotation, hand panning, region capture and stable position restore.
- Add isolated Markdown notes with safe edit/preview rendering.
- Add streamed AI responses, live reasoning feedback, stop controls and paper-bound request state.
- Add transactional persistence, navigation flushing and close-time recovery.
- Add responsive side panels and toolbar layouts from 320px to desktop widths.
