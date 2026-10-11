# Browser run of the v1 journey against `wrangler dev` + test/fake-provider.mjs.
# python3 test/journey.py [base-url] [screenshot-dir]
import random, sys
RUN_IP = {"cf-connecting-ip": "10.%d.%d.%d" % tuple(random.randint(1, 250) for _ in range(3))}  # own address for rate limits
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
failed = 0
def ok(cond, name, extra=""):
    global failed
    print(("ok  " if cond else "FAIL") + " - " + name + ("" if cond or not extra else f"\n       {extra}"))
    failed += 0 if cond else 1

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 1280, "height": 820}, device_scale_factor=1)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))

    # sign up -> setup
    pg.goto(B + "/")
    pg.wait_for_selector("#auth:not([hidden])")
    pg.screenshot(path=f"{OUT}/01-landing.png")
    pg.click("#tab-signup")
    pg.fill("#email", f"journey{random.randint(1, 99999)}@example.com")
    pg.fill("#password", "correcthorse")
    pg.click("#submit")
    pg.wait_for_url("**/welcome")
    ok(True, "new account lands on setup")
    pg.screenshot(path=f"{OUT}/02-welcome.png")
    pg.click("[data-start=sample]")
    pg.wait_for_selector("#s2:not([hidden])")
    pg.screenshot(path=f"{OUT}/03-welcome-ai.png")

    # connect AI through the (stand-in) OpenRouter sign-in, then the reveal plays into the canvas
    pg.click("#connect")
    pg.wait_for_url("**/note?id=*")
    pg.wait_for_timeout(500)
    ok(pg.locator(".reveal").count() == 1, "the infinity reveal plays after setup")
    pg.screenshot(path=f"{OUT}/04-reveal.png")
    pg.wait_for_selector(".reveal", state="detached", timeout=5000)
    pg.wait_for_selector("#status:text('Saved')")
    ok(pg.locator(".tb").count() == 7, "sample canvas shows its notes")
    ok(not pg.locator("#ai").is_hidden(), "returning from AI sign-in opens the AI panel")
    pg.wait_for_selector("#ai-foot:not([hidden])")
    ok("OpenRouter" in pg.text_content("#ai-model"), "AI panel shows the connected provider", pg.text_content("#ai-model"))
    pg.click("#ai-close")

    # write a thought by double-clicking empty space
    pg.mouse.dblclick(900, 600)
    pg.keyboard.type("Pricing: $9 a month for students")
    pg.mouse.click(1100, 300)  # finish editing
    pg.wait_for_selector("#status:text('Saved')")
    ok(pg.locator(".tb").count() == 8, "double-click creates a text box")

    # draw, then box-select the new note and the stroke, move them, undo
    pg.click("[data-tool=pen]")
    pg.mouse.move(880, 680); pg.mouse.down()
    for i in range(20): pg.mouse.move(880 + i * 8, 680 + (i % 4) * 3)
    pg.mouse.up()
    pg.click("[data-tool=select]")
    pg.mouse.move(860, 570); pg.mouse.down(); pg.mouse.move(1150, 720, steps=8); pg.mouse.up()
    ok(pg.evaluate("selection.size") == 2, "box select picks the text and the stroke", pg.evaluate("selection.size"))
    pg.wait_for_selector("#selbar:not([hidden])", timeout=2000)
    ok(True, "selection bar appears")
    before = pg.evaluate("[...selection].map(id => items.get(id)).find(i => i.kind === 'text').x")
    pg.mouse.move(960, 610); pg.mouse.down(); pg.mouse.move(1010, 640, steps=6); pg.mouse.up()
    after = pg.evaluate("[...selection].map(id => items.get(id)).find(i => i.kind === 'text').x")
    ok(after == before + 50, "dragging moves the selection", f"{before} -> {after}")
    pg.screenshot(path=f"{OUT}/05-selection.png")

    # ask AI about the selection
    pg.click("#sel-ai")
    pg.wait_for_selector("#ai-foot:not([hidden])")
    pg.wait_for_function("document.querySelector('input[name=ai-scope][value=selection]').checked", timeout=3000)
    ok(True, "Ask AI from a selection reads only the selection")
    pg.click("[data-action=summarize]")
    pg.wait_for_selector(".msg-actions", timeout=10000)
    ans = pg.text_content(".msg-a .text")
    ok("$9 a month" in ans, "answer is grounded in the selected note", ans)
    ok(pg.locator(".cite").count() >= 1, "answer cites its source")
    pg.screenshot(path=f"{OUT}/06-ai-answer.png")
    pg.click(".msg-actions >> text=Add to canvas")
    pg.wait_for_selector("#status:text('Saved')")
    ok(pg.locator(".tb").count() == 9, "Add to canvas places the answer as a note")

    # ask about the whole canvas
    pg.check("input[name=ai-scope][value=canvas]")
    pg.fill("#ai-q", "What did I write about pricing?")
    pg.keyboard.press("Enter")
    pg.wait_for_function("document.querySelectorAll('.msg-actions').length === 2", timeout=10000)
    ok(pg.locator(".msg-a").count() == 2, "follow-up question answered")

    # persistence after reload
    n = pg.evaluate("items.size")
    pg.reload()
    pg.wait_for_selector("#status:text('Saved')")
    ok(pg.evaluate("items.size") == n, "everything is still there after reloading", f"{n} vs {pg.evaluate('items.size')}")
    ok(pg.locator(".reveal").count() == 0, "reloading doesn't replay the reveal")

    # settings: connected state, scope, appearance; then disconnect
    pg.goto(B + "/settings")
    pg.wait_for_selector("#ai-on:not([hidden])")
    pg.wait_for_function("!document.querySelector('#model').disabled")
    ok("Signed in with OpenRouter" in pg.text_content("#ai-how"), "Settings shows the sign-in connection")
    pg.check("input[name=theme][value=dark]")
    pg.screenshot(path=f"{OUT}/07-settings-dark.png", full_page=True)
    pg.click("#disconnect"); pg.click("#disconnect")
    pg.wait_for_selector("#ai-off:not([hidden])")
    ok(True, "disconnect returns Settings to the connect screen")
    pg.screenshot(path=f"{OUT}/08-settings-off-dark.png", full_page=True)

    # returning user: log out, log in, short reveal straight into the last canvas
    email = pg.text_content("#email")
    pg.click("#logout")
    pg.wait_for_selector("#auth:not([hidden])")
    pg.fill("#email", email); pg.fill("#password", "correcthorse"); pg.click("#submit")
    pg.wait_for_url("**/note?id=*")
    ok(True, "logging in opens the last canvas directly")
    pg.wait_for_selector(".reveal", state="detached", timeout=3000)

    # search from the canvases page
    pg.goto(B + "/canvases")
    pg.fill("#q", "studen")
    pg.wait_for_selector("#results li")
    ok("$9" in pg.text_content("#results") and pg.locator("#results mark").count() >= 1, "search finds a note by part of a word and highlights it")
    pg.screenshot(path=f"{OUT}/11-search-dark.png")
    pg.click("#results li a >> nth=0")
    pg.wait_for_url("**/note?id=*#item-*")
    pg.wait_for_selector("#status:text('Saved')")
    ok(True, "a search result opens the canvas at that note")

    # forgot password, by email, in the browser
    pg.goto(B + "/settings")
    pg.click("#logout")
    pg.wait_for_selector("#auth:not([hidden])")
    pg.click("#forgot")
    pg.fill("#email", email)
    pg.click("#ask-btn")
    pg.wait_for_selector("#asked:not([hidden])")
    pg.screenshot(path=f"{OUT}/12-reset-sent-dark.png")
    import json, urllib.request
    mails = json.load(urllib.request.urlopen("http://127.0.0.1:8788/__emails?to=" + email))
    link = mails[-1]["text"].split("\n")[3]
    pg.goto(link)
    ok(pg.url.endswith("/reset"), "the reset token is removed from the address bar")
    pg.fill("#password", "newpassword9")
    pg.click("#set-btn")
    pg.wait_for_url("**/note?id=*")
    ok(True, "choosing a new password signs straight back in")

    # phone, dark
    m = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, storage_state=ctx.storage_state())
    mp = m.new_page()
    mp.goto(pg.url)
    mp.wait_for_selector("#status:text('Saved')")
    mp.screenshot(path=f"{OUT}/09-phone-canvas.png")
    mp.click("#ai-open")
    mp.wait_for_timeout(400)
    mp.screenshot(path=f"{OUT}/10-phone-ai.png")
    wide = mp.evaluate("document.documentElement.scrollWidth > innerWidth")
    ok(not wide, "no sideways scroll on a phone")
    ok(not errors, "no script errors", "; ".join(errors[:3]))
    br.close()

print(f"{failed} failed" if failed else "all passed")
sys.exit(1 if failed else 0)
