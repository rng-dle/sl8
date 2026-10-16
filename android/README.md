# ThinkSL8 Android wrapper

Thin Trusted Web Activity around https://thinksl8.com. Declares `CREATE_NOTE` so Android can offer it as the default notes app.

## Build

The "Android APK" workflow runs on pushes to the app, or by hand (Actions tab → Run workflow). Nothing to set up: it makes a dev signing key on the first run and keeps it in the Actions cache. Download the `thinksl8-apk` artifact from the run, unzip, copy the APK to the phone, install it.

The cache can be evicted after 7 idle days. Then the next build has a new key, and you must uninstall the old app before installing it.

## Fullscreen (no URL bar)

Automatic: the workflow commits `android/assetlinks.json` with the signing SHA-256, and the Worker serves it at `/.well-known/assetlinks.json` once Cloudflare deploys. Reinstall the app after that first deploy.

## Make it the notes app

The site asks once, inside the app, after a pen has been used. Or by hand: Settings → Apps → Choose default apps → Notes app → ThinkSL8 (the entry may be missing or ignored on Samsung; that is the thing to test). Then pull the pen with "When S Pen is removed" set to Create note.
