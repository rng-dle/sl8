# ThinkSL8 Android wrapper

Thin Trusted Web Activity around https://thinksl8.com. Declares `CREATE_NOTE` so Android can offer it as the default notes app.

## One-time setup (run in the repo root; needs `gh` logged in, plus `keytool` and `openssl`; Git Bash/WSL/Linux)

```
P=$(openssl rand -hex 16) && keytool -genkeypair -keystore thinksl8.jks -alias thinksl8 -keyalg RSA -keysize 2048 -validity 10000 -storepass $P -keypass $P -dname "CN=ThinkSL8" && base64 -w0 thinksl8.jks | gh secret set KEYSTORE_B64 && gh secret set KEYSTORE_PASSWORD --body "$P" && echo "Back up thinksl8.jks somewhere safe, password: $P"
```

Losing `thinksl8.jks` means you can never update the installed app. Don't commit it.

## Build

Push, or run the "Android APK" workflow by hand (Actions tab). Download the `thinksl8-apk` artifact, copy the APK to the phone, install it. The log prints the signing SHA-256.

## Make it fullscreen (no URL bar)

Paste the SHA-256 from the build log into `ANDROID_SHA256` in `src/index.js` and deploy. The Worker then serves `/.well-known/assetlinks.json`. Reinstall the app after.

## Make it the notes app

Phone: Settings → Apps → Choose default apps → Notes app → ThinkSL8 (the entry may be missing or ignored on Samsung; that is the thing to test). Then pull the pen with "When S Pen is removed" set to Create note.
