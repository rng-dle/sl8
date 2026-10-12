# Control panel plan (later)

Today: Settings is one long page of radio rows (theme, background, toolbar, hints, zoom, minimap, opening, tear sound, logo, AI key). It works, but it will not scale past ~30 options.

## Goal
One place to configure everything, fast to scan, searchable, and reachable from any canvas without leaving it.

## Shape
- Opens as a side panel over the canvas (⋯ > Settings, or `,` key); /settings stays as the full-page version of the same thing.
- Left rail of groups: Look, Canvas, Tools, Motion and sound, Account, AI, Data. Right: the options for that group.
- Search box at the top filters every option by name and help text.
- Every change applies live on the canvas behind the panel (no Save button).
- Each option shows where it is stored: "this device" or "your account", with a switch to sync it to the account.
- Per-group "Reset to default" and one global reset; export and import settings as a small JSON file.
- Presets: "Calm", "Drawing", "Writing" bundles that set several options at once; users save their own.
- Option registry: one list (key, label, group, type, default, help, scope), rendered by one component, so adding a setting is one line. Settings.html and the panel both read it.

## Steps
1. Registry file + renderer, port the existing options to it (no new features).
2. Account sync for settings (a `settings` JSON column on the user row).
3. Side-panel mode with live preview, then search.
4. Presets and export/import.
5. Keyboard shortcut editor (rebind keys) as its own group.
