"""Renders the Holdfast explainer from the evidence files.

Figures are read from evidence/ where a file holds them, so a rerun after new results updates the video. Windows speech
records the voice, scenes.html draws each frame with WebGL in headless Chromium, and ffmpeg encodes the file.

    pip install playwright pillow imageio-ffmpeg
    python video/make_video.py            # writes video/build/holdfast-explainer.mp4
    python video/make_video.py --stills   # one still per scene, no audio, to check the layout
"""
import glob, json, os, subprocess, sys, wave
import imageio_ffmpeg
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "build")
FPS, SCALE = 30, 1.5  # 1280x720 CSS pixels, captured at 1920x1080


def ev(path):
    with open(os.path.join(ROOT, "evidence", path), encoding="utf8") as f:
        return json.load(f)


def data():
    gas, llm, verify, v3 = ev("v4/gas-compare.json"), ev("v4/llm-live.json"), ev("v4/verification.json"), ev("v3/verification.json")
    attack, slither, mutation = ev("v4/attack-results.json")["summary"], ev("v4/slither.json"), ev("v4/mutation-check.json")
    suites = lambda v: {s["name"]: s["passed"] for s in v["suites"]}
    now, before = suites(verify), suites(v3)
    m = gas["medianGas"]
    sell = lambda k: int(m[k]["sell"])
    sandwich = attack["sandwich"]
    return {
        "site": "holdfast-09jn.onrender.com (testnet)",
        "repo": "github.com/monickverma/holdfast",
        "limits": ["Cap per trade", "Hourly budget", "Daily budget", "Lifetime cap", "Price floor", "Band around the pool's average", "Key that expires", "Daily loss budget", "Share of the balance", "Gap between trades"],
        # From the README's Evidence table; the runs are under evidence/ and data/ (BENCHMARKS.md has the method).
        "speed": [
            {"title": "Market move to receipt", "lane": "testnet, 45 + 45 limit orders, older vault", "how": "Reacting to the flashblock stream instead of polling.", "rows": [{"metric": "P50", "before": 1628.5, "after": 225.2}, {"metric": "P90", "before": 2230.2, "after": 413.5}]},
            {"title": "Reading the market", "lane": "mainnet, read only, real HSKSwap pool, 400 + 400", "how": "One pinned request instead of three.", "rows": [{"metric": "P50", "before": 364.2, "after": 203.9}, {"metric": "P99", "before": 513.6, "after": 244.9}]},
        ],
        "gas": [{"name": "Plain router swap", "gas": sell("plain")}, {"name": "Vault version 1", "gas": sell("v1")}, {"name": "Vault version 2", "gas": sell("v2")},
                {"name": "Version 3, guard on", "gas": sell("v3GuardOn")}, {"name": "Version 4, guard on", "gas": sell("v4GuardOn")}],
        "deployGas": int(gas["deployGas"]["v4"]), "runtimeBytes": gas["runtimeBytes"]["v4"],
        "attacks": {"n": attack["attacks"]["n"], "contained": attack["attacks"]["contained"], "benign": attack["benign"]["n"], "completed": attack["benign"]["completed"],
                    "loss": f'{sandwich["budgetEqualsLifetimeCap"]["lostUsdt"]:.2f}', "lossThird": f'{sandwich["budgetSetToOneThird"]["lostUsdt"]:.2f}'},
        # Version 2 counts are from the README; it kept no verification file.
        "tests": [
            {"title": "Agent tests", "values": [["v2", 191], ["v3", before["agent"]], ["v4", now["agent"]]]},
            {"title": "Contract tests", "values": [["v2", 51], ["v3", before["contracts"]], ["v4", now["contracts"]]]},
            {"title": "Planted bugs caught", "values": [["v2", 0], ["v3", 37], ["v4", mutation["killed"]]]},
        ],
        "slither": f'Slither: {slither.get("findings", 34)} findings, {slither.get("untriaged", 0)} untriaged, triaged by us. {mutation["killed"]} of {mutation["mutants"]} planted bugs caught in version 4.',
        "llm": {"provider": llm.get("provider", "?"), "model": llm.get("model", "?"), "passed": llm.get("passed", 0), "total": llm.get("total", 0), "cost": llm.get("costUsd", 0),
                "results": [{"name": r["name"], "pass": r["pass"], "latencyMs": r.get("latencyMs", 0)} for r in llm.get("results", [])]},
        "runbook": [s["name"] for s in ev("v4/mainnet-dress-rehearsal-fork.json")["steps"]],
        # docs/MAINNET-RUNBOOK.md, and the README's mainnet read-only stream row.
        "deployHsk": "2.83", "withSwapHsk": "4.2", "frames": "410 / 410",
    }


