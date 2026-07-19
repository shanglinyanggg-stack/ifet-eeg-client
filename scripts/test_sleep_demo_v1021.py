from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
ALGORITHM = (
    ROOT
    / "src-tauri"
    / "resources"
    / "SleepStagingAlgorithm_PC_v1.2.0"
    / "sdk"
    / "realtime_sleep_staging"
    / "demo_signal_flags.py"
)


def load_algorithm():
    spec = importlib.util.spec_from_file_location("ifet_demo_signal_flags_v1021", ALGORITHM)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {ALGORITHM}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ALGO = load_algorithm()


def calibration_signal(channel_count: int) -> np.ndarray:
    """3s quiet baseline + 10s natural blinks at 100 Hz on the first N channels."""
    sample_rate = 100
    total = 1_300
    time = np.arange(total, dtype=np.float64) / sample_rate
    eeg = np.random.default_rng(7).normal(0.0, 0.8, (4, total))
    for center in np.arange(3.5, 12.6, 0.75):
        pulse = 600.0 * np.exp(-0.5 * ((time - center) / 0.045) ** 2)
        for channel in range(channel_count):
            eeg[channel] += pulse * (1.0 - 0.08 * channel)
    return eeg


def run_calibration(channel_count: int):
    detector = ALGO.DemoSignalFlagger()
    detector.set_blink_interaction_enabled(True)
    detector.begin_blink_calibration()
    eeg = calibration_signal(channel_count)
    output = None
    for start in range(0, eeg.shape[1], 50):
        output = detector.stream_step(
            eeg[:, start : start + 50],
            np.zeros((3, 50), dtype=np.float64),
            np.ones(50, dtype=bool),
        )
    assert output is not None
    return detector, output


class DemoSignalFlagsV1021Tests(unittest.TestCase):
    def test_four_channel_calibration_reaches_v9_ready_state(self) -> None:
        detector, output = run_calibration(4)
        packet = output.to_packet()
        profile = detector.calibration_profile()
        self.assertEqual(packet["schema_version"], "headset-demo-flags/v9")
        self.assertTrue(packet["state"]["blink_calibration_complete"])
        self.assertGreaterEqual(profile["blink_peak_count"], 5)
        self.assertGreaterEqual(profile["blink_consensus"], 0.65)
        self.assertEqual(
            profile["blink_enabled_channel_pairs"],
            [[1, 2], [3, 4]],
        )
        self.assertIn("blink_baseline_stale", packet["state"])
        self.assertIn("blink_invalid_gap_rejections", packet["telemetry"])
        self.assertIn("blink_baseline_health_checks", packet["telemetry"])
        self.assertIn("blink_baseline_recovery_progress", packet["telemetry"])
        self.assertIn("blink_runtime_disabled_pairs", packet["telemetry"])
        self.assertIn("blink_template_ready", packet["telemetry"])
        self.assertTrue(packet["state"]["blink_group_decoder_enabled"])

    def test_legacy_pair_only_calibration_still_passes(self) -> None:
        detector, _ = run_calibration(2)
        profile = detector.calibration_profile()
        self.assertTrue(detector.blink_calibration_complete)
        self.assertEqual(profile["blink_enabled_channel_pairs"], [[1, 2]])

    def test_single_channel_calibration_is_rejected(self) -> None:
        detector, output = run_calibration(1)
        flags = {event.flag for event in output.events}
        self.assertFalse(detector.blink_calibration_complete)
        self.assertIn("BLINK_CALIBRATION_FAILED", flags)

    def test_invalid_chunk_boundary_does_not_create_a_blink(self) -> None:
        detector, _ = run_calibration(4)
        invalid = np.full((4, 50), np.nan, dtype=np.float64)
        output = detector.stream_step(
            invalid,
            np.zeros((3, 50), dtype=np.float64),
            np.zeros(50, dtype=bool),
        )
        flags = {event.flag for event in output.events}
        self.assertNotIn("BLINK", flags)
        self.assertNotIn("BLINK_3", flags)
        self.assertNotIn("BLINK_5", flags)

    def test_open_eye_restart_preserves_learned_blink_profile(self) -> None:
        detector, _ = run_calibration(4)
        sample_rate = 100
        time = np.arange(2_200, dtype=np.float64) / sample_rate
        alpha = np.vstack([
            20.0 * np.sin(2.0 * np.pi * 10.0 * time + phase)
            for phase in (0.0, 0.2, 0.4, 0.6)
        ])
        for start in range(0, alpha.shape[1], 50):
            detector.stream_step(
                alpha[:, start : start + 50],
                np.zeros((3, 50), dtype=np.float64),
                np.ones(50, dtype=bool),
            )
        self.assertTrue(detector.calibration_complete)
        self.assertTrue(detector.blink_calibration_complete)

        detector.begin_open_eye_calibration()

        self.assertFalse(detector.calibration_complete)
        self.assertFalse(detector.closed_eye_calibration_complete)
        self.assertTrue(detector.blink_calibration_complete)
        self.assertTrue(detector.blink_template_ready)


if __name__ == "__main__":
    unittest.main()
