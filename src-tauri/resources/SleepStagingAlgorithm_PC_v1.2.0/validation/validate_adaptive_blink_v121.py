from __future__ import annotations

import json
import os
from dataclasses import replace
from pathlib import Path

import numpy as np

from realtime_sleep_staging.demo_signal_flags import (
    DemoFlagEvent,
    DemoSignalConfig,
    DemoSignalFlagger,
)
from validate_adaptive_blink_v118 import (
    SESSION_IDS,
    load_session,
    runtime_group_replay,
)


ROOT = Path(__file__).resolve().parents[1]
DATA_ROOT = Path(
    os.environ.get(
        "IFET_BLINK_VALIDATION_DATA",
        "/Users/ysl/Downloads/EEGSleepBlinkValidationData_v118",
    )
)
OUTPUT = ROOT / "validation/adaptive_blink_v121_report.json"


def historical_regression() -> dict[str, object]:
    """Keep the frozen v1.0.20 decoder result while all pairs are healthy."""

    if not all((DATA_ROOT / session_id).is_dir() for session_id in SESSION_IDS):
        frozen = json.loads(OUTPUT.read_text(encoding="utf-8"))
        return frozen["historical_development_replay"]
    sessions = [load_session(DATA_ROOT / session_id) for session_id in SESSION_IDS]
    config = replace(
        DemoSignalConfig(),
        # The historical isolated group replay predates stored causal template
        # matches. The v1.0.21 template gate is covered by streaming tests.
        blink_group_template_gate_enabled=False,
    )
    metrics, _ = runtime_group_replay(sessions, config)
    return metrics


def synthetic_commands() -> dict[str, object]:
    rng = np.random.default_rng(121)
    config = DemoSignalConfig()
    values = rng.normal(0.0, 45.0, (4, 5_000))
    seconds = np.arange(values.shape[1], dtype=np.float64) / config.sample_rate_hz

    def add_primary_blinks(times: list[float], amplitude: float = 1_800.0) -> None:
        for blink_time in times:
            pulse = -amplitude * np.exp(
                -0.5 * np.square((seconds - blink_time) / 0.075)
            )
            pulse += 0.35 * amplitude * np.exp(
                -0.5 * np.square((seconds - blink_time - 0.16) / 0.10)
            )
            values[0] += pulse
            values[1] += 0.82 * pulse

    # Calibration, one valid 3-command and one valid 5-command.
    add_primary_blinks(list(np.arange(3.5, 12.6, 0.75)))
    add_primary_blinks([20.0, 20.55, 21.10])
    add_primary_blinks([27.0, 27.5, 28.0, 28.5, 29.0])
    # Repeated paired EEG3/4 contact artifacts have no EEG1/2 support and must
    # never become a volume command even though they form a five-pulse rhythm.
    for artifact_time in (38.0, 38.5, 39.0, 39.5, 40.0):
        artifact = 5_000.0 * np.exp(
            -0.5 * np.square((seconds - artifact_time) / 0.06)
        )
        values[2] += artifact
        values[3] += 0.9 * artifact

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
        "commands": [[flag, round(time_seconds, 3)] for flag, time_seconds in commands],
        "three_blink_commands": sum(flag == "BLINK_3" for flag, _ in commands),
        "five_blink_commands": sum(flag == "BLINK_5" for flag, _ in commands),
        "auxiliary_artifact_commands": sum(time_seconds >= 38.0 for _, time_seconds in commands),
    }


def auxiliary_isolation() -> dict[str, object]:
    flagger = DemoSignalFlagger()
    primary = flagger.config.blink_primary_pair
    auxiliary = flagger.config.blink_auxiliary_pair
    flagger._blink_calibrated = True
    flagger._blink_enabled_pairs = (primary, auxiliary)
    flagger._blink_pair_templates = {
        primary: np.ones((2, 15), dtype=np.float64),
        auxiliary: np.ones((2, 15), dtype=np.float64),
    }
    events: list[DemoFlagEvent] = []
    for burst in range(flagger.config.blink_burst_rejections_before_pair_disable):
        start = burst * 10.0
        for index in range(6):
            flagger._register_blink(
                start + index * 0.40,
                1,
                6.0,
                0.10,
                auxiliary,
                True,
                events,
            )
        flagger._gesture_cooldown_until = -1e12
    return {
        "auxiliary_disabled": auxiliary in flagger._blink_runtime_disabled_pairs,
        "primary_active": primary not in flagger._blink_runtime_disabled_pairs,
        "baseline_stale": flagger._blink_baseline_stale,
        "burst_safety_latched": flagger._blink_burst_safety_latched,
        "flags": [event.flag for event in events],
    }


