from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from realtime_sleep_staging.demo_signal_flags import (
    DemoFlagEvent,
    DemoSignalConfig,
    DemoSignalFlagger,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_ROOT = Path("/Users/ysl/Downloads/EEGSleepBlinkValidationData_v118")
DEFAULT_OUTPUT = ROOT / "validation/adaptive_blink_v118_report.json"
SESSION_IDS = (
    "20260718_161609_fdae23df877c",
    "20260718_184324_72bc63571e39",
    "20260718_190315_aaf378597ca7",
    "20260718_234443_ab3990f6d9f8",
    "20260719_005123_429c8c5ad66d",
    "20260719_015551_c2c0aadfa421",
    "20260719_024805_e8f63cffc6c4",
)


@dataclass(frozen=True)
class Marker:
    start: float
    expected: int


@dataclass
class SessionData:
    session_id: str
    times: np.ndarray
    eeg: np.ndarray
    valid: np.ndarray
    markers: list[Marker]
    logged_results: list[tuple[int, int]]
    metadata: dict[str, object]


def load_events(path: Path) -> list[dict[str, object]]:
    return [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


def load_session(directory: Path) -> SessionData:
    times: list[float] = []
    eeg: list[list[float]] = []
    valid: list[bool] = []
    with (directory / "headband_samples.csv").open(
        newline="", encoding="utf-8-sig"
    ) as handle:
        for row in csv.DictReader(handle):
            times.append(float(row["session_seconds"]))
            eeg.append([float(row[f"eeg{index}"]) for index in range(1, 5)])
            valid.append(int(row["valid"]) != 0)
    events = load_events(directory / "events.jsonl")
    markers = [
        Marker(
            start=float(event["time_seconds"]),
            expected=int(event["payload"]["expected_count"]),
        )
        for event in events
        if event.get("kind") == "blink_test_marker"
    ]
    logged_results = [
        (
            int(event["payload"]["expected_count"]),
            int(event["payload"].get("detected_count") or 0),
        )
        for event in events
        if event.get("kind") == "blink_test_result"
    ]
    metadata = json.loads((directory / "session.json").read_text(encoding="utf-8"))
    return SessionData(
        session_id=directory.name,
        times=np.asarray(times, dtype=np.float64),
        eeg=np.asarray(eeg, dtype=np.float64).T,
        valid=np.asarray(valid, dtype=bool),
        markers=markers,
        logged_results=logged_results,
        metadata=metadata,
    )


def summarize_rows(rows: list[dict[str, object]]) -> dict[str, object]:
    by_class: dict[str, dict[str, object]] = {}
    for expected in (0, 3, 5):
        selected = [row for row in rows if int(row["expected"]) == expected]
        outcomes = Counter(str(int(row["detected"])) for row in selected)
        successes = sum(bool(row["correct"]) for row in selected)
        by_class[str(expected)] = {
            "trials": len(selected),
            "successes": successes,
            "accuracy": successes / len(selected) if selected else None,
            "outcomes": dict(sorted(outcomes.items())),
        }
    successes = sum(bool(row["correct"]) for row in rows)
    return {
        "trials": len(rows),
        "successes": successes,
        "accuracy": successes / len(rows) if rows else None,
        "by_class": by_class,
    }


def summarize_logged(sessions: list[SessionData]) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    per_session: dict[str, dict[str, object]] = {}
    for session in sessions:
        session_rows = [
            {
                "session_id": session.session_id,
                "expected": expected,
                "detected": detected,
                "correct": expected == detected,
            }
            for expected, detected in session.logged_results
        ]
        rows.extend(session_rows)
        per_session[session.session_id] = summarize_rows(session_rows)
    result = summarize_rows(rows)
    result["per_session"] = per_session
    return result


def runtime_group_replay(
    sessions: list[SessionData], config: DemoSignalConfig
) -> tuple[dict[str, object], list[dict[str, object]]]:
    """Replay the exact production group decoder on contiguous raw samples.

    Calibration is injected as complete because the v1.0.18 group decoder uses
    a local median/MAD scale from every already-received eight-second window;
    it deliberately does not consume wearer template amplitudes.  This audit
    isolates command decoding while the app still requires its normal on-head
    calibration safety gate before enabling control.
    """

    rows: list[dict[str, object]] = []
    per_session: dict[str, dict[str, object]] = {}
    for session in sessions:
        flagger = DemoSignalFlagger(config)
        flagger._blink_calibrated = True
        # The production path requires a successful personal-template
        # calibration before command decoding.  The group score does not read
        # the template arrays, so fixed placeholders isolate the exact group
        # decoder without pretending to reconstruct unavailable old templates.
        flagger._blink_pair_templates = {
            pair: np.ones((2, 15), dtype=np.float64)
            for pair in flagger._blink_enabled_pairs
        }
        flagger._blink_interaction_enabled = True
        flagger._blink_detection_resume_sample = 0
        flagger._blink_group_next_update_sample = 0
        decoded: list[tuple[float, int]] = []
        chunk_samples = int(round(0.25 * config.sample_rate_hz))
        for start in range(0, session.eeg.shape[1], chunk_samples):
            stop = min(start + chunk_samples, session.eeg.shape[1])
            emitted: list[DemoFlagEvent] = []
            flagger._detect_blink_groups_retrospective(
                session.eeg[:, start:stop],
                start,
                emitted,
                session.valid[start:stop],
            )
            for event in emitted:
                if event.flag == "BLINK_3":
                    decoded.append((event.time_seconds, 3))
                elif event.flag == "BLINK_5":
                    decoded.append((event.time_seconds, 5))

        session_rows: list[dict[str, object]] = []
        for index, marker in enumerate(session.markers):
            stop_time = min(
                marker.start + 10.0,
                session.markers[index + 1].start
                if index + 1 < len(session.markers)
                else marker.start + 10.0,
            )
            # Match the completed-test audit: incomplete or data-truncated
            # marker windows are not scored.
            if stop_time > float(session.times[-1]) or stop_time - marker.start < 2.0:
                continue
            candidates = [
                count
                for event_time, count in decoded
                if marker.start <= event_time < stop_time
            ]
            detected = candidates[0] if candidates else 0
            row = {
                "session_id": session.session_id,
                "start_seconds": marker.start,
                "expected": marker.expected,
                "detected": detected,
                "correct": detected == marker.expected,
            }
            rows.append(row)
            session_rows.append(row)
        per_session[session.session_id] = summarize_rows(session_rows)
    result = summarize_rows(rows)
    result["per_session"] = per_session
    return result, rows


def baseline_synchronization_audit(latest: SessionData) -> dict[str, object]:
    baseline = latest.metadata["baseline"]
    reference = np.asarray(baseline["blink_reference_scale"], dtype=np.float64)
    final = np.asarray(baseline["blink_scale"], dtype=np.float64)
    ratios = final / np.maximum(reference, 1e-9)
    health_checks = int(baseline["blink_baseline_health_checks"])
    updates = int(baseline["blink_adaptive_updates"])
    return {
        "session_id": latest.session_id,
        "open_eye_alpha_initial_center": float(baseline["initial_center"]),
        "open_eye_alpha_final_center": float(baseline["center"]),
        "open_eye_alpha_updates": int(baseline["adaptive_updates"]),
        "blink_reference_scale": reference.tolist(),
        "blink_final_scale": final.tolist(),
        "blink_final_over_reference_scale": ratios.tolist(),
        "blink_adaptive_updates": updates,
        "blink_baseline_health_checks": health_checks,
        "blink_update_fraction_of_health_checks": (
            updates / health_checks if health_checks else None
        ),
        "maximum_scale_inflation": float(np.max(ratios)),
        "finding": (
            "The open-eye Alpha and blink baselines are stored separately, so "
            "the Alpha updater cannot directly overwrite blink normalization. "
            "The old blink updater changed scale on nearly every health check; "
            "that can give early and late peaks in one 3/5 group different scales."
        ),
        "v1_0_18_control": (
            "Retrospective command decoding uses one local robust scale for the "
            "whole group, while the legacy baseline updater is frozen during "
            "activity and for a quiet guard interval after a command."
        ),
    }


def baseline_freeze_unit(config: DemoSignalConfig) -> dict[str, object]:
    flagger = DemoSignalFlagger(config)
    flagger._blink_calibrated = True
    flagger._blink_interaction_enabled = True
    flagger._blink_detection_resume_sample = 0
    flagger._blink_center[:] = 0.0
    flagger._blink_scale[:] = 1.0
    before_update = flagger._blink_adaptive_last_update_sample
    emitted: list[DemoFlagEvent] = []
    blink_activity = np.zeros((4, config.sample_rate_hz), dtype=np.float64)
    blink_activity[:, 40:48] = 5.0
    flagger._detect_blinks(
        blink_activity,
        0,
        emitted,
        np.ones(config.sample_rate_hz, dtype=bool),
    )
    frozen_until = flagger._blink_baseline_frozen_until_sample
    return {
        "baseline_update_sample_before": before_update,
        "baseline_update_sample_after": flagger._blink_adaptive_last_update_sample,
        "frozen_until_sample": frozen_until,
        "activity_chunk_end_sample": config.sample_rate_hz,
        "baseline_update_blocked_during_activity": (
            flagger._blink_adaptive_last_update_sample == before_update
        ),
        "freeze_extends_beyond_activity": frozen_until > config.sample_rate_hz,
    }


def command_safety_gate_unit(
    session: SessionData, config: DemoSignalConfig
) -> dict[str, object]:
    """Prove missing personal templates and stale baselines cannot act."""

    results: dict[str, int] = {}
    for name, template_ready, baseline_stale in (
        ("missing_template", False, False),
        ("stale_baseline", True, True),
    ):
        flagger = DemoSignalFlagger(config)
        flagger._blink_calibrated = True
        flagger._blink_interaction_enabled = True
        flagger._blink_detection_resume_sample = 0
        flagger._blink_group_next_update_sample = 0
        flagger._blink_baseline_stale = baseline_stale
        if template_ready:
            flagger._blink_pair_templates = {
                pair: np.ones((2, 15), dtype=np.float64)
                for pair in flagger._blink_enabled_pairs
            }
        commands = 0
        for start in range(0, session.eeg.shape[1], 25):
            stop = min(start + 25, session.eeg.shape[1])
            emitted: list[DemoFlagEvent] = []
            flagger._detect_blink_groups_retrospective(
                session.eeg[:, start:stop],
                start,
                emitted,
                session.valid[start:stop],
            )
            commands += sum(
                event.flag in {"BLINK_3", "BLINK_5"} for event in emitted
            )
        results[name] = commands
    return results


def calibrated_synthetic_commands(config: DemoSignalConfig) -> dict[str, object]:
    """Exercise calibration, template gate, valid commands and one-channel noise."""

    rng = np.random.default_rng(118)
    values = rng.normal(0.0, 45.0, (4, 4200))
    seconds = np.arange(values.shape[1], dtype=np.float64) / config.sample_rate_hz

    def add_blinks(
        blink_times: list[float] | np.ndarray,
        *,
        amplitude: float = 1800.0,
        dual_channel: bool = True,
    ) -> None:
        for blink_time in blink_times:
            pulse = -amplitude * np.exp(
                -0.5 * np.square((seconds - blink_time) / 0.075)
            )
            pulse += 0.35 * amplitude * np.exp(
                -0.5 * np.square((seconds - (blink_time + 0.16)) / 0.10)
            )
            values[0] += pulse
            if dual_channel:
                values[1] += 0.82 * pulse

    add_blinks(np.arange(3.5, 12.6, 0.75))
    add_blinks([20.0, 20.55, 21.10])
    add_blinks([27.0, 27.5, 28.0, 28.5, 29.0])
    add_blinks(
        [35.0, 35.5, 36.0, 36.5, 37.0],
        amplitude=4000.0,
        dual_channel=False,
    )
    flagger = DemoSignalFlagger(config)
    flagger.set_blink_interaction_enabled(True)
    flagger.begin_blink_calibration()
    commands: list[tuple[str, float]] = []
    for start in range(0, values.shape[1], 10):
        stop = min(start + 10, values.shape[1])
        output = flagger.stream_step(
            values[:, start:stop],
            np.zeros((3, stop - start), dtype=np.float64),
            np.ones(stop - start, dtype=bool),
        )
        commands.extend(
            (event.flag, float(event.time_seconds))
            for event in output.events
            if event.flag in {"BLINK_3", "BLINK_5"}
        )
    return {
        "template_ready": flagger.blink_template_ready,
        "commands": [[flag, time_seconds] for flag, time_seconds in commands],
        "three_blink_commands": sum(flag == "BLINK_3" for flag, _ in commands),
        "five_blink_commands": sum(flag == "BLINK_5" for flag, _ in commands),
        "single_channel_artifact_commands": sum(
            time_seconds >= 35.0 for _, time_seconds in commands
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=DEFAULT_DATA_ROOT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    missing = [
        session_id
        for session_id in SESSION_IDS
        if not (args.data_root / session_id / "headband_samples.csv").is_file()
    ]
    if missing:
        raise FileNotFoundError(
            f"missing hydrated validation sessions under {args.data_root}: {missing}"
        )

    sessions = [load_session(args.data_root / session_id) for session_id in SESSION_IDS]
    config = DemoSignalConfig(blink_group_weak_fourth_tail_ratio=0.0)
    logged = summarize_logged(sessions)
    runtime, rows = runtime_group_replay(sessions, config)
    latest_id = SESSION_IDS[-1]
    latest_runtime = runtime["per_session"][latest_id]
    latest_logged = logged["per_session"][latest_id]
    sync = baseline_synchronization_audit(sessions[-1])
    freeze = baseline_freeze_unit(config)
    safety_gate = command_safety_gate_unit(sessions[-1], config)
    synthetic = calibrated_synthetic_commands(config)
    misses = [row for row in rows if not bool(row["correct"])]
    report = {
        "schema_version": "adaptive-blink-validation/v1",
        "version": "1.0.18",
        "data_root": str(args.data_root),
        "sessions": list(SESSION_IDS),
        "production_decoder": {
            "filter_hz": [config.blink_filter_low_hz, config.blink_filter_high_hz],
            "filter_order": config.blink_filter_order,
            "normalization": "per-window per-channel median and MAD",
            "four_channel_fusion": "median of standardized EEG1-EEG4 responses",
            "peak_height_robust_z": config.blink_group_peak_height_z,
            "peak_prominence_robust_z": config.blink_group_peak_prominence_z,
            "peak_minimum_distance_seconds": config.blink_group_peak_distance_seconds,
            "maximum_interblink_gap_seconds": config.blink_group_maximum_interval_seconds,
            "decision_delay_seconds": [
                config.blink_group_end_age_min_seconds,
                config.blink_group_end_age_max_seconds,
            ],
            "four_peak_fast_group_as_five_span_seconds": (
                config.blink_group_four_as_five_span_seconds
            ),
            "maximum_peaks_before_artifact_rejection": (
                config.blink_group_maximum_peaks
            ),
        },
        "historical_logged_app": logged,
        "v1_0_18_exact_runtime_group_decoder": runtime,
        "latest_session_comparison": {
            "session_id": latest_id,
            "logged_successes": latest_logged["successes"],
            "logged_trials": latest_logged["trials"],
            "runtime_successes": latest_runtime["successes"],
            "runtime_trials": latest_runtime["trials"],
        },
        "runtime_misses": misses,
        "baseline_synchronization_audit": sync,
        "baseline_freeze_unit": freeze,
        "command_safety_gate_unit": safety_gate,
        "calibrated_synthetic_commands": synthetic,
        "assertions": {
            "authoritative_completed_markers_136": runtime["trials"] == 136,
            "exact_runtime_accuracy_at_least_90_percent": runtime["accuracy"] >= 0.90,
            "exact_runtime_successes_125_of_136": (
                runtime["successes"] == 125 and runtime["trials"] == 136
            ),
            "historical_logged_successes_56_of_136": (
                logged["successes"] == 56 and logged["trials"] == 136
            ),
            "zero_command_specificity_11_of_12": (
                runtime["by_class"]["0"]["successes"] == 11
                and runtime["by_class"]["0"]["trials"] == 12
            ),
            "latest_session_improved_6_to_16_of_17": (
                latest_logged["successes"] == 6
                and latest_logged["trials"] == 17
                and latest_runtime["successes"] == 16
                and latest_runtime["trials"] == 17
            ),
            "baseline_update_was_nearly_continuous": (
                sync["blink_adaptive_updates"] == 62
                and sync["blink_baseline_health_checks"] == 64
            ),
            "baseline_scale_inflation_exceeded_40_percent": (
                sync["maximum_scale_inflation"] > 1.40
            ),
            "baseline_update_frozen_during_group_activity": (
                freeze["baseline_update_blocked_during_activity"]
                and freeze["freeze_extends_beyond_activity"]
            ),
            "missing_personal_template_cannot_trigger_commands": (
                safety_gate["missing_template"] == 0
            ),
            "stale_blink_baseline_cannot_trigger_commands": (
                safety_gate["stale_baseline"] == 0
            ),
            "fresh_calibration_builds_personal_templates": synthetic[
                "template_ready"
            ],
            "calibrated_three_and_five_commands_preserved": (
                synthetic["three_blink_commands"] == 1
                and synthetic["five_blink_commands"] == 1
            ),
            "single_channel_artifact_still_rejected": (
                synthetic["single_channel_artifact_commands"] == 0
            ),
        },
        "limitations": [
            "All seven marked sessions are from one wearer; session and environment drift are represented, but cross-person generalization has not been independently demonstrated.",
            "The same marked sessions were used to select the bounded decoder parameters, so 91.9% is a development-set replay result rather than a prospective clinical performance claim.",
            "The runtime replay calls the exact production command-decoder method but injects the calibration-complete gate; the distributed app still requires a fresh on-head blink calibration.",
            "A prospective acceptance run should collect at least 20 new zero-, three-, and five-blink trials per wearer across multiple wearers and motion/noise conditions.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    assert all(report["assertions"].values()), report["assertions"]


if __name__ == "__main__":
    main()
