# ThinkSL8 product spec (from the product questionnaire, 2026-10-12)

Decisions Josh made, grouped by area. "Flag" marks a decision that conflicts with another or has a cost to settle before building.

## 1. Positioning
- One-liner: an infinite canvas for thinking. Core promise: think without organizing.
- Beat/replace: Notion/Obsidian, Miro/FigJam/Milanote, Heptabase/Muse/Kinopio, Apple Notes/Keep.
- Audience: everyone equally (no single niche).
- Feel: calm by default, but look, feel and tone are user-configurable (a core principle).

## 2. Canvas objects
- Add: checklists/tasks, link cards, files and PDFs, code/tables/embeds from an allowlist of services such as Spotify and YouTube (on top of text, drawing, arrows, portals, images, video).
- Text: Markdown source that renders however the user prefers, if it makes work faster.
- Grouping: groups, frames/regions, tags, and plain proximity all supported.
- Arrows: labelled, with relationship presets (inspires, depends on, supports...).

## 3. Capture
- Routes: phone share menu, browser clipper, global quick-entry shortcut, email-in and Slack-in.
- Landing place: the user picks a default.
- Input that must feel excellent: S Pen/stylus handwriting, voice notes, keyboard-only speed, touch gestures.
- Target: instant capture, even offline.
- Voice notes: record in the browser, play back on the canvas, transcribe through the user's AI or the browser; build right after the quick wins.

## 4. Organizing and finding
- Archive: timeline view with type/date/canvas filters.
- Search: ask-your-notes chat (keyword search stays as the base).
- A picked search result is shown on the minimap.
- Auto-organize is a user setting: index only / suggest tags and links / offer tidy layouts / fully automatic.

## 5. Navigation and views
- Minimap shows objects and viewport, region/container icons, search results and pins, links to other canvases.
- Full-screen overview: both a labelled map and cluster summaries, switchable.
- Canvases: portals plus a canvas list.
- Alternative views: timeline/list and a graph of connections.

## 6. AI
- Source: both the user's own account/key and built-in credits. Flag: built-in credits are your inference cost, so Pro must price for it.
- Jobs: ask your notes, summarize/clean up, suggest links and related notes, transcribe handwriting and voice.
- Initiative: asked at setup (passive / invited / proactive).
- Edits: full agent mode, within a scope the user grants. Flag: the brief requires diff preview and explicit, enforceable permissions; nothing writes without them.

## 7. Privacy and trust
- Standard cloud security now (encrypted in transit and at rest). No end-to-end encryption.
- Data sent to AI: shown to the user, notes can be marked never-send, and private canvases can use local AI. Flag: local AI needs a local-model path that does not exist yet.
- Analytics: opt-in only. Flag: opt-in analytics still needs a consent notice.
- Leaving: JSON export, Markdown/folder export, scheduled backups, permanent delete.

## 8. Storage, sync and offline
- Offline: all of it (capture, editing, sync later). Flag: this conflicts with "cloud only" in the earlier build plan; offline needs a local store and sync queue.
- Conflicts: ask the user which version to keep.
- History: restore points (a Pro feature, with backups).
- Storage modes: cloud today, local-first on device later.

## 9. Sharing
- Shareable: whole canvas, one portal, a dotted region, selected objects.
- Levels: view, edit, comment only, restricted edit.
- Access: anyone with the link. Public read-only pages are allowed.

## 10. Platforms
- Order: web/PWA, then Android, then iOS.
- Native approach: a cross-platform framework. Flag: the canvas today is a web page, so this means rebuilding it. Wrapping the web app is far cheaper; decide before starting.
- Devices that must feel best: Samsung tablet with S Pen, phone, laptop, iPad with Pencil.
- Accessibility: keyboard and screen reader, reduced motion and contrast, dyslexia-friendly type.

## 11. Plans and payments
- Free tier + Pro at $5/month or $48/year. No lifetime deal. The free tier is the trial.
- Free limits: file storage and AI usage (not the number of canvases).
- Pro adds: version history and backups, built-in AI credits, early access.
- Payments: Stripe through a Canadian entity. Flag: this needs a Canadian company and bank account; Josh lives in Pakistan, so check this first. A merchant of record is the fallback.

## 12. Marketplace
- Daily theme and template continue, with community voting.
- Publishing is reviewed before listing; abuse is handled by a report button plus auto-scan.
- More kinds later: sticker/icon packs, pen and brush styles, starter canvases, AI prompts/workflows.

## 13. Brand and personalization
- Customizable: themes/colors/fonts, toolbar layout, default behaviors, keyboard shortcuts.
- Circle toolbar vs classic: chosen at setup.
- Name: ThinkSL8 / Think Slate. Tone: configurable.

## 14. Launch and operations
- First users: ADHD/productivity communities, Product Hunt/HN, own network and Nastaliq clients, shared canvases.
- Launch: open now, announce later. Support: in-app help and email.
- Time: 10-20 hours a week.
- Success in 6 months: paying subscribers.
- Roadmap: opportunistic. Legal before charging: refund policy, data-processing details, consent notice, and a review of the existing privacy policy and terms.

## Build order
1. Quick wins: hint off switch, arrow relationship presets, 10th colour with HEX/RGB/HSL, phone share, minimap, checklists.
2. Guidance system (hint bubbles that switch off after the first canvas, saved to the account).
3. Free-tier limits and a usage meter (storage and AI), billing off until payments are settled.
4. Everything else from the sections above, in the order that serves paying users.
