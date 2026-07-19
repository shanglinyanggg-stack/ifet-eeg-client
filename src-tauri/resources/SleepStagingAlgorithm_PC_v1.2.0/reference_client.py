from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent


def request(base_url: str, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = json.dumps(payload, allow_nan=False).encode("utf-8")
    message = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(message, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def close(left: Any, right: Any, tolerance: float = 5e-5) -> bool:
    if isinstance(right, list):
        return len(left) == len(right) and all(
            close(a, b, tolerance) for a, b in zip(left, right, strict=True)
        )
    if isinstance(right, float):
        return math.isclose(float(left), right, rel_tol=tolerance, abs_tol=tolerance)
    return left == right


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify the sleep-staging service")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    vector = json.loads(
        (ROOT / "test_vectors/synthetic_30s.json").read_text(encoding="utf-8")
    )
    request(args.url, "/reset", {"session_id": vector["session_id"]})
    responses = [request(args.url, "/step", item) for item in vector["requests"]]
    final = responses[-1]
    failures = {
        key: {"actual": final.get(key), "expected": expected}
        for key, expected in vector["expected_final"].items()
        if not close(final.get(key), expected)
    }
    timing_ok = [item.get("end_seconds") for item in responses] == [5, 10, 15, 20, 25, 30]
    warmup_ok = all(not item.get("decision_valid") for item in responses[:5])
    if failures or not timing_ok or not warmup_ok:
        raise SystemExit(
            json.dumps(
                {"passed": False, "failures": failures, "timing_ok": timing_ok, "warmup_ok": warmup_ok},
                ensure_ascii=False,
                indent=2,
            )
        )
    print(
        json.dumps(
            {
                "passed": True,
                "first_valid_decision_seconds": 30,
                "selected_stage": final["selected_stage"],
                "selected_sleep_probability": final["selected_sleep_probability"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
