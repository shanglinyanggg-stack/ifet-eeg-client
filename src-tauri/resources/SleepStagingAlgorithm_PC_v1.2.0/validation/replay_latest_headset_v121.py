from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

import numpy as np


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
for candidate in (PACKAGE_ROOT / "src", PACKAGE_ROOT / "sdk"):
    if candidate.is_dir():
        sys.path.insert(0, str(candidate))

from realtime_sleep_staging.demo_signal_flags import (  # noqa: E402
    DemoSignalConfig,
    DemoSignalFlagger,
)


DEFAULT_SESSION_IDS = (
    "20260719_120655_0b4d6227fc9a",
    "20260719_121714_65415d4f967c",
    "20260719_121724_30abb5cb51e8",
)


def load_session(directory: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict, list[tuple[float, int]]]:
    with (directory / "headband_samples.csv").open(
        newline="", encoding="utf-8-sig"
    ) as handle:
        rows = list(csv.DictReader(handle))
    eeg = np.asarray(
        [[float(row[f"eeg{channel}"]) for row in rows] for channel in range(1, 5)],
        dtype=np.float64,
    )
    imu = np.asarray(
        [[float(row[name]) for row in rows] for name in ("accX", "accY", "accZ")],
        dtype=np.float64,
    )
    valid = np.asarray([int(row["valid"]) != 0 for row in rows], dtype=bool)
    metadata = json.loads((directory / "session.json").read_text(encoding="utf-8"))
    events = [
        json.loads(line)
        for line in (directory / "events.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    markers = [
        (float(event["time_seconds"]), int(event["payload"]["expected_count"]))
        for event in events
        if event.get("kind") == "blink_test_marker"
    ]
    return eeg, imu, valid, metadata["baseline"], markers


def restore_profile(flagger: DemoSignalFlagger, profile: dict) -> None:
    flagger._blink_center[:] = np.asarray(profile["blink_center"], dtype=np.float64)
    flagger._blink_reference_center[:] = flagger._blink_center
    flagger._blink_scale[:] = np.asarray(profile["blink_scale"], dtype=np.float64)
    flagger._blink_reference_scale[:] = np.asarray(
        profile["blink_reference_scale"], dtype=np.float64
    )
    flagger._blink_threshold_z = float(profile["blink_threshold_robust_z"])
    flagger._blink_rearm_z = float(profile["blink_rearm_robust_z"])
    flagger._gesture_min_peak_z = float(profile["blink_gesture_min_peak_robust_z"])
    flagger._blink_calibration_strength_z = float(profile["blink_strength_z"])
    flagger._blink_calibration_width_seconds = float(profile["blink_width_seconds"])
    flagger._blink_calibration_interval_seconds = float(profile["blink_interval_seconds"])
    flagger._blink_calibration_polarity = int(profile["blink_polarity"])
    flagger._blink_calibration_consensus = float(profile["blink_consensus"])
    flagger._blink_motion_std_threshold = float(profile["blink_motion_std_threshold"])
    flagger._blink_enabled_pairs = tuple(
        tuple(int(channel) - 1 for channel in pair)
        for pair in profile["blink_enabled_channel_pairs"]
    )
    flagger._blink_pair_templates = {
        tuple(int(channel) - 1 for channel in name.split("+")): np.asarray(
            template, dtype=np.float64
        )
        for name, template in profile["blink_waveform_templates"].items()
    }
    flagger._blink_calibrated = True
    flagger._blink_calibration_active = False
    flagger._blink_detection_resume_sample = 0
    flagger._blink_baseline_frozen_until_sample = 0
    flagger._blink_group_next_update_sample = 0
    flagger._blink_group_trial_floor_sample = 0
    flagger.set_blink_interaction_enabled(True)


def replay_session(directory: Path, extension_height: float) -> tuple[list[dict], dict]:
    eeg, imu, valid, profile, markers = load_session(directory)
    config = replace(
        DemoSignalConfig(),
        adaptive_blink_baseline=False,
        blink_group_template_peak_height_z=extension_height,
    )
    flagger = DemoSignalFlagger(config)
    restore_profile(flagger, profile)
    marker_index = 0
    active: dict | None = None
    trials: list[dict] = []
    for start in range(0, eeg.shape[1], 10):
        now = start / config.sample_rate_hz
        while marker_index < len(markers) and markers[marker_index][0] <= now + 0.10:
            if active is not None:
                active["detected"] = 0
                active["correct"] = active["expected"] == 0
                trials.append(active)
            marker_time, expected = markers[marker_index]
            flagger.reset_blink_gesture_state(clear_cooldown=True)
            active = {
                "session_id": directory.name,
                "time_seconds": marker_time,
                "expected": expected,
                "detected": None,
                "correct": False,
            }
            marker_index += 1
        stop = min(start + 10, eeg.shape[1])
        output = flagger.stream_step(
            eeg[:, start:stop], imu[:, start:stop], valid[start:stop]
        )
        if active is None:
            continue
        flags = set(output.flags)
        detected = 5 if "BLINK_5" in flags else 3 if "BLINK_3" in flags else None
        if detected is None and now < active["time_seconds"] + 10.0:
            continue
        active["detected"] = 0 if detected is None else detected
        active["correct"] = active["detected"] == active["expected"]
        trials.append(active)
        active = None
        flagger.reset_blink_gesture_state(clear_cooldown=True)
    return trials, {
        "group_commands": flagger._blink_group_commands,
        "group_rejections": flagger._blink_group_rejections,
        "template_matches": flagger._blink_template_matches,
        "template_rejections": flagger._blink_template_rejections,
    }


def summarize(trials: list[dict]) -> dict:
    by_class = {}
    for expected in (0, 3, 5):
        selected = [trial for trial in trials if trial["expected"] == expected]
        successes = sum(bool(trial["correct"]) for trial in selected)
        by_class[str(expected)] = {
            "trials": len(selected),
            "successes": successes,
            "accuracy": successes / len(selected) if selected else None,
            "outcomes": dict(
                sorted(Counter(str(trial["detected"]) for trial in selected).items())
            ),
        }
    successes = sum(bool(trial["correct"]) for trial in trials)
    return {
        "trials": len(trials),
        "successes": successes,
        "accuracy": successes / len(trials) if trials else None,
        "by_class": by_class,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay v1.0.21 on labelled headset sessions")
    parser.add_argument(
        "--sessions-root",
        type=Path,
        default=Path("/Users/ysl/Documents/EEGSleepUpper/Sessions"),
    )
    parser.add_argument("--session-id", action="append", dest="session_ids")
    parser.add_argument(
        "--extension-height",
        action="append",
        type=float,
        dest="extension_heights",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    session_ids = tuple(args.session_ids or DEFAULT_SESSION_IDS)
    extension_heights = tuple(args.extension_heights or (2.5, 2.25, 2.0, 1.8, 1.6, 1.4))
    variants = []
    for height in extension_heights:
        all_trials: list[dict] = []
        diagnostics = {}
        for session_id in session_ids:
            trials, session_diagnostics = replay_session(
                args.sessions_root / session_id, height
            )
            all_trials.extend(trials)
            diagnostics[session_id] = session_diagnostics
        variants.append(
            {
                "template_extension_peak_height_z": height,
                "metrics": summarize(all_trials),
                "diagnostics": diagnostics,
                "trials": all_trials,
            }
        )
    report = {
        "schema_version": "latest-headset-replay/v1",
        "algorithm_version": "1.0.21",
        "sessions": list(session_ids),
        "variants": variants,
        "limitations": [
            "The final saved calibration profile is restored at sample zero; intermediate baseline evolution is not reconstructable.",
            "This is a deterministic development replay of one wearer, not a prospective independent validation.",
        ],
    }
    text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
