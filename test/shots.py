import asyncio, sys
from playwright.async_api import async_playwright
STUB = "export function createClient(){ return {}; }"
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        errs=[]
        for name,(w,h) in {"desk":(1280,900),"movil":(390,800)}.items():
            pg = await b.new_page(viewport={"width":w,"height":h})
            pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
            pg.on("pageerror", lambda e: errs.append("PAGEERR "+str(e)))
            await pg.route("**/cdn.jsdelivr.net/**", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
            await pg.route("**/fonts.g*/**", lambda r: r.abort())
            await pg.goto("http://localhost:8765/index.html?demo")
            await pg.wait_for_selector("main")
            ana = await pg.eval_on_selector("a.name", "e=>e.getAttribute('href')")
            for view in ["#/hoy","#/pacientes",ana,"#/agenda","#/mensajes","#/config"]:
                await pg.evaluate(f"location.hash='{view}'")
                await pg.wait_for_timeout(250)
                ov = await pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")
                if ov>1: errs.append(f"overflow {name} {view} {ov}")
                await pg.screenshot(path=f"/tmp/claude-0/-home-claude/66b1372b-a61e-5ed2-8c1d-b086d3e41386/scratchpad/{name}-{view.split('/')[1]}.png", full_page=(view=="#/config" and name=="desk")==False)
            if name=="desk":
                # interacciones
                await pg.evaluate("location.hash='#/hoy'"); await pg.wait_for_timeout(200)
                await pg.click("[data-act=force]"); await pg.wait_for_timeout(400)
                print("toast:", await pg.inner_text("#toast"))
                await pg.click("[data-act=new-patient]"); await pg.fill("#pn","Raúl Prueba"); await pg.fill("#pp","664 123 4567"); await pg.check("input[name=consent]")
                await pg.select_option("#pt", index=1); await pg.fill("#pd","2026-06-20")
                await pg.click("dialog button.primary"); await pg.wait_for_timeout(400)
                print("hash:", await pg.evaluate("location.hash"), "| h1:", await pg.inner_text("h1"))
                print("win:", await pg.inner_text(".win-cap"))
                await pg.fill("#msg","Hola, prueba"); await pg.click(".composer button"); await pg.wait_for_timeout(400)
                print("bubbles:", await pg.locator(".bubble").count())
                await pg.click("[data-act=new-appt]"); await pg.fill("#ad","2026-10-08"); await pg.fill("#at","12:30"); await pg.click("dialog button.primary"); await pg.wait_for_timeout(300)
                await pg.click("[data-act=open-appt]"); await pg.click("dialog button[value=atendida]"); await pg.wait_for_timeout(300)
                print("citas:", await pg.locator(".panel:has(h2:text('Citas')) .rows").inner_text())
                await pg.evaluate("location.hash='#/config'"); await pg.wait_for_timeout(200)
                await pg.fill("#f-reply_delay_seconds","9"); await pg.click("#c-send button.primary"); await pg.wait_for_timeout(300)
                print("delay:", await pg.input_value("#f-reply_delay_seconds"), "| toast:", await pg.inner_text("#toast"))
                await pg.fill(".proc input[name=window_min_days]","80"); await pg.click(".proc button.primary"); await pg.wait_for_timeout(300)
                print("proc:", await pg.input_value(".proc input[name=window_min_days]"), "| toast:", await pg.inner_text("#toast"))
                await pg.click("[data-act=check-conn]"); await pg.wait_for_timeout(200); print("conn:", await pg.inner_text("#conn"))
            await pg.close()
        print("ERRORS:", errs)
        await b.close()
asyncio.run(main())