def narration(D):
    L, A = D["llm"], D["attacks"]
    g0, g4 = D["gas"][0]["gas"], D["gas"][-1]["gas"]
    agent, contracts, mutants = D["tests"][0]["values"], D["tests"][1]["values"], D["tests"][2]["values"]
    return [
        "Holdfast is an AI trading agent for the H S K Swap pool on H S K Chain. Its key can trade, but only inside limits a contract enforces, whatever the agent or its model is told.",
        "A trading agent needs a key. That key can be stolen. The logic can loop. The price can be wrong. A prompt can talk the model into a bad strategy. If the agent itself is what failed, its own promises mean nothing. So the limits live in the vault, on chain.",
        "You write the strategy in plain English. A model drafts it as a policy, our code shows what it really does, and nothing runs until you approve. The rules decide. If you turn on the optional model engine, it can only propose a trade, and the rules, the breaker and the vault judge every proposal, so a bad model answer cannot break a limit.",
        "Here is the hot path in detail. Everything off chain is assumed to fail. The stream, the pool read and the outside price feed the decision rules, which judge any proposal from the model engine. Guards apply a breaker and an inventory limit. The executor signs once, sends, and records to a crash safe ledger. On chain, the vault checks every trade, and the output returns to the vault. Shadow and Frame Drift watch mainnet with no key.",
        "Vault version four enforces ten limits: a cap per trade, hourly, daily and lifetime budgets, a price floor, a band around the pool's average price, a key that expires, a daily loss budget, a share of the balance, and a gap between trades. Only the owner can withdraw.",
        "Reacting to H S K Chain's flashblock stream instead of polling cut the time from a market move to a receipt from 1,629 to 225 milliseconds at the median, on testnet. On mainnet, reading the market in one request instead of three cut it from 364 to 204 milliseconds.",
        f"Safety costs gas. On a fork of mainnet, a plain router swap uses about {round(g0 / 1000)} thousand gas. Vault version four, with its price guard on, uses about {round(g4 / 1000)} thousand. The difference pays for every check you just saw.",
        f"We gave the agent key to an attacker. On a fork, all {A['contained']} of {A['n']} attacks were contained, all {A['completed']} normal trades still completed, and no cap was broken. At worst, a stolen key selling into a pool pushed to its floor lost {A['loss']} dollars, or {A['lossThird']} with the budget at a third.",
        f"Each version was tested harder. Agent tests grew from {agent[0][1]} to {agent[-1][1]}, contract tests from {contracts[0][1]} to {contracts[-1][1]}, and all {mutants[-1][1]} bugs we planted in version four were caught. The static analysis findings are triaged, by us, not by an auditor.",
        "We built seven techniques and report each result. Two are kept: the shadow trader, which found no opportunities once a twenty basis point fee is charged, and Frame Drift, our strongest result. Four are only partly shown, and hedged send stays off.",
        "A code review of twenty problems changed what we built. A stolen key now loses less and expires. Repeat fills, a wedged agent, false stops and limit overshoot are all fixed and measured. None of this has run on public testnet or mainnet.",
        "The fixes have costs. Gas rose thirteen percent, and recovery from a rate limit is slower. Our own review then found eleven more problems, including stops that can confirm too early with the stream on. One, chat edits that could re arm a finished order, is now fixed. The vault still caps what the key can spend.",
        f"The chat layer passed a live model check: {L['passed']} of {L['total']} cases, through Open Router, for about {round(L['cost'] * 100)} cents. It turns plain English into stop losses, pacing, sizing, risk and a choice of token, answers position and profit from computed facts, and refuses withdrawals, injections, and assets the vault cannot trade.",
        "The mainnet path is ready. Every step of the runbook, deploy, limits, guard, funding, and one swap through the real router, passed on a fork. Deploying costs about 2.8 H S K. It has not been sent. The public site runs on testnet, and says so.",
        "What we do not claim: no profit is shown, and in replays the model at best matched the rules; the vault is not audited, and one wallet makes most of this pool's trades today. What we can show is the limit holding. Holdfast, on H S K Chain.",
    ]


