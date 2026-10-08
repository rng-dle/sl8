# sl8

Infinite-canvas notes with accounts. Pressure ink (S Pen, Apple Pencil, Wacom/XP-Pen tablets), highlighter, eraser, text boxes, pan and pinch zoom, undo, autosave.

Runs on one Cloudflare Worker: static pages in `public/`, API in `src/worker.js`, data in D1 (`sl8-db`, already created in your account with the schema applied).

## Deploy

Needs Node 18+.

```
cd sl8 && npm install && npx wrangler login && npx wrangler deploy
```

It goes live at `https://sl8.nastaliq.co`. Wrangler creates the DNS record and certificate itself; this needs the `nastaliq.co` zone to be in the same Cloudflare account. The first load can take a few minutes while the certificate is issued.

## Run locally

```
npx wrangler d1 execute sl8-db --local --file=schema.sql && npx wrangler dev
```

Then in another terminal: `bash smoke-test.sh` (signup, save, isolation between users, lockout, logout).

## Using it

- Pen draws, finger moves the page once a pen has been used on that device (palm rejection). Without a pen, one finger draws and two fingers move and zoom.
- S Pen side button or a tablet pen's eraser end erases while held.
- Desktop: wheel pans, Ctrl+wheel or trackpad pinch zooms, hold Space to drag. Keys: P pen, H highlighter, E eraser, T text, 0 reset zoom, Ctrl+Z / Ctrl+Shift+Z.
- Text tool: tap empty space to add a box, tap a box to edit it. Move and Delete appear above the box while editing.
- Changes save every second. Offline edits are kept on the device and sent when the connection returns.

## Not built yet

- Password reset and email verification (needs an email provider such as Resend).
- Signup spam protection (add Cloudflare Turnstile to the signup form).
- Live sync of one note open on two devices at once (last save wins per stroke).
