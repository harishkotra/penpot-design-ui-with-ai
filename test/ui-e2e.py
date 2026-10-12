#!/usr/bin/env python3
"""End-to-end UI test for Atelier.

Drives the REAL React app in a headless browser, pointed at the mock Penpot MCP
server and the mock model endpoint. Types a prompt, clicks Generate, and waits for
the actual pipeline to finish, then verifies the rendered result and screenshots it.

This proves the browser -> local API -> MCP client -> image path works, not just the
API in isolation.
"""

import json
import sys
import time

from playwright.sync_api import sync_playwright

APP = "http://127.0.0.1:5173/"
MOCK = "http://127.0.0.1:4599"
MCP_URL = f"{MOCK}/mcp/stream?userToken=mock-token"
LLM_BASE = f"{MOCK}/v1"
OUT = "/Users/shk/atelier/results/ui-running.png"

problems = []

with sync_playwright() as pw:
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        print(f"bundled chromium unavailable ({e}); falling back to chrome")
        browser = pw.chromium.launch(channel="chrome")

    page = browser.new_page(viewport={"width": 1680, "height": 1050}, device_scale_factor=2)
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

    page.goto(APP, wait_until="load")
    page.wait_for_selector(".stage", timeout=30000)

    # 1. Fill settings through the real UI inputs.
    inputs = page.query_selector_all(".settings input")
    print(f"settings inputs found: {len(inputs)}")
    if len(inputs) < 4:
        problems.append(f"expected 4 settings inputs, got {len(inputs)}")
    for el, value in zip(inputs, [MCP_URL, LLM_BASE, "mock-coder-1", "mock-key"]):
        el.fill(value)
    page.wait_for_timeout(300)

    # 2. Type a prompt.
    page.fill("textarea", "A pricing page hero for a developer tool, dark theme, three tiers")
    page.wait_for_timeout(200)

    # 3. Click Generate.
    page.click("button.primary")
    print("clicked Generate")

    # 4. Wait for the real pipeline to complete.
    try:
        page.wait_for_selector(".stage img", timeout=40000)
        print("canvas image appeared")
    except Exception as e:
        problems.append(f"canvas image never appeared: {e}")

    try:
        page.wait_for_function("document.querySelectorAll('.step.ok').length === 3", timeout=40000)
        print("all 3 pipeline steps report ok")
    except Exception as e:
        problems.append(f"pipeline did not reach 3 ok steps: {e}")

    page.wait_for_timeout(800)

    # 5. Verify the rendered DOM.
    report = page.evaluate(
        """() => {
        const img = document.querySelector('.stage img');
        const steps = Array.from(document.querySelectorAll('.step')).map(e => e.className);
        const details = Array.from(document.querySelectorAll('.step .detail')).map(e => e.innerText.trim());
        const log = Array.from(document.querySelectorAll('.log p')).map(e => e.innerText.trim());
        const pills = Array.from(document.querySelectorAll('.pill')).map(e => e.innerText.trim());
        const code = document.querySelector('.code-block pre');
        return {
          imgSrcPrefix: img ? img.src.slice(0, 30) : null,
          imgNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
          steps,
          details,
          logLines: log.length,
          log,
          pills,
          codeText: code ? code.innerText.slice(0, 200) : null,
          downloadLink: !!document.querySelector('.download')
        };
      }"""
    )
    print(json.dumps(report, indent=2))

    if not (report["imgSrcPrefix"] or "").startswith("data:image/png"):
        problems.append(f"canvas image is not a PNG data URL: {report['imgSrcPrefix']}")
    if any("error" in s for s in report["steps"]):
        problems.append(f"a pipeline step errored: {report['steps']}")
    if not report["downloadLink"]:
        problems.append("download link missing")

    page.screenshot(path=OUT, full_page=False)
    print(f"wrote {OUT}")

    if errors:
        print("\nbrowser errors:")
        for e in errors[:10]:
            print(f"  {e}")
        problems.append(f"{len(errors)} browser console/page errors")

    browser.close()

print("\n" + "-" * 56)
if problems:
    print("UI TEST FAILED:")
    for p in problems:
        print(f"  - {p}")
    sys.exit(1)
print("UI TEST PASSED")
sys.exit(0)