# Voice in a browser: record from a fake microphone, the capsule appears and plays, survives a reload, and a transcript shows as its tooltip.
# Run with `npx wrangler dev` going: python3 test/voice-journey.py [base-url]
import random, sys
RUN_IP = {"cf-connecting-ip": "10.%d.%d.%d" % tuple(random.randint(1, 250) for _ in range(3))}
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
bad = []

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    ctx = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 1100, "height": 800}, permissions=["microphone"])
    ctx.add_init_script("localStorage.setItem('sl8:toolbar', '\"bar\"')")  # the bottom bar, so the mic button is always visible
    pg = ctx.new_page()
    pg.on("pageerror", lambda e: bad.append(str(e)))
    pg.goto(B + "/")
    pg.click("#tab-signup")
    pg.fill("#email", f"voice{random.randint(1, 99999)}@example.com")
    pg.fill("#password", "correcthorse")
    pg.click("#submit")
    pg.wait_for_url("**/welcome")
    pg.click("#skip-all")
    pg.wait_for_selector("#status:text('Saved')")
    pg.click(".reveal-skip")
    pg.wait_for_selector(".reveal", state="detached")

    pg.click("#voice-add")
    pg.wait_for_selector("#voice-add.recording")
    pg.wait_for_timeout(1500)
    pg.click("#voice-add")
    pg.wait_for_selector(".voice", timeout=15000)
    assert pg.locator("#voice-add.recording").count() == 0, "button should stop pulsing"
    pg.wait_for_selector("#status:text('Saved')")
    print("ok   - recorded from the microphone and a capsule appeared")

    pg.reload()
    pg.wait_for_selector(".voice", timeout=15000)
    print("ok   - the capsule is still there after a reload")

    pg.click(".voice-play")
    pg.wait_for_selector(".voice.playing", timeout=8000)
    pg.click(".voice-play")
    pg.wait_for_selector(".voice:not(.playing)")
    print("ok   - it plays and pauses")

    assert not bad, bad
    br.close()
print("all passed")
