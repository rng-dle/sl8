# Connections, portals, canvas looks, pens and the pull-apart reveal, in a browser against `wrangler dev`.
# python3 test/spatial.py [base-url] [screenshot-dir]
import base64, io, json, random, sys, urllib.request
from playwright.sync_api import sync_playwright

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
OUT = sys.argv[2] if len(sys.argv) > 2 else "."
RUN_IP = {"cf-connecting-ip": "10.%d.%d.%d" % tuple(random.randint(1, 250) for _ in range(3))}
failed = 0
def ok(cond, name, extra=""):
    global failed
    print(("ok  " if cond else "FAIL") + " - " + name + ("" if cond or not extra else f"\n       {extra}"))
    failed += 0 if cond else 1

def items(pg, kind=None):
    return pg.evaluate("k => [...items.values()].filter(i => !k || i.kind === k)", kind)

with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 1280, "height": 820})
    ctx.add_init_script("localStorage.setItem('sl8:toolbar', '\"bar\"')")  # these checks drive the bottom bar; the ring has its own below
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto(B + "/")
    pg.click("#tab-signup")
    pg.fill("#email", f"spatial{random.randint(1, 99999)}@example.com")
    pg.fill("#password", "correcthorse")
    pg.click("#submit")
    pg.wait_for_url("**/welcome")
    pg.click("#skip-all")
    pg.wait_for_url("**/note?id=*")
    pg.wait_for_selector("#status:text('Saved')")
    pg.wait_for_selector(".reveal-8")
    pg.keyboard.press("Escape")
    pg.wait_for_selector(".reveal", state="detached", timeout=5000)
    home = pg.url

    # two notes, then an arrow between them
    pg.mouse.dblclick(300, 300); pg.keyboard.type("Problem"); pg.mouse.click(700, 650)
    pg.mouse.dblclick(800, 300); pg.keyboard.type("Solution"); pg.mouse.click(700, 650)
    texts = items(pg, "text")
    ok(len(texts) == 2, "two notes by double-click")
    pg.click("[data-tool=connect]")
    pg.mouse.move(330, 300); pg.mouse.down(); pg.mouse.move(600, 320, steps=6); pg.mouse.move(830, 300, steps=6); pg.mouse.up()
    conns = items(pg, "conn")
    ok(len(conns) == 1 and {conns[0]["a"], conns[0]["b"]} == {t["id"] for t in texts}, "drag from note to note draws an arrow", json.dumps(conns))

    # drag into empty space: a new connected note to type in
    pg.mouse.move(830, 300); pg.mouse.down(); pg.mouse.move(850, 450, steps=6); pg.mouse.move(900, 520, steps=6); pg.mouse.up()
    pg.keyboard.type("Next step")
    pg.click("[data-tool=select]")
    pg.mouse.click(200, 650)
    pg.wait_for_selector("#status:text('Saved')")
    conns = items(pg, "conn"); texts = items(pg, "text")
    ok(len(conns) == 2 and any(t["text"] == "Next step" for t in texts), "dragging into empty space starts a new linked note")

    # label an arrow by double-clicking it
    ends = pg.evaluate("(() => { const c = [...items.values()].find(i => i.kind === 'conn'); const e = connEnds(c); return [(e[0][0]+e[1][0])/2*cam.z+cam.x, (e[0][1]+e[1][1])/2*cam.z+cam.y, c.id]; })()")
    pg.mouse.dblclick(ends[0], ends[1])
    pg.wait_for_selector(".conn-label")
    pg.keyboard.type("leads to"); pg.keyboard.press("Enter")
    ok(pg.evaluate("id => items.get(id).label", ends[2]) == "leads to", "double-clicking an arrow adds a label")

    # deleting a note takes its arrows; undo brings both back
    pg.mouse.click(310, 300)
    pg.keyboard.press("Delete")
    after = (len(items(pg, "text")), len(items(pg, "conn")))
    pg.keyboard.press("Control+z")
    back = (len(items(pg, "text")), len(items(pg, "conn")))
    ok(after == (2, 1) and back == (3, 2), "deleting a note removes its arrows, undo restores them", f"{after} {back}")
    pg.screenshot(path=f"{OUT}/s1-arrows.png")

    # pens: type, any colour, width
    pg.click("[data-tool=pen]")
    pg.click("#types [aria-label=Pencil]")
    pg.eval_on_selector("#custom-color", "el => { el.value = '#ff8800'; el.dispatchEvent(new Event('input', {bubbles: true})); el.dispatchEvent(new Event('change', {bubbles: true})); }")
    pg.eval_on_selector("#width", "el => { el.value = 9; el.dispatchEvent(new Event('input', {bubbles: true})); }")
    pg.click("#sound")
    pg.mouse.move(300, 600); pg.mouse.down()
    for i in range(25): pg.mouse.move(300 + i * 12, 600 + (i % 5) * 4)
    pg.mouse.up()
    s = items(pg, "stroke")[-1]
    ok(s.get("pt") == "pencil" and s["c"] == "#ff8800" and s["w"] == 9, "pencil, custom colour and width are applied", json.dumps({k: s.get(k) for k in ("pt", "c", "w")}))
    ok(pg.get_attribute("#sound", "aria-pressed") == "true", "writing sounds switch on")
    ok(pg.locator("#swatches [aria-label='Colour #ff8800']").count() == 1, "a custom colour joins the recent swatches")
    for t, x in (("brush", 500), ("nib", 650), ("marker", 800)):
        pg.click(f"#types [aria-label='{ {'brush': 'Brush', 'nib': 'Calligraphy nib', 'marker': 'Marker'}[t] }']")
        pg.mouse.move(x, 680); pg.mouse.down()
        for i in range(20): pg.mouse.move(x + i * 5, 680 + i * 3)
        pg.mouse.up()
    ok([s.get("pt") for s in items(pg, "stroke")][-3:] == ["brush", "nib", "marker"], "brush, nib and marker strokes")

    # this canvas's look, saved to the canvas
    pg.click("#menu-open")
    pg.check("input[name=c-theme][value=blueprint]")
    pg.check("input[name=c-pattern][value=graph]")
    pg.wait_for_timeout(700)
    pg.screenshot(path=f"{OUT}/s2-blueprint.png")
    ok(pg.evaluate("document.documentElement.dataset.theme") == "blueprint", "Blueprint theme applies")
    png = io.BytesIO()
    from PIL import Image
    Image.new("RGB", (64, 64), (200, 120, 40)).save(png, "PNG")
    pg.set_input_files("#c-image", files=[{"name": "bg.png", "mimeType": "image/png", "buffer": png.getvalue()}])
    pg.wait_for_function("look.image", timeout=5000)
    img = pg.evaluate("look.image")
    pg.wait_for_timeout(700)
    r = pg.evaluate("id => fetch('/api/files/' + id).then(r => [r.status, r.headers.get('content-type')])", img)
    ok(r == [200, "image/png"], "uploaded background image is stored and served", str(r))
    pg.keyboard.press("Escape")
    pg.reload()
    pg.wait_for_selector("#status:text('Saved')")
    st = pg.evaluate("look")
    ok(st.get("theme") == "blueprint" and st.get("pattern") == "graph" and st.get("image") == img, "the canvas keeps its look after reloading", json.dumps(st))
    ok("api/files" in pg.evaluate("board.style.backgroundImage"), "image is drawn behind the canvas")

    # portal to a new canvas inside this one
    pg.click("#menu-open")
    pg.click("#portal-add")
    pg.fill("#portal-name", "Inside")
    pg.click("#portal-new button[type=submit]")
    pg.wait_for_selector(".portal")
    ok(pg.text_content(".portal .portal-title") == "Inside", "portal card shows the new canvas")
    pg.wait_for_selector("#status:text('Saved')")
    pg.screenshot(path=f"{OUT}/s3-portal.png")
    pg.click(".portal-open")
    pg.wait_for_url("**/note?id=*")
    pg.wait_for_selector("#status:text('Saved')")
    ok(pg.url != home and pg.input_value("#title") == "Inside", "Open goes into the portal's canvas")
    ok(pg.evaluate("look.theme") == "blueprint", "a canvas made from a portal starts with its parent's look")
    ok(pg.is_visible("#trail") and "Untitled" in pg.text_content("#trail"), "a way back to the parent canvas is shown")
    pg.click("#trail")
    pg.wait_for_url(home)
    pg.wait_for_selector("#status:text('Saved')")
    ok(not pg.is_visible("#trail"), "back on the parent, the way back clears")

    # another account can't see the uploaded image
    other = br.new_context(extra_http_headers={"cf-connecting-ip": "10.200.%d.%d" % (random.randint(1, 250), random.randint(1, 250))})
    op = other.new_page()
    op.goto(B + "/")
    op.click("#tab-signup"); op.fill("#email", f"other{random.randint(1, 99999)}@example.com"); op.fill("#password", "correcthorse"); op.click("#submit")
    op.wait_for_url("**/welcome")
    ok(op.evaluate("id => fetch('/api/files/' + id).then(r => r.status)", img) == 404, "another account can't open your images")
    bad = op.evaluate("""async () => {
      const { note } = await api('/api/notes', { method: 'POST', body: { title: 'x' } });
      const send = (it) => fetch(`/api/notes/${note.id}/ops`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ put: it }] }) }).then(r => r.status);
      return [await send({ id: 'c1', kind: 'conn', t: 1, a: 'x' }), await send({ id: 'p1', kind: 'portal', t: 1 }), await send({ id: 'p2', kind: 'portal', t: 1, target: 'abc', x: 0, y: 0, w: 240, h: 132 })];
    }""")
    ok(bad == [400, 400, 200], "the server rejects malformed arrows and portals", str(bad))
    sv = op.evaluate("""async () => { const { note } = await api('/api/notes', { method: 'POST', body: { title: 'y', style: { theme: 'evil', paper: 'red', size: 9999, pattern: 'grid' } } });
      return (await api('/api/notes/' + note.id)).note.style; }""")
    ok(sv == {"pattern": "grid", "size": 96}, "invalid look settings are dropped or clamped", json.dumps(sv))

    # tear sound: the user's own audio file, kept on this device, plays as the page tears
    import wave
    wav = f"{OUT}/tear.wav"
    with wave.open(wav, "wb") as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(bytes(16000))
    pg.add_init_script("HTMLMediaElement.prototype.play = function () { (window.__played ||= []).push(this.src); return Promise.resolve(); }")
    pg.goto(B + "/settings")
    with pg.expect_file_chooser() as fc: pg.click("input[name=tear][value=own]")
    fc.value.set_files(wav)
    pg.wait_for_function("document.querySelector('#tear-name').textContent === 'tear.wav'")
    ok(pg.evaluate("tearFile.get().then((f) => f && f.size)") > 0, "your own tear sound is kept on this device")
    pg.evaluate("sessionStorage.setItem('sl8:reveal', '1')")
    pg.goto(home)
    pg.wait_for_selector(".reveal-8")
    pg.wait_for_timeout(2500)
    ok(pg.locator(".reveal").count() == 1 and pg.is_visible("text=Drag a loop to stretch it"), "on a computer the opening waits too, and says to drag a loop")
    hx, hy = pg.evaluate("(() => { const m = document.querySelector('.reveal-8').getScreenCTM(); return [m.e, m.f - 80*m.d]; })()")
    pg.mouse.move(hx, hy); pg.mouse.down()
    for k in range(1, 9): pg.mouse.move(hx, hy - 25 * k)
    pg.mouse.up()
    pg.wait_for_selector(".reveal", state="detached", timeout=3000)
    ok(True, "dragging a loop with the mouse stretches it until the page tears")
    ok(any(s.startswith("blob:") for s in pg.evaluate("window.__played || []")), "your own sound plays when the page tears")

    # the stretch-and-tear opening on a phone
    m = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, storage_state=ctx.storage_state())
    mp = m.new_page()
    mp.on("pageerror", lambda e: errors.append(str(e)))
    mp.add_init_script("sessionStorage.setItem('sl8:reveal', '1'); localStorage.setItem('sl8:revealMode', '\"full\"')")
    mp.goto(home)
    mp.wait_for_selector(".reveal .reveal-8")
    mp.wait_for_timeout(900)
    ok(mp.is_visible(".reveal-hint"), "on a phone the opening asks for a finger in each loop")
    mp.screenshot(path=f"{OUT}/s4-reveal-phone.png")
    holes = mp.evaluate("(() => { const m = document.querySelector('.reveal-8').getScreenCTM(); return [[m.e, m.f - 80*m.d], [m.e, m.f + 80*m.d]]; })()")
    cdp = m.new_cdp_session(mp)
    def touch(kind, pts): cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
    (tx, ty), (bx, by) = holes
    touch("touchStart", [(tx, ty), (bx, by)])
    for k in range(1, 5): touch("touchMove", [(tx, ty - 8 * k), (bx, by + 8 * k)])
    mp.wait_for_timeout(100)
    still = mp.locator(".reveal").count() == 1 and "torn" not in (mp.get_attribute(".reveal", "class") or "")
    touch("touchEnd", [])
    ok(still, "a small stretch springs back")
    mp.wait_for_timeout(700)
    touch("touchStart", [(tx, ty), (bx, by)])
    for k in range(1, 8): touch("touchMove", [(tx, ty - 10 * k), (bx, by + 10 * k)])
    mp.wait_for_timeout(50)
    ok("torn" not in (mp.get_attribute(".reveal", "class") or ""), "a long stretch rips the page but holds")
    mp.screenshot(path=f"{OUT}/s4b-stretch-phone.png")
    for k in range(8, 14): touch("touchMove", [(tx, ty - 10 * k), (bx, by + 10 * k)])
    mp.wait_for_timeout(250)
    mp.screenshot(path=f"{OUT}/s4c-tearing-phone.png")
    touch("touchEnd", [])
    mp.wait_for_selector(".reveal", state="detached", timeout=3000)
    ok(True, "stretching the 8 far enough tears the page open")
    mp.screenshot(path=f"{OUT}/s5-phone-canvas.png")
    ok(not mp.evaluate("document.documentElement.scrollWidth > innerWidth"), "no sideways scroll on a phone")

    # the ring: one button, tools in circles around it; and the guided tour, step by step
    rc = br.new_context(extra_http_headers=RUN_IP, viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True, storage_state=ctx.storage_state())
    rc.add_init_script("localStorage.setItem('sl8:toolbar', '\"ring\"'); localStorage.removeItem('sl8:fab'); localStorage.setItem('sl8:tool', '\"select\"')")
    rp = rc.new_page()
    rp.on("pageerror", lambda e: errors.append(str(e)))
    rp.goto(home)
    rp.wait_for_selector("#status:text('Saved')")
    ok(rp.evaluate("document.querySelector('.dock').matches('.ring:not(.open)') && getComputedStyle(document.querySelector('[data-tool=pen]')).opacity === '0'"), "on a phone the tools fold into one round button")
    rcdp = rc.new_cdp_session(rp)
    def rtouch(kind, pts): rcdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})
    def drag(a, b, steps=8):
        rtouch("touchStart", [a])
        for k in range(1, steps + 1): rtouch("touchMove", [(a[0] + (b[0] - a[0]) * k / steps, a[1] + (b[1] - a[1]) * k / steps)])
        rtouch("touchEnd", [])
    onscreen = """[...document.querySelectorAll('.ring-item')].filter(e => !e.closest('[hidden]') && getComputedStyle(e).display !== 'none')
      .every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })"""
    rp.click("#menu-open"); rp.click("#tour-start")
    rp.wait_for_selector(".tour")
    step = lambda n: rp.wait_for_function(f"document.querySelector('.tour-step')?.textContent.startsWith('{n} of')", timeout=4000)
    rp.click(".tour .btn.primary"); step(2)
    rp.tap("#fab"); step(3)
    rp.wait_for_timeout(300)
    ok(rp.evaluate(onscreen), "tapping it fans the tools out around it, all on screen; the tour moves on by itself")
    rp.tap("[data-tool=pen]"); step(4)
    rp.wait_for_timeout(300)
    ok(rp.evaluate(onscreen) and rp.locator(".swatch").count() >= 8, "with the pen picked, its pen types and colours ring the tools")
    rp.locator(".swatch").nth(2).tap()
    rp.mouse.click(60, 300)  # the canvas: closes the ring
    ok(not rp.evaluate("document.querySelector('.dock').classList.contains('open')"), "tapping the canvas closes the ring")
    drag((80, 300), (300, 360))
    step(5)
    ok(items(rp, "stroke")[-1]["c"] == "red", "drawing uses the colour picked in the ring; the tour sees the stroke")
    rp.tap("#fab"); rp.wait_for_timeout(300); rp.tap("[data-tool=text]"); rp.mouse.click(60, 300)
    rp.mouse.click(120, 480); rp.keyboard.type("From the tour"); rp.mouse.click(300, 650)
    step(6)
    ok(True, "placing a note with the text tool moves the tour on")
    for n in (7, 8): rp.click(".tour .btn.primary"); step(n)
    rp.click(".tour .btn.primary")
    ok(rp.locator(".tour").count() == 0, "the tour finishes")
    # drag the button to the left edge; the ring still opens fully on screen
    fx, fy = rp.evaluate("(() => { const r = document.querySelector('#fab').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()")
    drag((fx, fy), (30, 420))
    rp.wait_for_timeout(200)
    moved = rp.evaluate("JSON.parse(localStorage.getItem('sl8:fab') || 'null')")
    rp.tap("#fab"); rp.wait_for_timeout(350)
    ok(moved and moved["fx"] < 0.2 and rp.evaluate("document.querySelector('.dock').classList.contains('open')") and rp.evaluate(onscreen), "the button can be dragged anywhere, and the ring still opens fully on screen")
    rp.screenshot(path=f"{OUT}/s6-ring-left.png")
    rp.keyboard.press("Escape")
    ok(not errors, "no script errors", "; ".join(errors[:3]))
    br.close()

print(f"{failed} failed" if failed else "all passed")
sys.exit(1 if failed else 0)