def fast_recovery() -> dict[str, object]:
    config = replace(
        DemoSignalConfig(),
        blink_eeg_channels=(0, 1),
        blink_channel_pairs=((0, 1),),
        blink_adaptive_memory_seconds=4.0,
        blink_adaptive_minimum_seconds=1.0,
    )
    flagger = DemoSignalFlagger(config)
    pair = config.blink_primary_pair
    flagger._blink_calibrated = True
    flagger._blink_enabled_pairs = (pair,)
    flagger._blink_pair_templates[pair] = np.ones((2, 15), dtype=np.float64)
    flagger._blink_reference_scale[:] = 1.0
    flagger._blink_scale[:] = 2.0
    flagger._blink_runtime_disabled_pairs.add(pair)
    flagger._blink_burst_safety_latched = True
    flagger._blink_baseline_stale = True
    flagger._blink_detection_resume_sample = 0
    flagger._blink_interaction_enabled = True
    flagger._blink_recent_template_peak_samples[pair].extend((50, 90))

    rng = np.random.default_rng(122)
    events: list[DemoFlagEvent] = []
    recovered_at: int | None = None
    for check in range(1, 7):
        blink = rng.normal(0.0, 1.0, (4, config.sample_rate_hz))
        standardized = np.abs(blink / flagger._blink_scale[:, None])
        flagger._update_blink_adaptive_baseline(
            blink,
            standardized,
            np.ones(config.sample_rate_hz, dtype=bool),
            check * config.sample_rate_hz,
            events,
        )
        if not flagger._blink_baseline_stale and recovered_at is None:
            recovered_at = check
    return {
        "recovered_at_seconds": recovered_at,
        "baseline_stale": flagger._blink_baseline_stale,
        "interaction_enabled": flagger.blink_interaction_enabled,
        "scale_after": float(flagger._blink_scale[0]),
        "flags": [event.flag for event in events],
    }


def main() -> None:
    historical = historical_regression()
    synthetic = synthetic_commands()
    isolation = auxiliary_isolation()
    recovery = fast_recovery()
    assertions = {
        "historical_126_of_136_preserved": (
            historical["successes"] == 126 and historical["trials"] == 136
        ),
        "historical_every_class_at_least_90_percent": all(
            historical["by_class"][name]["accuracy"] >= 0.90
            for name in ("0", "3", "5")
        ),
        "synthetic_three_and_five_detected": (
            synthetic["three_blink_commands"] == 1
            and synthetic["five_blink_commands"] == 1
        ),
        "paired_auxiliary_artifacts_rejected": synthetic["auxiliary_artifact_commands"] == 0,
        "noisy_auxiliary_isolated_without_primary_pause": (
            isolation["auxiliary_disabled"]
            and isolation["primary_active"]
            and not isolation["baseline_stale"]
            and not isolation["burst_safety_latched"]
        ),
        "primary_fast_recovery_within_three_seconds": (
            recovery["recovered_at_seconds"] is not None
            and recovery["recovered_at_seconds"] <= 3
            and not recovery["baseline_stale"]
        ),
    }
    report = {
        "schema_version": "adaptive-blink-validation/v3",
        "algorithm_version": "1.0.21",
        "rule": {
            "healthy_fusion": "median of local-MAD standardized EEG1-EEG4",
            "poor_auxiliary_fusion": "EEG1+EEG2 primary; EEG3+EEG4 requires simultaneous EEG1/2 support",
            "poor_auxiliary_gate": {
                "absolute_scale_over_reference": DemoSignalConfig().blink_group_auxiliary_noise_ratio_max,
                "relative_to_primary": DemoSignalConfig().blink_group_auxiliary_relative_noise_ratio,
            },
            "template_support_fraction": DemoSignalConfig().blink_group_template_support_fraction,
            "ordinary_recovery_checks": DemoSignalConfig().blink_baseline_recovery_checks_required,
            "burst_recovery_checks": DemoSignalConfig().blink_burst_recovery_checks_required,
        },
        "historical_development_replay": historical,
        "synthetic_streaming": synthetic,
        "auxiliary_isolation": isolation,
        "fast_recovery": recovery,
        "assertions": assertions,
        "limitations": [
            "The 136 marked trials are a one-wearer development set, not an independent cross-person test.",
            "The latest headset sessions are reported separately in latest_headset_replay_v121_report.json and still require prospective re-wear validation.",
        ],
    }
    if not all(assertions.values()):
        raise AssertionError(json.dumps(assertions, ensure_ascii=False, indent=2))
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
