# Regression check for palm rejection: a resting palm must not block or cancel S Pen strokes.
# Run with `npx wrangler dev` going: python3 pen-test.py [base-url]
import random, sys
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_context(viewport={"width": 412, "height": 900}, has_touch=True).new_page()
    pg.goto(B + "/")
    pg.click("#tab-signup")
    pg.fill("#email", f"pen{random.randint(1, 99999)}@example.com")
    pg.fill("#password", "correcthorse")
    pg.click("#submit")
    pg.click("#new")
    pg.wait_for_selector("#status:text('Saved')")
    cdp = pg.context.new_cdp_session(pg)

    def pen(kind, x, y, buttons=1):
        cdp.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left" if kind != "mouseMoved" or buttons else "none",
                                               "buttons": buttons, "pointerType": "pen", "force": 0.6, "clickCount": 1 if kind != "mouseMoved" else 0})

    def palm(kind, x=300, y=600):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [] if kind == "touchEnd" else [{"x": x, "y": y, "id": 7}]})

    # 1. palm lands first and drifts, then the pen writes
    palm("touchStart")
    pen("mouseMoved", 60, 300, 0)  # hover
    pen("mousePressed", 60, 300)
    for i in range(1, 20):
        pen("mouseMoved", 60 + i * 12, 300)
        palm("touchMove", 300 + i * 3, 600 + i * 3)
    pen("mouseReleased", 60 + 19 * 12, 300)
    palm("touchEnd")
    a = pg.evaluate("[...items.values()].filter(i => i.kind === 'stroke')")

    # 2. palm lands while the pen is mid-stroke (two contact points, like a real palm)
    pg.wait_for_timeout(900)
    pen("mouseMoved", 60, 400, 0)
    pen("mousePressed", 60, 400)
    for i in range(1, 10):
        pen("mouseMoved", 60 + i * 12, 400)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 300, "y": 650, "id": 8}, {"x": 330, "y": 680, "id": 9}]})
    for i in range(10, 20):
        pen("mouseMoved", 60 + i * 12, 400)
    pen("mouseReleased", 60 + 19 * 12, 400)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    b = pg.evaluate("[...items.values()].filter(i => i.kind === 'stroke')")
    cam = pg.evaluate("cam")

    # 3. once the pen is put away, a finger moves the page again
    pg.wait_for_timeout(900)
    palm("touchStart", 200, 600)
    for i in range(1, 6):
        palm("touchMove", 200, 600 - i * 20)
    palm("touchEnd")
    cam2 = pg.evaluate("cam")
    br.close()

full = lambda s: len(s["p"]) >= 19 * 3 and s["pr"] is True  # whole pen stroke, with pressure
ok1 = len(a) == 1 and full(a[0])
ok2 = len(b) == 2 and full(b[1])
ok3 = cam["x"] == 48 and cam["y"] == 96
print(("ok  " if ok1 else "FAIL") + " - pen writes while a palm is already resting")
print(("ok  " if ok2 else "FAIL") + " - palm landing mid-stroke does not cut the stroke, and pressure is recorded")
ok4 = cam2["y"] == 96 - 100
print(("ok  " if ok3 else "FAIL") + f" - palm did not move the page (camera {cam})")
print(("ok  " if ok4 else "FAIL") + f" - finger pans once the pen is away (camera {cam2})")
sys.exit(0 if ok1 and ok2 and ok3 and ok4 else 1)