def speak(i, text):
    path = os.path.join(BUILD, f"voice{i}.wav")
    safe = text.replace("'", "''")
    ps = ("Add-Type -AssemblyName System.Speech;$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
          f"try{{$s.SelectVoice('Microsoft Zira Desktop')}}catch{{}};$s.Rate=2;$s.SetOutputToWaveFile('{path}');$s.Speak('{safe}');$s.Dispose()")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    return path


def main():
    stills = "--stills" in sys.argv
    os.makedirs(BUILD, exist_ok=True)
    D = data()
    lines = narration(D)
    tracks, secs, params = [], [], None
    for i, text in enumerate(lines):
        if stills:
            secs.append(8.0)
            continue
        with wave.open(speak(i, text)) as w:
            params, frames = w.getparams(), w.readframes(w.getnframes())
        per_sec = params.framerate * params.sampwidth * params.nchannels
        secs.append(max(len(frames) / per_sec + 1.1, 6.5))
        lead = int(0.5 * params.framerate) * params.sampwidth * params.nchannels
        tail = int(secs[-1] * params.framerate) * params.sampwidth * params.nchannels - len(frames) - lead
        tracks.append(b"\0" * lead + frames + b"\0" * max(tail, 0))

    out = os.path.join(BUILD, "holdfast-explainer.mp4")
    ff = None
    if not stills:
        audio = os.path.join(BUILD, "voice.wav")
        with wave.open(audio, "wb") as w:
            w.setparams(params)
            w.writeframes(b"".join(tracks))
        ff = subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "png", "-i", "-",
                               "-i", audio, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", out], stdin=subprocess.PIPE)

    with sync_playwright() as p:
        # Use whichever Chromium is already installed, so this Playwright version need not download its own.
        found = sorted(glob.glob(os.path.join(os.environ.get("LOCALAPPDATA", ""), "ms-playwright", "chromium-*", "chrome-win64", "chrome.exe")))
        browser = p.chromium.launch(executable_path=found[-1] if found else None, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1280, "height": 720}, device_scale_factor=SCALE)
        page.goto("file:///" + os.path.join(HERE, "scenes.html").replace("\\", "/"))
        page.evaluate("d => { window.DATA = d; }", D)
        assert page.evaluate("window.sceneCount") == len(lines), "one narration line per scene"
        for i, sec in enumerate(secs):
            if stills:
                page.evaluate("([i, t, d]) => seek(i, t, d)", [i, sec - 0.6, sec])
                page.screenshot(path=os.path.join(BUILD, f"scene{i}.png"))
                continue
            for f in range(int(sec * FPS)):
                page.evaluate("([i, t, d]) => seek(i, t, d)", [i, f / FPS, sec])
                ff.stdin.write(page.screenshot(type="png"))
            print(f"scene {i}: {sec:.1f} s", flush=True)
        browser.close()
    if ff:
        ff.stdin.close()
        ff.wait()
        print("seconds", round(sum(secs), 1), "ffmpeg exit", ff.returncode, "MB", round(os.path.getsize(out) / 1e6, 1), out)
    with open(os.path.join(BUILD, "narration.txt"), "w", encoding="utf8") as f:
        f.write("\n\n".join(f"{i:02d}. {t}" for i, t in enumerate(lines)))


if __name__ == "__main__":
    main()
