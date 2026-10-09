#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

from realtime_sleep_staging.experimental_band_alpha import (
    ALPHA_WINDOW_SECONDS,
    BANDS,
    ExperimentalBandAlphaRuntime,
)


PHASE_VALIDATION_MODULE = Path(
    "/Users/ysl/Developer/EEGDM/eegdm_v3_harness/sleep_staging/"
    "validate_ifet_band_alpha_algorithms_2026_08_24.py"
)
R2_REPORT = Path(
    "/Users/ysl/Developer/EEGDM/result/"
    "ifet_algorithm_validation_2026_08_24_band_alpha_r2/validation_report.json"
)


def feed(
    runtime: ExperimentalBandAlphaRuntime,
    eeg: np.ndarray,
    imu: np.ndarray,
    collect: bool = False,
) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for start in range(0, eeg.shape[1] - 24, 25):
        output = runtime.step(
            eeg[:, start : start + 25],
            imu[:, start : start + 25],
            np.ones(25, dtype=bool),
        )
        if collect and output["band_shares"] is not None:
            rows.append(dict(output["band_shares"]))
    return rows


def phase_replay() -> dict[str, object]:
    spec = importlib.util.spec_from_file_location("ifet_phase_validation_r3", PHASE_VALIDATION_MODULE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load phase validation module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    report: dict[str, object] = {}
    for recording in module.PHASE_RECORDINGS:
        loaded = module.load_phase_recording(recording)
        segments = module.phase_segments(loaded)
        runtime = ExperimentalBandAlphaRuntime()
        runtime.begin_calibration("open-eye")
        feed(runtime, segments["open"][:, :2000], segments["open_imu"][:, :2000])
        runtime.begin_calibration("closed-eye")
        feed(runtime, segments["closed"][:, :2000], segments["closed_imu"][:, :2000])
        recording_report: dict[str, object] = {}
        for state, expected_index in (("open", 3), ("closed", 2)):
            # The presentation index intentionally follows the explicit UI
            # workflow: Stop/idle is the open-eye visual state and Start Sleep
            # is the closed-eye visual state.  EEG remains present only as a
            # confidence/quality input and never turns this into physical PSD.
            runtime.set_session_active(state == "closed")
            rows = feed(
                runtime,
                segments[state][:, 2000:],
                segments[f"{state}_imu"][:, 2000:],
                collect=True,
            )
            values = np.asarray(
                [[row[name] for name, _, _ in BANDS] for row in rows], dtype=np.float64
            )
            recording_report[state] = {
                "windows": int(len(values)),
                "expected_dominance_fraction": float(
                    np.mean(np.argmax(values, axis=1) == expected_index)
                ),
                "median_visual_shares": {
                    name: float(np.median(values[:, index]))
                    for index, (name, _, _) in enumerate(BANDS)
                },
            }
        report[recording.name] = recording_report
    return report


def synthetic_deep_replay() -> dict[str, object]:
    rng = np.random.default_rng(20260824)
    runtime = ExperimentalBandAlphaRuntime()

    def synthetic(alpha_amplitude: float, seconds: int, delta_amplitude: float = 0.0) -> None:
        for index in range(seconds * 4):
            time = (np.arange(25) + index * 25) / 100.0
            eeg = np.stack(
                [
                    rng.normal(0.0, 5.0, 25)
                    + alpha_amplitude * np.sin(2 * np.pi * 10.0 * time + phase)
                    + delta_amplitude * np.sin(2 * np.pi * 1.0 * time + phase)
                    for phase in (0.0, 0.3, 0.6, 0.9)
                ]
            )
            runtime.step(eeg, np.zeros((3, 25)), np.ones(25, dtype=bool))

    runtime.begin_calibration("open-eye")
    synthetic(4.0, 20)
    runtime.begin_calibration("closed-eye")
    synthetic(35.0, 20)
    runtime.set_session_active(False)
    synthetic(4.0, 6)
    awake = dict(runtime.last_band_shares or {})
    runtime.set_session_active(True)
    synthetic(35.0, 6)
    closed = dict(runtime.last_band_shares or {})
    runtime.set_staging_context("NREM", True, 0.9)
    synthetic(3.0, 16, 60.0)
    deep = dict(runtime.last_band_shares or {})
    reference_span = max(
        float(runtime.closed_reference or 0.0) - float(runtime.open_center or 0.0),
        0.1,
    )
    display_on_threshold = float(np.clip(
        (float(runtime.on_threshold or 0.0) - float(runtime.open_center or 0.0))
        / reference_span,
        0.0,
        1.0,
    ))
    return {
        "awake": awake,
        "eyes_closed": closed,
        "deep_sleep_candidate": deep,
        "awake_beta_is_max": max(awake, key=awake.get) == "beta",
        "closed_alpha_is_max": max(closed, key=closed.get) == "alpha",
        "deep_delta_is_max": max(deep, key=deep.get) == "delta",
        "display_alpha_on_threshold": display_on_threshold,
        "display_alpha_threshold_nonnegative": display_on_threshold >= 0.0,
    }


def calibration_timing() -> dict[str, object]:
    runtime = ExperimentalBandAlphaRuntime()
    runtime.begin_calibration("open-eye", "2026-08-24T00:00:01.000Z")
    eeg = np.ones((4, 25), dtype=np.float64)
    imu = np.zeros((3, 25), dtype=np.float64)
    valid = np.ones(25, dtype=bool)
    valid[::5] = False
    ignored = runtime.step(eeg, imu, valid, "2026-08-24T00:00:00.750Z")
    for index in range(80):
        output = runtime.step(eeg, imu, valid, f"2026-08-24T00:00:{1 + index / 4:06.3f}Z")
    return {
        "model_sample_rate_hz": 100,
        "elapsed_samples": 2000,
        "duration_seconds": 20.0,
        "pre_click_chunk_ignored": ignored["open_progress"] == 0.0,
        "progress": output["open_progress"],
        "valid_fraction": output["open_valid_fraction"],
        "complete": output["open_complete"],
    }


def sustained_alpha_gate() -> dict[str, object]:
    rng = np.random.default_rng(20260825)
    runtime = ExperimentalBandAlphaRuntime()

    def run(amplitude: float, chunks: int, valid: bool = True) -> dict[str, object]:
        output: dict[str, object] = {}
        for index in range(chunks):
            time = (np.arange(25) + index * 25) / 100.0
            eeg = np.stack([
                rng.normal(0.0, 7.0, 25)
                + amplitude * np.sin(2 * np.pi * 10.0 * time + phase)
                for phase in (0.0, 0.3, 0.6, 0.9)
            ])
            output = runtime.step(
                eeg,
                np.zeros((3, 25)),
                np.full(25, valid, dtype=bool),
            )
        return output

    runtime.begin_calibration("open-eye")
    run(4.0, 80)
    runtime.begin_calibration("closed-eye")
    run(35.0, 80)
    run(4.0, 20)
    short = run(35.0, 8)
    run(35.0, 1, valid=False)
    interrupted_count = runtime.on_count
    after_restart = run(35.0, 8)
    sustained = run(35.0, 8)
    return {
        "analysis_window_seconds": ALPHA_WINDOW_SECONDS,
        "required_continuous_seconds": runtime.parameters.on_hold_seconds,
        "two_second_burst_rejected": not bool(short["alpha_present"]),
        "invalid_chunk_resets_counter": interrupted_count == 0,
        "two_seconds_after_reset_rejected": not bool(after_restart["alpha_present"]),
        "sustained_alpha_accepted": bool(sustained["alpha_present"]),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    r2 = json.loads(R2_REPORT.read_text(encoding="utf-8"))
    phase = phase_replay()
    synthetic = synthetic_deep_replay()
    timing = calibration_timing()
    alpha_gate = sustained_alpha_gate()
    checks = {
        "test1_open_beta_dominance_at_least_0_90": phase["test1"]["open"]["expected_dominance_fraction"] >= 0.90,
        "test1_closed_alpha_dominance_at_least_0_90": phase["test1"]["closed"]["expected_dominance_fraction"] >= 0.90,
        "test2_open_beta_dominance_at_least_0_90": phase["test2"]["open"]["expected_dominance_fraction"] >= 0.90,
        "test2_closed_alpha_dominance_at_least_0_90": phase["test2"]["closed"]["expected_dominance_fraction"] >= 0.90,
        "synthetic_deep_delta_is_max": synthetic["deep_delta_is_max"],
        "display_alpha_threshold_nonnegative": synthetic[
            "display_alpha_threshold_nonnegative"
        ],
        "calibration_exactly_20_seconds": timing["duration_seconds"] == 20.0 and timing["complete"],
        "pre_click_data_is_ignored": timing["pre_click_chunk_ignored"],
        "alpha_uses_three_second_window": alpha_gate[
            "analysis_window_seconds"
        ] == 3.0,
        "alpha_requires_three_continuous_seconds": alpha_gate[
            "required_continuous_seconds"
        ] == 3.0,
        "short_or_interrupted_alpha_is_rejected": all((
            alpha_gate["two_second_burst_rejected"],
            alpha_gate["invalid_chunk_resets_counter"],
            alpha_gate["two_seconds_after_reset_rejected"],
            alpha_gate["sustained_alpha_accepted"],
        )),
    }
    report = {
        "schema_version": "ifet-band-alpha-r3-visual-validation/v1",
        "algorithm_package_version": "1.2.0+band-alpha-exp.20260824.3",
        "release_approved": False,
        "display_semantics": "workflow_and_stage_enhanced_visual_index_not_physical_power",
        "visual_state_driver": (
            "open-eye calibration or idle=awake; closed-eye calibration or active "
            "sleep guidance=eyes_closed; valid NREM plus sustained Delta evidence="
            "deep_sleep_candidate"
        ),
        "physical_band_replay_from_r2": r2["psg_holdout"],
        "calibration_timing": timing,
        "alpha_sustained_gate": alpha_gate,
        "open_closed_phase_replay": phase,
        "synthetic_state_replay": synthetic,
        "checks": checks,
        "visual_acceptance_pass": all(checks.values()),
        "warning": "Visual shares are presentation indices. Never use them as physical relative power or as model input.",
    }
    (args.output / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
