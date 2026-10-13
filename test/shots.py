import asyncio, sys, re
from playwright.async_api import async_playwright
SHOT = sys.argv[1] if len(sys.argv) > 1 else "."
STUB = "export function createClient(){ return {}; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errs = []
        for name, (w, h) in {"desk": (1280, 900), "movil": (390, 800)}.items():
            pg = await b.new_page(viewport={"width": w, "height": h})
            pg.on("pageerror", lambda e: errs.append("PAGEERR " + str(e)))
            await pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
            await pg.route("**/fonts.g*/**", lambda r: r.abort())
            await pg.goto("http://localhost:8765/index.html?demo")
            await pg.wait_for_selector("main")
            for view in ["#/hoy", "#/calendario", "#/calendario/semana", "#/config", "#/config/horarios", "#/config/mensajes", "#/config/consultorio"]:
                await pg.evaluate(f"location.hash='{view}'")
                await pg.wait_for_timeout(250)
                ov = await pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                if ov > 1: errs.append(f"overflow {name} {view} {ov}")
                await pg.screenshot(path=f"{SHOT}/{name}-{re.sub('[^a-z]+','-',view)}.png", full_page=True)
            if name == "desk":
                await pg.evaluate("location.hash='#/config'"); await pg.wait_for_timeout(200)
                await pg.click(".proc-card summary")
                await pg.screenshot(path=f"{SHOT}/desk-proc-open.png", full_page=True)
                f = ".proc-card[open] form"
                await pg.fill(f + " input[name=win_min_n]", "2"); await pg.fill(f + " input[name=win_max_n]", "3")
                await pg.select_option(f + " select[name=first_before]", "7")
                await pg.uncheck(f + " input[name=postcare_h][value='24']"); await pg.check(f + " input[name=postcare_h][value='168']")
                await pg.click(f + " button.primary"); await pg.wait_for_timeout(300)
                print("toast:", await pg.inner_text("#toast"))
                print("summary:", await pg.inner_text(".proc-card summary"))
                print("open after save:", await pg.evaluate("document.querySelector('.proc-card').open"))
                await pg.fill(".proc-card[open] form input[name=win_max_n]", "1"); await pg.click(".proc-card[open] form button.primary"); await pg.wait_for_timeout(200)
                print("bad range toast:", await pg.inner_text("#toast"))
                await pg.evaluate("location.hash='#/config/horarios'"); await pg.wait_for_timeout(200)
                await pg.select_option("#f-appt_reminder_hours", "48"); await pg.click("form:has(#f-appt_reminder_hours) button.primary"); await pg.wait_for_timeout(300)
                print("appt hours:", await pg.input_value("#f-appt_reminder_hours"))
                await pg.evaluate("location.hash='#/calendario'"); await pg.wait_for_timeout(200)
                print("cal chips:", await pg.locator(".cal .chip").count(), "| month:", await pg.inner_text("h1"))
                await pg.click(".cal-day.today"); await pg.wait_for_timeout(200)
                print("sel panel:", (await pg.inner_text(".cal + section")).replace("\n", " | ")[:300])
                await pg.click("[data-act=month][data-d='-1']"); await pg.wait_for_timeout(200)
                print("prev month:", await pg.inner_text("h1"), await pg.locator(".cal .chip.due").count())
                await pg.evaluate("location.hash='#/hoy'"); await pg.wait_for_timeout(200)
                print("hoy groups:", [await x.inner_text() for x in await pg.locator("section h2").all()])
            await pg.close()
        print("ERRORS:", errs)
        await b.close()
asyncio.run(main())
