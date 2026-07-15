#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import platform
import re
import struct
import time
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import Select, WebDriverWait

FIXTURE_DIR = Path(os.environ.get("FIXTURE_DIR", "release-browser-fixture")).resolve()
CAPTURE_DIR = Path(os.environ.get("CAPTURE_DIR", "release-browser-results/macos")).resolve()
BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:4173")
PCM_SUBFORMAT_GUID = bytes.fromhex("0100000000001000800000aa00389b71")
CAPTURE_DIR.mkdir(parents=True, exist_ok=True)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def parse_wav(path: Path) -> dict[str, int | bool]:
    payload = path.read_bytes()
    require(payload[:4] == b"RIFF" and payload[8:12] == b"WAVE", f"{path}: invalid RIFF/WAVE")
    offset = 12
    fmt: dict[str, int | bool] | None = None
    data: bytes | None = None
    while offset + 8 <= len(payload):
        chunk_id = payload[offset : offset + 4]
        size = struct.unpack_from("<I", payload, offset + 4)[0]
        start = offset + 8
        if chunk_id == b"fmt ":
            audio_format, channels, sample_rate = struct.unpack_from("<HHI", payload, start)
            block_align, bits_per_sample = struct.unpack_from("<HH", payload, start + 12)
            extensible_pcm = (
                audio_format == 0xFFFE
                and size >= 40
                and payload[start + 24 : start + 40] == PCM_SUBFORMAT_GUID
            )
            fmt = {
                "audioFormat": audio_format,
                "extensiblePcm": extensible_pcm,
                "channels": channels,
                "sampleRate": sample_rate,
                "blockAlign": block_align,
                "bitsPerSample": bits_per_sample,
            }
        elif chunk_id == b"data":
            data = payload[start : start + size]
        offset = start + size + (size % 2)
    require(fmt is not None and data is not None, f"{path}: missing fmt/data")
    require(fmt["audioFormat"] == 1 or fmt["extensiblePcm"], f"{path}: not PCM or PCM extensible: {fmt}")
    require(fmt["channels"] == 2 and fmt["sampleRate"] == 48_000 and fmt["bitsPerSample"] == 24, f"{path}: unexpected format {fmt}")
    require(len(data) % int(fmt["blockAlign"]) == 0, f"{path}: partial frame")
    frames = len(data) // int(fmt["blockAlign"])
    maximum = 0
    nonzero = 0
    for index in range(0, len(data), 3):
        raw = data[index] | (data[index + 1] << 8) | (data[index + 2] << 16)
        if raw & 0x800000:
            raw -= 1 << 24
        maximum = max(maximum, abs(raw))
        nonzero += raw != 0
    require(nonzero > 0, f"{path}: silent output")
    require(maximum < 8_388_607, f"{path}: clipped output {maximum}")
    return {**fmt, "frames": frames, "maxAbs": maximum, "nonzero": nonzero, "bytes": len(payload)}


