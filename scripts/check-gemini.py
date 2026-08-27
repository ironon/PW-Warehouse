"""Standalone check of the Gemini setup, independent of the web app.

Reads VITE_GEMINI_API_KEY / VITE_GEMINI_MODEL / VITE_GEMINI_PLANNING_MODEL from
.env.local and makes the same three kinds of request the app makes, reporting
the raw HTTP status and error body for each. Stdlib only - no venv, no pip:

    python scripts/check-gemini.py

If every check passes here but the app still fails, the problem is in the app
(or the browser: look for a CORS or network error in the devtools console).
If the checks fail here, the problem is the key, the model name, or the API
not being enabled on the project - and the error body says which.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(ROOT, ".env.local")
BASE = "https://generativelanguage.googleapis.com/v1beta"

# 1x1 white JPEG, so the vision path is exercised without needing a photo.
TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    if not os.path.exists(ENV_PATH):
        print(f"!! No .env.local at {ENV_PATH}")
        return env
    with open(ENV_PATH, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def post(path: str, api_key: str, payload: dict) -> tuple[int, dict | str]:
    """Returns (status, parsed-body-or-text). Never raises on an HTTP error."""
    req = urllib.request.Request(
        f"{BASE}/{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, body
    except Exception as exc:  # network, DNS, TLS
        return 0, f"{type(exc).__name__}: {exc}"


def get(path: str, api_key: str) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        f"{BASE}/{path}", headers={"x-goog-api-key": api_key}, method="GET"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, body
    except Exception as exc:
        return 0, f"{type(exc).__name__}: {exc}"


def explain(status: int, body) -> str:
    if isinstance(body, dict):
        err = body.get("error", {})
        msg = err.get("message", "")
        reason = ""
        for detail in err.get("details", []) or []:
            if "reason" in detail:
                reason = detail["reason"]
        return f"HTTP {status}{f' [{reason}]' if reason else ''}: {msg or json.dumps(body)[:400]}"
    return f"HTTP {status}: {str(body)[:400]}"


def diagnose(status: int, body) -> list[str]:
    """Turns an API error into the thing you actually have to go and do."""
    msg = ""
    if isinstance(body, dict):
        msg = body.get("error", {}).get("message", "")
    low = msg.lower()

    if status == 429 and "credit" in low:
        return [
            "-> THE KEY IS FINE. The project behind it has no credits left.",
            "   Top it up at https://ai.studio/projects (Billing), or point the key",
            "   at a project with free-tier quota. No code change can work around",
            "   this - every model will keep answering 429.",
        ]
    if status == 429:
        return ["-> Rate limited. Wait a minute and re-run, or use a smaller model."]
    if status == 404 and "no longer available" in low:
        rec = ""
        if "use models/" in msg:
            rec = msg.split("use models/")[-1].split()[0].strip(".")
        return [
            "-> This MODEL NAME is retired for a key as new as yours.",
            f"   The API suggests: {rec or '(see the message above)'}",
            "   Set VITE_GEMINI_MODEL / VITE_GEMINI_PLANNING_MODEL in .env.local and",
            "   rebuild. Careful: step 1 still lists retired models, so appearing",
            "   there does NOT mean a model is usable.",
        ]
    if status == 404:
        return ["-> No such model for this key. Pick one from the step 1 listing."]
    if status in (401, 403):
        return [
            "-> The KEY is being rejected: either it is wrong, or the Generative",
            "   Language API is not enabled on its project.",
            "   Make a fresh one at https://aistudio.google.com/apikey",
        ]
    if status == 400 and "schema" in low:
        return ["-> The request was malformed. That is an app bug, not your key."]
    if status == 0:
        return ["-> Could not reach Google at all: network, DNS, proxy or TLS."]
    return []


def report(status: int, body) -> None:
    print(f"FAILED - {explain(status, body)}")
    for line in diagnose(status, body):
        print(f"   {line}")


def text_of(body: dict) -> str:
    try:
        parts = body["candidates"][0]["content"]["parts"]
        return "".join(p.get("text", "") for p in parts)
    except (KeyError, IndexError, TypeError):
        return ""


def stop_info(body: dict) -> str:
    """finishReason and token counts - the two things that explain a reply that
    arrived as broken JSON."""
    try:
        reason = body["candidates"][0].get("finishReason", "?")
    except (KeyError, IndexError, TypeError):
        reason = "?"
    usage = body.get("usageMetadata") or {}
    return (
        f"finishReason={reason} "
        f"prompt={usage.get('promptTokenCount', '?')} "
        f"output={usage.get('candidatesTokenCount', '?')} "
        f"thoughts={usage.get('thoughtsTokenCount', '?')}"
    )


def check_json(raw: str, body: dict, label: str) -> bool:
    """Reports whether a structured-output reply actually parsed, and why not."""
    print(f"   {stop_info(body)}")
    try:
        json.loads(raw)
        print(f"OK - valid JSON returned: {raw.strip()[:120]}")
        return True
    except json.JSONDecodeError as exc:
        print(f"FAILED - {label} was not valid JSON: {exc}")
        print(f"   last 200 characters received: {raw[-200:]!r}")
        try:
            reason = body["candidates"][0].get("finishReason")
        except (KeyError, IndexError, TypeError):
            reason = None
        if reason == "MAX_TOKENS":
            print("   -> CUT OFF at the output limit. Thinking tokens share the answer's")
            print("      budget, so the reply stopped partway and has no ending. Raise")
            print("      VITE_GEMINI_SCAN_MAX_TOKENS / VITE_GEMINI_PLANNING_MAX_TOKENS, or")
            print("      set VITE_GEMINI_THINKING_LEVEL=low. This is not a parser bug.")
        return False


def main() -> int:
    env = load_env()
    api_key = os.environ.get("VITE_GEMINI_API_KEY") or env.get("VITE_GEMINI_API_KEY", "")
    scan_model = env.get("VITE_GEMINI_MODEL") or "gemini-3.6-flash"
    plan_model = env.get("VITE_GEMINI_PLANNING_MODEL") or "gemini-3.6-flash"

    print("=" * 72)
    print("PW-Warehouse Gemini check")
    print("=" * 72)

    if not api_key:
        print("!! VITE_GEMINI_API_KEY is empty in .env.local. Nothing to test.")
        return 1

    print(f"Key       : {api_key[:6]}... ({len(api_key)} chars)")
    print(f"Scan model: {scan_model}")
    print(f"Plan model: {plan_model}")

    # Deliberately no guess about whether the key "looks right": AI Studio
    # issues both "AIzaSy..." and newer "AQ.Ab8..." keys, and both work. Step 1
    # answers the question properly instead of pattern-matching the string.

    failures = 0

    # --- 1. Which models does this key actually have? ---------------------
    print()
    print("-" * 72)
    print("1. Listing models available to this key")
    print("-" * 72)
    status, body = get("models", api_key)
    if status == 200 and isinstance(body, dict):
        names = [
            m["name"].removeprefix("models/")
            for m in body.get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])
        ]
        print(f"OK - {len(names)} models support generateContent.")
        for n in sorted(names):
            if "gemini" in n and ("2.5" in n or "3" in n):
                print(f"   {n}")
        # Listed does not mean usable: retired models keep appearing here but
        # answer 404 on generateContent. Only steps 2-4 prove one works.
        for label, model in (("scan", scan_model), ("planning", plan_model)):
            if model not in names:
                failures += 1
                print(f"   [NOT LISTED] {label} model '{model}' - check the spelling")
        print("   (Appearing in this list does NOT prove a model is usable.)")
    else:
        failures += 1
        report(status, body)
        print("   This alone explains everything else failing.")

    # --- 2. Plain text generation (cheapest real call) --------------------
    print()
    print("-" * 72)
    print(f"2. Plain generateContent on '{scan_model}'")
    print("-" * 72)
    status, body = post(
        f"models/{scan_model}:generateContent",
        api_key,
        {"contents": [{"parts": [{"text": "Reply with exactly: PONG"}]}]},
    )
    if status == 200 and isinstance(body, dict):
        print(f"OK - model replied: {text_of(body).strip()[:100]!r}")
        print(f"   {stop_info(body)}")
    else:
        failures += 1
        report(status, body)

    # --- 3. Structured JSON output, as the Scan tab uses ------------------
    print()
    print("-" * 72)
    print(f"3. Structured output + image on '{scan_model}'  (what Scan Shelf does)")
    print("-" * 72)
    status, body = post(
        f"models/{scan_model}:generateContent",
        api_key,
        {
            "contents": [
                {
                    "parts": [
                        {"text": "Return boxes as an empty array and notes 'test'."},
                        {"inline_data": {"mime_type": "image/jpeg", "data": TINY_JPEG_B64}},
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "boxes": {"type": "array", "items": {"type": "string"}},
                        "notes": {"type": "string"},
                    },
                    "required": ["boxes"],
                },
                "temperature": 0,
                "maxOutputTokens": 8192,
            },
        },
    )
    if status == 200 and isinstance(body, dict):
        if not check_json(text_of(body), body, "the scan response"):
            failures += 1
    else:
        failures += 1
        report(status, body)

    # --- 4. systemInstruction + enum schema, as AI Work uses --------------
    print()
    print("-" * 72)
    print(f"4. systemInstruction + enum schema on '{plan_model}'  (what AI Work does)")
    print("-" * 72)
    status, body = post(
        f"models/{plan_model}:generateContent",
        api_key,
        {
            "systemInstruction": {
                "parts": [{"text": "You are a warehouse assistant. Always fill in 'reply'."}]
            },
            "contents": [{"role": "user", "parts": [{"text": "Say hello, propose nothing."}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "reply": {"type": "string"},
                        "planSummary": {"type": "string"},
                        "operations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "op": {
                                        "type": "string",
                                        "enum": ["container.move", "container.swap"],
                                    },
                                    "reason": {"type": "string"},
                                },
                                "required": ["op", "reason"],
                            },
                        },
                    },
                    "required": ["reply"],
                },
                "temperature": 0.2,
                "maxOutputTokens": 16384,
            },
        },
    )
    if status == 200 and isinstance(body, dict):
        if not check_json(text_of(body), body, "the plan response"):
            failures += 1
    else:
        failures += 1
        report(status, body)

    print()
    print("=" * 72)
    if failures == 0:
        print("All checks passed. The key and both models work.")
        print("If the app still fails, the problem is in the browser, not the key:")
        print("  - open devtools (F12) -> Console and Network, reproduce, read the error")
        print("  - .env.local is read at BUILD time, so run 'npm run build' and redeploy")
        print("    (or restart 'npm run dev') after changing the key")
    else:
        print(f"{failures} check(s) failed - see the errors above.")
    print("=" * 72)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
