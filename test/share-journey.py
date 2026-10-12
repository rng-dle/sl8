# Browser run of sharing and sync against `wrangler dev`: the owner shares chosen squares to edit, someone without an
# account draws inside them (and is stopped outside), the owner's open canvas picks it up, a view link only looks,
# and a second device of the owner's sees the owner's own changes. python3 test/share-journey.py [base-url] [screenshot-dir]
import json, random, re, sys, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
IP = {"cf-connecting-ip": "10.%d.%d.%d" % tuple(random.randint(1, 250) for _ in range(3))}
failed = 0
def ok(cond, name, extra=""):
    global failed
    print(("ok  " if cond else "FAIL") + " - " + name + ("" if cond or not extra else f"\n       {extra}"))
    failed += 0 if cond else 1

count = "() => items.size"
with sync_playwright() as p:
    br = p.chromium.launch()
    def context():
        c = br.new_context(extra_http_headers=IP, viewport={"width": 1280, "height": 820}, device_scale_factor=1)
        c.add_init_script("localStorage.setItem('sl8:toolbar', '\"bar\"')")
        return c
    owner = context()
    pg = owner.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(B + "/")
    post = lambda path, body: pg.evaluate("([p, b]) => api(p, { method: 'POST', body: b })", [path, body])  # the page's own fetch carries the cookie
    email = f"sj{random.randint(1, 99999)}@example.com"
    post("/api/signup", {"email": email, "password": "correcthorse"})
    time.sleep(0.3)  # sharing needs a confirmed email: open the link from the stand-in inbox
    mail = json.load(urllib.request.urlopen("http://127.0.0.1:8788/__emails?to=" + urllib.parse.quote(email)))
    post("/api/verify", {"token": re.search(r"token=([a-f0-9]{64})", next(m for m in mail if "Confirm" in m["subject"])["text"]).group(1)})
    note = post("/api/notes", {"title": "Shared plan"})["note"]
    post(f"/api/notes/{note['id']}/ops", {"ops": [
        {"put": {"id": "a", "kind": "text", "t": 1, "x": 20, "y": 20, "w": 200, "s": 17, "c": "ink", "text": "inside"}},
        {"put": {"id": "b", "kind": "text", "t": 2, "x": 600, "y": 20, "w": 200, "s": 17, "c": "ink", "text": "outside"}}]})
    pg.goto(B + f"/note?id={note['id']}")
    pg.wait_for_selector("#status:text('Saved')")

    # share: Edit, Choose squares, tap the square at the top-left of the canvas (zoom 100%: 96-unit squares)
    pg.click("#menu-open")
    pg.click("#share-open")
    pg.check("input[name=sh-mode][value=write]")
    pg.check("input[name=sh-area][value=pick]")
    pg.click("#sh-create")
    pg.wait_for_selector("#picker:not([hidden])")
    sx, sy = pg.evaluate("() => [cam.x + 40, cam.y + 40]")  # world (40, 40): square 2/0/0
    pg.mouse.click(sx, sy)
    ok(pg.text_content("#pick-done") == "Create link (1)", "tapping a square picks it", pg.text_content("#pick-done"))
    pg.screenshot(path=f"{OUT}/s1-picking.png")
    pg.click("#pick-done")
    pg.wait_for_selector("#sh-new:not([hidden])")
    link = pg.input_value("#sh-link")
    ok("/note?share=" in link and "1 square" in pg.text_content("#sh-list"), "an edit link for one square is made", link)
    pg.screenshot(path=f"{OUT}/s2-link.png")
    pg.mouse.click(1000, 600)  # close the panel

    # someone with the link, no account
    guest = context().new_page()
    guest.on("pageerror", lambda e: errors.append(str(e)))
    guest.goto(link)
    guest.wait_for_selector("#status:text('Saved')")
    ok(guest.evaluate(count) == 1 and guest.locator("#ai-open").is_hidden() and guest.locator("#menu-open").is_hidden(), "the link opens only its square, without account features", str([guest.evaluate(count), guest.locator("#ai-open").is_hidden(), guest.locator("#menu-open").is_hidden(), guest.evaluate("() => share")]))
    guest.click("[data-tool=pen]")
    gx, gy = guest.evaluate("() => [cam.x + 30 * cam.z, cam.y + 50 * cam.z]")
    guest.mouse.move(gx, gy); guest.mouse.down(); guest.mouse.move(gx + 20, gy + 10, steps=6); guest.mouse.up()
    guest.wait_for_selector("#status:text('Saved')")
    ox, oy = guest.evaluate("() => [cam.x + 150 * cam.z, cam.y + 50 * cam.z]")  # the next square over
    guest.mouse.move(ox, oy); guest.mouse.down(); guest.mouse.move(ox + 40, oy + 10, steps=4); guest.mouse.up()
    ok(guest.evaluate(count) == 2 and "highlighted squares" in guest.text_content("#toast"), "drawing works inside the square and is stopped outside", str([guest.evaluate(count), guest.text_content("#toast")]))
    guest.screenshot(path=f"{OUT}/s3-guest.png")

    pg.wait_for_function("() => items.size === 3", timeout=8000)
    ok(True, "the owner's open canvas shows the guest's drawing within seconds")

    # the owner's second device sees the owner's edit, and a delete
    phone = owner.new_page()
    phone.goto(B + f"/note?id={note['id']}")
    phone.wait_for_selector("#status:text('Saved')")
    pg.evaluate("() => { const it = items.get('b'); commit([{ id: 'b', before: it, after: null }]); }")
    phone.wait_for_function("() => !items.has('b')", timeout=8000)
    ok(True, "a delete on one device disappears on the other")
    guest.wait_for_function("() => items.size === 2", timeout=1000)  # 'b' was never visible to the link

    # a view link
    pg.click("#menu-open"); pg.click("#share-open"); pg.check("input[name=sh-mode][value=read]"); pg.check("input[name=sh-area][value='*']"); pg.click("#sh-create")
    pg.wait_for_selector("#sh-new:not([hidden])")
    viewer = context().new_page()
    viewer.goto(pg.input_value("#sh-link"))
    viewer.wait_for_selector("#status:text('View only')")
    ok(viewer.locator(".dock").is_hidden() and viewer.evaluate(count) == 2, "a view link shows the canvas with no tools", str([viewer.locator(".dock").is_hidden(), viewer.evaluate(count)]))
    viewer.mouse.dblclick(700, 500)
    ok(viewer.evaluate(count) == 2, "double-clicking a view link doesn't start a note")

    # turning the edit link off
    pg.click("#sh-list li:last-child button:text('Turn off')")
    pg.wait_for_function("() => document.querySelectorAll('#sh-list li').length === 1")
    guest.mouse.move(gx, gy + 20); guest.mouse.down(); guest.mouse.move(gx + 20, gy + 30, steps=6); guest.mouse.up()
    guest.wait_for_selector("#status:text('Link turned off')", timeout=8000)
    ok(True, "a turned-off link stops saving and says so")
    ok(not errors, "no page errors", "; ".join(errors))
    br.close()

print("all passed" if not failed else f"{failed} failed")
sys.exit(1 if failed else 0)