def run_in_page(driver: webdriver.Safari, key: str, body: str, timeout: int = 90) -> dict:
    key_literal = json.dumps(key)
    driver.execute_script(
        f"""
        window[{key_literal}] = {{ state: 'pending' }};
        (async () => {{
          try {{
            const value = await (async () => {{ {body} }})();
            window[{key_literal}] = {{ state: 'done', value }};
          }} catch (error) {{
            window[{key_literal}] = {{
              state: 'error',
              name: error?.name || '',
              error: error?.stack || error?.message || String(error),
            }};
          }}
        }})();
        """
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = driver.execute_script(f"return window[{key_literal}]")
        if state and state.get("state") != "pending":
            return state
        time.sleep(0.25)
    raise RuntimeError(f"in-page operation timed out: {key}")


def decode_one(driver: webdriver.Safari, selector: str, kind: str) -> dict:
    result = run_in_page(
        driver,
        f"decode-{selector}-{kind}",
        f"""
        const input = document.querySelector({json.dumps(selector)});
        if (!input?.files?.[0]) throw new Error('missing input');
        const bytes = await input.files[0].arrayBuffer();
        const context = {"new OfflineAudioContext(2, 1, 48000)" if kind == "offline" else "new AudioContext({ sampleRate: 48000 })"};
        try {{
          const decoded = await context.decodeAudioData(bytes.slice(0));
          return {{
            frames: decoded.length,
            channels: decoded.numberOfChannels,
            sampleRate: decoded.sampleRate,
            contextSampleRate: context.sampleRate,
            contextState: context.state || 'offline',
          }};
        }} finally {{
          if (context.close) {{ try {{ await context.close(); }} catch (_) {{}} }}
        }}
        """,
    )
    return result


def media_one(driver: webdriver.Safari, selector: str) -> dict:
    return run_in_page(
        driver,
        f"media-{selector}",
        f"""
        const input = document.querySelector({json.dumps(selector)});
        if (!input?.files?.[0]) throw new Error('missing input');
        const url = URL.createObjectURL(input.files[0]);
        try {{
          const audio = document.createElement('audio');
          audio.preload = 'metadata';
          return await new Promise((resolve, reject) => {{
            const timer = setTimeout(() => reject(new Error('metadata timeout')), 30000);
            audio.addEventListener('loadedmetadata', () => {{
              clearTimeout(timer);
              resolve({{ duration: audio.duration, readyState: audio.readyState }});
            }}, {{ once: true }});
            audio.addEventListener('error', () => {{
              clearTimeout(timer);
              reject(new Error(audio.error?.message || `media error ${{audio.error?.code || 0}}`));
            }}, {{ once: true }});
            audio.src = url;
          }});
        }} finally {{
          URL.revokeObjectURL(url);
        }}
        """,
        timeout=45,
    )


def collect_diagnostics(driver: webdriver.Safari) -> dict:
    return {
        "a": {
            "offline": decode_one(driver, "#audio-a", "offline"),
            "realtime": decode_one(driver, "#audio-a", "realtime"),
            "media": media_one(driver, "#audio-a"),
        },
        "b": {
            "offline": decode_one(driver, "#audio-b", "offline"),
            "realtime": decode_one(driver, "#audio-b", "realtime"),
            "media": media_one(driver, "#audio-b"),
        },
        "canPlayHeAac": driver.execute_script(
            "return document.createElement('audio').canPlayType('audio/mp4; codecs=\"mp4a.40.5\"')"
        ),
    }


def capture_output(driver: webdriver.Safari, filename: str) -> dict:
    result = run_in_page(
        driver,
        f"capture-{filename}",
        f"""
        const status = document.querySelector('#status');
        const audio = document.querySelector('#preview');
        const download = document.querySelector('#download');
        if (!status || !audio || !download) throw new Error('missing result elements');
        audio.muted = true;
        await audio.play();
        audio.pause();
        download.click();
        const bytes = await (await fetch(download.href)).arrayBuffer();
        const response = await fetch('/capture/{filename}', {{ method: 'POST', body: bytes }});
        if (!response.ok) throw new Error(`capture POST failed: ${{response.status}}`);
        return {{
          text: status.textContent,
          outputFrames: Number(status.dataset.outputFrames),
          detectedBeats: Number(status.dataset.detectedBeats),
          detectedBpm: status.dataset.detectedBpm || '',
          readyState: audio.readyState,
          playResult: 'started',
          href: download.getAttribute('href'),
          filename: download.getAttribute('download'),
          disabled: download.getAttribute('aria-disabled'),
          capturedBytes: bytes.byteLength,
          pageErrors: window.__releaseErrors || [],
        }};
        """,
        timeout=60,
    )
    require(result["state"] == "done", f"capture failed: {result}")
    destination = CAPTURE_DIR / filename
    deadline = time.time() + 30
    while time.time() < deadline and not destination.exists():
        time.sleep(0.2)
    require(destination.exists(), f"capture file missing: {destination}")
    return {**result["value"], "wav": parse_wav(destination)}


def run_mode(driver: webdriver.Safari, mode: str, expected_frames: int) -> dict:
    reverse = mode == "beatpan-reverse"
    Select(driver.find_element(By.ID, "beat-pan")).select_by_value("a" if reverse else "")
    checkbox = driver.find_element(By.ID, "append-reverse")
    if checkbox.is_selected() != reverse:
        checkbox.click()
    driver.find_element(By.ID, "run").click()
    WebDriverWait(driver, 180).until(
        lambda current: current.find_element(By.ID, "status").get_attribute("data-state") in {"done", "error"}
    )
    status_element = driver.find_element(By.ID, "status")
    state_name = status_element.get_attribute("data-state")
    require(state_name == "done", f"Safari/{mode}: app failed: {status_element.text}")
    state = capture_output(driver, f"safari-{mode}.wav")
    require(state["outputFrames"] == expected_frames, f"Safari/{mode}: expected {expected_frames}, got {state['outputFrames']}")
    require(state["wav"]["frames"] == expected_frames, f"Safari/{mode}: WAV frame mismatch")
    require(state["readyState"] >= 2, f"Safari/{mode}: audio not ready")
    require(state["playResult"] == "started", f"Safari/{mode}: {state['playResult']}")
    require(state["href"].startswith("blob:") and state["disabled"] == "false", f"Safari/{mode}: download not enabled")
    require(state["filename"] == "convolved-audio.wav", f"Safari/{mode}: wrong filename")
    require(not state["pageErrors"], f"Safari/{mode}: page errors {state['pageErrors']}")
    if reverse:
        require(state["detectedBeats"] > 0 and state["detectedBpm"], "Safari: missing beat metadata")
    peak = re.search(r"(-?\d+(?:\.\d+)?) dBTP", state["text"])
    require(peak is not None and float(peak.group(1)) <= -0.95, f"Safari/{mode}: unsafe peak {state['text']}")
    return state


def main() -> None:
    driver = webdriver.Safari(options=webdriver.SafariOptions())
    try:
        driver.get(BASE_URL)
        driver.execute_script(
            """
            window.__releaseErrors = [];
            window.addEventListener('error', event => window.__releaseErrors.push(`error: ${event.message}`));
            window.addEventListener('unhandledrejection', event => window.__releaseErrors.push(`rejection: ${event.reason?.message || String(event.reason)}`));
            """
        )
        driver.find_element(By.ID, "audio-a").send_keys(str(FIXTURE_DIR / "fixture.m4a"))
        driver.find_element(By.ID, "audio-b").send_keys(str(FIXTURE_DIR / "impulse.wav"))

        diagnostics = collect_diagnostics(driver)
        (CAPTURE_DIR / "safari-decode-diagnostics.json").write_text(json.dumps(diagnostics, indent=2))
        print(json.dumps(diagnostics, indent=2))

        offline_a = diagnostics["a"]["offline"]
        offline_b = diagnostics["b"]["offline"]
        require(offline_a["state"] == "done", f"Safari HE-AAC offline decode failed: {offline_a}")
        require(offline_b["state"] == "done", f"Safari impulse offline decode failed: {offline_b}")
        decoded = {"a": offline_a["value"], "b": offline_b["value"]}
        require(decoded["a"]["sampleRate"] == 48_000 and decoded["a"]["channels"] == 2, f"Safari HE-AAC shape mismatch {decoded['a']}")
        require(decoded["b"]["sampleRate"] == 48_000 and decoded["b"]["channels"] == 1, f"Safari impulse shape mismatch {decoded['b']}")

        forward_frames = decoded["a"]["frames"] + decoded["b"]["frames"] - 1
        plain = run_mode(driver, "plain", forward_frames)
        reverse = run_mode(driver, "beatpan-reverse", 2 * forward_frames - 240)
        result = {
            "browserName": "Safari",
            "browserVersion": driver.capabilities.get("browserVersion"),
            "platformName": driver.capabilities.get("platformName"),
            "os": f"macOS {platform.mac_ver()[0]}",
            "decoded": decoded,
            "diagnostics": diagnostics,
            "forwardFrames": forward_frames,
            "plain": plain,
            "reverse": reverse,
            "status": "Pass",
        }
        (CAPTURE_DIR / "safari-matrix.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
