#!/usr/bin/env python3
from __future__ import annotations

import numpy as np

from realtime_sleep_staging.experimental_band_alpha import ExperimentalBandAlphaRuntime


def chunk(rng: np.random.Generator, amplitude: float, offset: int) -> np.ndarray:
    time = (np.arange(25) + offset) / 100.0
    phases = (0.0, 0.45, 1.1, 1.8)
    return np.stack(
        [
            rng.normal(0.0, 12.0 if amplitude < 10 else 7.0, time.size)
            + amplitude * np.sin(2 * np.pi * 10.0 * time + phase)
            for phase in phases
        ]
    )


def feed(runtime: ExperimentalBandAlphaRuntime, rng: np.random.Generator, amplitude: float, seconds: int):
    output = None
    for index in range(seconds * 4):
        eeg = chunk(rng, amplitude, index * 25)
        output = runtime.step(eeg, np.zeros((3, 25)), np.ones(25, dtype=bool))
    assert output is not None
    return output


def feed_deep(runtime: ExperimentalBandAlphaRuntime, seconds: int):
    output = None
    for index in range(seconds * 4):
        time = (np.arange(25) + index * 25) / 100.0
        eeg = np.stack([
            55.0 * np.sin(2 * np.pi * 1.0 * time + phase)
            + 3.0 * np.sin(2 * np.pi * 10.0 * time + phase)
            for phase in (0.0, 0.25, 0.5, 0.75)
        ])
        output = runtime.step(eeg, np.zeros((3, 25)), np.ones(25, dtype=bool))
    assert output is not None
    return output


def main() -> None:
    rng = np.random.default_rng(20260824)
    runtime = ExperimentalBandAlphaRuntime()
    runtime.begin_calibration("open-eye")
    opened = feed(runtime, rng, 4.0, 20)
    assert opened["open_complete"]
    assert not opened["closed_complete"]
    assert opened["band_shares"]["beta"] == max(opened["band_shares"].values())

    runtime.begin_calibration("closed-eye")
    closed = feed(runtime, rng, 36.0, 20)
    assert closed["closed_complete"]
    assert closed["individual_alpha_hz"] >= 7.5
    assert closed["individual_alpha_hz"] <= 13.5
    assert closed["band_shares"] is not None
    assert abs(sum(closed["band_shares"].values()) - 1.0) < 1e-6
    assert closed["band_shares"]["delta"] < closed["band_shares"]["alpha"]

    runtime.set_session_active(True)
    active = feed(runtime, rng, 36.0, 5)
    assert active["alpha_present"]
    assert active["recommended_volume"] > 0.0
    assert active["band_share_mode"] == "state_enhanced_visual_index"
    assert active["band_visual_state"] == "eyes_closed"
    assert active["band_shares"]["alpha"] == max(active["band_shares"].values())
    frozen_center = active["open_center"]
    feed(runtime, rng, 42.0, 5)
    assert runtime.open_center == frozen_center

    runtime.set_session_active(False)
    assert runtime.last_band_shares is not None
    assert runtime.last_band_shares["beta"] == max(runtime.last_band_shares.values())
    runtime.set_session_active(True)

    previous_shares = dict(runtime.last_band_shares or {})
    invalid = runtime.step(
        np.full((4, 100), 2**24, dtype=np.float64),
        np.zeros((3, 100)),
        np.zeros(100, dtype=bool),
    )
    assert invalid["clean_fraction"] == 0.0
    assert invalid["band_shares"] == previous_shares

    runtime.set_staging_context("NREM", True, 0.9)
    deep = feed_deep(runtime, 14)
    assert deep["band_visual_state"] == "deep_sleep_candidate"
    assert deep["band_shares"]["delta"] == max(deep["band_shares"].values())

    timed = ExperimentalBandAlphaRuntime()
    timed.begin_calibration("open-eye", "2026-08-24T00:00:01.000Z")
    before_start = timed.step(
        chunk(rng, 4.0, 0),
        np.zeros((3, 25)),
        np.ones(25, dtype=bool),
        "2026-08-24T00:00:00.750Z",
    )
    assert before_start["open_progress"] == 0.0
    output = None
    for index in range(80):
        validity = np.ones(25, dtype=bool)
        validity[::5] = False
        output = timed.step(
            chunk(rng, 4.0, index * 25),
            np.zeros((3, 25)),
            validity,
            f"2026-08-24T00:00:{1 + index / 4:06.3f}Z",
        )
        if index == 78:
            assert output["open_progress"] == 79 / 80
            assert not output["open_complete"]
    assert output is not None
    assert output["open_progress"] == 1.0
    assert output["open_complete"]
    assert abs(output["open_valid_fraction"] - 0.8) < 1e-9

    gate = ExperimentalBandAlphaRuntime()
    gate_rng = np.random.default_rng(20260825)
    gate.begin_calibration("open-eye")
    feed(gate, gate_rng, 4.0, 20)
    gate.begin_calibration("closed-eye")
    feed(gate, gate_rng, 36.0, 20)
    feed(gate, gate_rng, 4.0, 5)
    short_alpha = feed(gate, gate_rng, 36.0, 2)
    assert short_alpha["alpha_window_seconds"] == 3.0
    assert short_alpha["alpha_on_hold_seconds"] == 3.0
    assert not short_alpha["alpha_present"]
    assert gate.on_count > 0
    gate.step(
        chunk(gate_rng, 36.0, 0),
        np.zeros((3, 25)),
        np.zeros(25, dtype=bool),
    )
    assert gate.on_count == 0
    assert not feed(gate, gate_rng, 36.0, 2)["alpha_present"]
    assert feed(gate, gate_rng, 36.0, 2)["alpha_present"]

    print(
        {
            "individual_alpha_hz": active["individual_alpha_hz"],
            "alpha_evidence": active["alpha_evidence"],
            "volume": active["recommended_volume"],
            "band_shares": active["band_shares"],
            "deep_visual_shares": deep["band_shares"],
            "calibration_exact_samples": 2_000,
            "alpha_window_seconds": active["alpha_window_seconds"],
            "alpha_sustained_gate_seconds": active["alpha_on_hold_seconds"],
            "artifact_hold": True,
        }
    )


if __name__ == "__main__":
    main()
