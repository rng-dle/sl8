# The guided tour from setup, every step, on a phone (finger), a phone that has used a pen (S Pen), and a desktop;
# plus "Show me around" from the menu and double-tap to write on a fresh canvas.
# python3 test/tour-test.py [base-url] [screenshot-dir]
import random, sys
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
OUT = sys.argv[2] if len(sys.argv) > 2 else None
failed = 0
def ok(cond, name, extra=""):
    global failed
    print(("ok  " if cond else "FAIL") + " - " + name + ("" if cond or not extra else f"\n       {extra}"))
    failed += 0 if cond else 1

def journey(br, device):
    phone = device != "desktop"
    ctx = br.new_context(viewport={"width": 412, "height": 900} if phone else {"width": 1280, "height": 820}, has_touch=phone, is_mobile=phone,
                         extra_http_headers={"cf-connecting-ip": "10.8.%d.%d" % (random.randint(1, 250), random.randint(1, 250))})
    if device == "pen phone":  # this device has been used with a pen, and last time the pen tool was picked
        ctx.add_init_script("if (!sessionStorage.getItem('seeded')) { localStorage.setItem('sl8:penSeen', 'true'); localStorage.setItem('sl8:tool', '\"pen\"'); sessionStorage.setItem('seeded', '1'); }")
    pg = ctx.new_page()
    global last; last = pg
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    cdp = pg.context.new_cdp_session(pg)
    tap = (lambda sel: pg.tap(sel)) if phone else (lambda sel: pg.click(sel))
    def at(x, y):
        if phone: pg.touchscreen.tap(x, y)
        else: pg.mouse.click(x, y)
    def stroke(x, y):  # a short line: finger on a phone, the pen on a pen phone, the mouse on desktop
        pts = [(x + i * 8, y + (i % 3) * 5) for i in range(8)]
        if device == "desktop":
            pg.mouse.move(*pts[0]); pg.mouse.down()
            for p in pts[1:]: pg.mouse.move(*p)
            pg.mouse.up(); return
        if device == "pen phone":
            for i, (px, py) in enumerate(pts):
                kind = "mousePressed" if i == 0 else "mouseMoved"
                cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": px, "y": py, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6, "clickCount": 1 if i == 0 else 0})
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": pts[-1][0], "y": pts[-1][1], "button": "left", "buttons": 0, "pointerType": "pen", "clickCount": 1})
            return
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pts[0][0], "y": pts[0][1]}]})
        for px, py in pts[1:]: cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": px, "y": py}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    step = lambda: pg.text_content(".tour .tour-step")
    def wait_step(n):
        pg.wait_for_function(f"() => document.querySelector('.tour-step')?.textContent.startsWith('{n} of')", timeout=5000)

    # sign up and choose the guided tour
    pg.goto(B + "/")
    pg.wait_for_selector("#auth:not([hidden])")
    tap("#tab-signup")
    pg.fill("#email", f"tour{random.randint(1, 999999)}@example.com")
    pg.fill("#password", "correcthorse")
    tap("#submit")
    pg.wait_for_url("**/welcome")
    tap("[data-start=tour]")
    pg.wait_for_selector("#s2:not([hidden])")
    tap("#later")
    pg.wait_for_url("**/note?id=*")
    pg.wait_for_selector(".reveal-skip:not([hidden])", timeout=5000)
    tap(".reveal-skip")
    pg.wait_for_selector(".reveal", state="detached", timeout=5000)
    pg.wait_for_selector(".tour")
    ring = pg.evaluate("() => ringOn()")
    ok(step() == "1 of 8" and pg.evaluate("() => tool.name") == "select", f"{device}: the tour starts after the opening, in the select tool")

    tap(".tour .btn.primary"); wait_step(2)
    if ring:
        ok("Tap it to open" in pg.text_content(".tour .tour-text"), f"{device}: step 2 points at the tools button")
        tap("#fab")  # opening the ring finishes the step
    else:
        tap(".tour .btn.primary")
    wait_step(3)
    tap('[data-tool="pen"]'); wait_step(4)
    ok(pg.evaluate("() => tool.name") == "pen", f"{device}: picking the pen finishes step 3")
    if ring: tap("#ring-scrim")  # "tap the canvas to close the ring"
    stroke(120, 620); wait_step(5)
    ok(pg.evaluate("() => [...items.values()].filter((i) => i.kind === 'stroke').length") == 1, f"{device}: drawing finishes step 4")
    if ring: tap("#fab")
    tap('[data-tool="text"]')
    if ring: tap("#ring-scrim")
    at(150, 720); wait_step(6)
    ok(pg.evaluate("() => document.activeElement?.tagName") == "TEXTAREA", f"{device}: tapping with the text tool starts a note and finishes step 5")
    pg.keyboard.type("hello from the tour")
    for n in (7, 8):
        tap(".tour .btn.primary"); wait_step(n)
    ok(pg.text_content(".tour .btn.primary") == "Done" and pg.locator(".tour .btn.quiet").is_hidden(), f"{device}: the last step says Done")
    if OUT: pg.screenshot(path=f"{OUT}/tour-{device.replace(' ', '-')}.png")
    tap(".tour .btn.primary")
    pg.wait_for_selector(".tour", state="detached")
    pg.wait_for_function("() => document.querySelector('#status').textContent === 'Saved'", timeout=8000)
    ok(pg.evaluate("() => [...items.values()].some((i) => i.kind === 'text' && i.text === 'hello from the tour')"), f"{device}: the note written during the tour is saved")

    # double-tap writes with the select tool, then the menu brings the tour back
    tap('[data-tool="select"]') if not ring else (tap("#fab"), tap('[data-tool="select"]'))
    if ring and pg.evaluate("() => ringOpen()"): tap("#ring-scrim")
    before = pg.evaluate("() => document.querySelectorAll('.tb').length")
    if phone:
        pg.touchscreen.tap(250, 500); pg.wait_for_timeout(100); pg.touchscreen.tap(250, 500)
    else:
        pg.mouse.dblclick(900, 500)
    pg.wait_for_timeout(300)
    ok(pg.evaluate("() => document.querySelectorAll('.tb').length") == before + 1, f"{device}: double-tap on empty space starts a note")
    pg.keyboard.press("Escape")
    tap("#menu-open"); tap("#tour-start")
    pg.wait_for_selector(".tour")
    ok(step() == "1 of 8", f"{device}: Show me around starts the tour again")
    tap(".tour .btn.quiet")
    pg.wait_for_selector(".tour", state="detached")
    ok(not errors, f"{device}: no page errors", "; ".join(errors))
    ctx.close()

with sync_playwright() as p:
    br = p.chromium.launch()
    for device in ("phone", "pen phone", "desktop"):
        try:
            journey(br, device)
        except Exception as e:
            import traceback; ok(False, f"{device}: the tour ran to the end", str(e).splitlines()[0] + " @ line " + str(traceback.extract_tb(e.__traceback__)[-2].lineno if len(traceback.extract_tb(e.__traceback__)) > 1 else "?"))
            if OUT: last.screenshot(path=f"{OUT}/tour-fail-{device.replace(' ', '-')}.png")
    br.close()
print("all passed" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
