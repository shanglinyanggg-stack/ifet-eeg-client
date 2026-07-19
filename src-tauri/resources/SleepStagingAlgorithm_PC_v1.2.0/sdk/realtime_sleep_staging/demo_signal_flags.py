from __future__ import annotations

from collections import deque
from dataclasses import asdict, dataclass
from typing import Iterable

import numpy as np
from scipy.signal import butter, find_peaks, peak_widths, sosfilt, sosfilt_zi


ACTION_FLAGS = frozenset(
    {
        "PLAY_MUSIC_ALPHA",
        "LOWER_VOLUME_ALPHA_DECAY",
        "BLINK_3",
        "BLINK_5",
        "VOLUME_DOWN_3_BLINKS",
        "VOLUME_UP_5_BLINKS",
    }
)


@dataclass(frozen=True)
class DemoSignalConfig:
    """Configuration for the deterministic headset demo detector.

    The first ``calibration_seconds`` are expected to be quiet, eyes-open data.
    No learned weights are used. All thresholds after calibration are derived
    from the current wearer and electrode contact.
    """

    sample_rate_hz: int = 100
    # Alpha/sleep control keeps the two forehead channels that were verified on
    # the headset. Blink detection has an independent four-channel fusion path.
    active_eeg_channels: tuple[int, ...] = (0, 1)
    blink_eeg_channels: tuple[int, ...] = (0, 1, 2, 3)
    blink_channel_pairs: tuple[tuple[int, int], ...] = ((0, 1), (2, 3))
    blink_minimum_consensus_channels: int = 2
    calibration_seconds: float = 20.0
    closed_eye_calibration_seconds: float = 20.0
    alpha_window_seconds: float = 4.0
    alpha_update_seconds: float = 0.25
    alpha_on_robust_z: float = 2.0
    alpha_off_robust_z: float = 0.75
    alpha_absolute_ratio_floor: float = 0.18
    alpha_on_hold_seconds: float = 1.0
    alpha_min_active_seconds: float = 5.0
    alpha_decay_hold_seconds: float = 3.0
    alpha_decay_peak_fraction: float = 0.62
    adaptive_channel_selection: bool = True
    alpha_channel_quality_ema_seconds: float = 4.0
    alpha_channel_switch_hold_seconds: float = 2.0
    alpha_channel_switch_margin: float = 0.10
    alpha_min_channel_quality: float = 0.15
    alpha_level_ema_seconds: float = 1.5
    adaptive_alpha_threshold: bool = True
    alpha_baseline_quantile: float = 0.75
    alpha_max_threshold_above_center: float = 0.12
    alpha_min_consensus_channels: int = 2
    alpha_consensus_threshold_fraction: float = 0.85
    adaptive_baseline_memory_seconds: float = 180.0
    adaptive_baseline_update_seconds: float = 5.0
    adaptive_baseline_time_constant_seconds: float = 300.0
    adaptive_baseline_max_robust_z: float = 2.5
    adaptive_baseline_min_quality: float = 0.25
    alpha_step_thresholds: tuple[float, float] = (0.34, 0.67)
    alpha_step_hysteresis: float = 0.08
    alpha_step_hold_seconds: float = 1.0
    alpha_step_volume_levels: tuple[float, float, float] = (0.35, 0.65, 1.0)
    # Measure quiet background separately from repeated blinks.  Estimating
    # noise scale from data that already contains blinks makes weak/noisy
    # calibrations look artificially valid.
    blink_quiet_baseline_seconds: float = 3.0
    blink_calibration_seconds: float = 10.0
    blink_refresh_seconds: float = 0.10
    blink_threshold_robust_z: float = 3.5
    blink_rearm_robust_z: float = 1.8
    blink_refractory_seconds: float = 0.32
    # A blink is valid only when at least two configured blink channels respond
    # at the same peak. The weaker of the best two may be smaller, but must
    # still clear this fraction of the wearer-specific robust-z threshold.
    blink_channel_consensus_fraction: float = 0.60
    blink_calibration_minimum_consensus: float = 0.65
    blink_calibration_minimum_strength_z: float = 3.0
    # Real-session replay showed that two-way online scale adaptation shrank
    # the noise scale and more than doubled accepted background peaks.  Freeze
    # the calibrated wearer/contact baseline and request recalibration on drift.
    adaptive_blink_baseline: bool = False
    blink_adaptive_memory_seconds: float = 90.0
    blink_adaptive_minimum_seconds: float = 15.0
    blink_adaptive_update_seconds: float = 5.0
    blink_adaptive_time_constant_seconds: float = 180.0
    # A quieter background only makes a frozen threshold conservative.  Do not
    # suspend control unless scale collapses by an extreme factor; the safety
    # concern is primarily a large noise/contact increase.
    blink_baseline_health_scale_ratio_min: float = 0.10
    blink_baseline_health_scale_ratio_max: float = 2.50
    blink_baseline_health_center_shift_z_max: float = 2.50
    blink_baseline_health_failures_required: int = 3
    # Blank causal-filter recovery after missing/interpolated samples and do
    # not accept a peak close to a transport discontinuity. A very short gap
    # must not erase the other valid blinks in a five-blink group; only a
    # sustained discontinuity resets the whole gesture.
    blink_invalid_guard_seconds: float = 0.20
    blink_gesture_gap_reset_seconds: float = 0.35
    blink_post_calibration_guard_seconds: float = 1.50
    gesture_window_seconds: float = 7.0
    gesture_min_interval_seconds: float = 0.16
    gesture_max_interval_seconds: float = 1.40
    gesture_adaptive_max_interval_seconds: float = 1.80
    gesture_max_interval_jitter_seconds: float = 0.45
    gesture_min_peak_robust_z: float = 3.5
    # Real TD10 recordings can show a strong first blink followed by much
    # smaller, but still valid, blinks.  Keep only a broad artifact guard here;
    # wearer calibration, the robust-z gate and IMU motion gate do the actual
    # blink validation.
    gesture_min_amplitude_ratio: float = 0.05
    gesture_max_amplitude_ratio: float = 25.00
    # If a group ends with four detected peaks and the fourth is much weaker,
    # treat it as the waveform tail of a three-blink gesture. Do not discard it
    # immediately: a genuine five-blink group can also decay strongly and must
    # be allowed to receive its fifth peak.
    gesture_continuation_min_amplitude_ratio: float = 0.55
    # Recover at most one blink hidden by a short BLE gap when the surrounding
    # rhythm is close to twice the wearer-calibrated inter-blink interval.
    gesture_gap_recovery_ratio_min: float = 1.65
    gesture_gap_recovery_ratio_max: float = 2.60
    # Three blinks stay pending long enough to give a continuing five-blink
    # gesture priority.  The effective gap is also kept above the learned
    # maximum inter-blink interval by ``_gesture_end_gap_limit_seconds``.
    gesture_end_gap_seconds: float = 2.05
    gesture_cooldown_seconds: float = 0.60
    blink_motion_window_seconds: float = 1.5
    blink_max_acceleration_std: float = 250.0


@dataclass(frozen=True)
class DemoFlagEvent:
    flag: str
    time_seconds: float
    value: float | int | None = None

    def to_dict(self) -> dict[str, float | int | str | None]:
        return asdict(self)


@dataclass(frozen=True)
class DemoFlagOutput:
    time_seconds: float
    flags: tuple[str, ...]
    events: tuple[DemoFlagEvent, ...]
    alpha_ratio: float | None
    alpha_score: float | None
    alpha_level: float | None
    alpha_step: int
    alpha_step_count: int
    alpha_volume_mode: str
    recommended_volume: float
    alpha_present: bool
    selected_alpha_channels: tuple[int, ...]
    alpha_channel_weights: tuple[float, ...]
    alpha_channel_switches: int
    calibration_complete: bool
    calibration_progress: float
    closed_eye_calibration_complete: bool
    closed_eye_calibration_progress: float
    adaptive_baseline_updates: int
    open_eye_alpha_baseline: float | None
    closed_eye_alpha_reference: float | None
    blink_calibration_complete: bool
    blink_calibration_progress: float
    blink_count_pending: int
    blink_strength_z: float | None
    blink_width_seconds: float | None
    blink_adaptive_baseline_updates: int
    blink_single_channel_rejections: int
    blink_invalid_gap_rejections: int
    blink_baseline_health_checks: int
    blink_baseline_stale: bool
    blink_dual_channel_required: bool
    blink_interaction_enabled: bool
    signal_quality: float

    def to_dict(self) -> dict[str, object]:
        result = asdict(self)
        result["events"] = [event.to_dict() for event in self.events]
        return result

    def to_packet(self) -> dict[str, object]:
        """Return the stable JSON-serializable packet consumed by the app."""

        return {
            "schema_version": "headset-demo-flags/v7",
            "timestamp_ms": int(round(self.time_seconds * 1000.0)),
            "action_flags": [flag for flag in self.flags if flag in ACTION_FLAGS],
            "state_flags": [flag for flag in self.flags if flag not in ACTION_FLAGS],
            "state": {
                "alpha_present": self.alpha_present,
                "calibration_complete": self.calibration_complete,
                "calibration_progress": self.calibration_progress,
                "closed_eye_calibration_complete": self.closed_eye_calibration_complete,
                "closed_eye_calibration_progress": self.closed_eye_calibration_progress,
                "blink_calibration_complete": self.blink_calibration_complete,
                "blink_calibration_progress": self.blink_calibration_progress,
                "blink_interaction_enabled": self.blink_interaction_enabled,
                "blink_count_pending": self.blink_count_pending,
                "blink_dual_channel_required": self.blink_dual_channel_required,
                "blink_baseline_stale": self.blink_baseline_stale,
            },
            "telemetry": {
                "alpha_ratio": self.alpha_ratio,
                "alpha_score": self.alpha_score,
                "alpha_level": self.alpha_level,
                "alpha_step": self.alpha_step,
                "alpha_step_count": self.alpha_step_count,
                "alpha_volume_mode": self.alpha_volume_mode,
                "recommended_volume": self.recommended_volume,
                "open_eye_alpha_baseline": self.open_eye_alpha_baseline,
                "closed_eye_alpha_reference": self.closed_eye_alpha_reference,
                "adaptive_baseline_updates": self.adaptive_baseline_updates,
                "signal_quality": self.signal_quality,
                "selected_alpha_channels": list(self.selected_alpha_channels),
                "alpha_channel_weights": list(self.alpha_channel_weights),
                "alpha_channel_switches": self.alpha_channel_switches,
                "blink_strength_z": self.blink_strength_z,
                "blink_width_seconds": self.blink_width_seconds,
                "blink_adaptive_baseline_updates": self.blink_adaptive_baseline_updates,
                "blink_single_channel_rejections": self.blink_single_channel_rejections,
                "blink_invalid_gap_rejections": self.blink_invalid_gap_rejections,
                "blink_baseline_health_checks": self.blink_baseline_health_checks,
            },
            "events": [event.to_dict() for event in self.events],
        }


def robust_center_scale(values: np.ndarray, minimum_scale: float = 1e-6) -> tuple[float, float]:
    finite = np.asarray(values, dtype=np.float64)
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        return 0.0, minimum_scale
    center = float(np.median(finite))
    mad = float(np.median(np.abs(finite - center)))
    scale = max(1.4826 * mad, float(np.std(finite)) * 0.2, minimum_scale)
    return center, scale


def alpha_ratio_from_window(
    eeg: np.ndarray,
    sample_rate_hz: int = 100,
    channel_indices: tuple[int, ...] = (0, 1),
) -> tuple[float, float]:
    """Return alpha relative power using only the configured EEG channels."""

    values = np.asarray(eeg, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] != 4:
        raise ValueError("eeg must have shape [4, samples]")
    if values.shape[1] < sample_rate_hz * 2:
        return float("nan"), 0.0

    values = values - np.median(values, axis=1, keepdims=True)
    window = np.hanning(values.shape[1])[None, :]
    spectrum = np.abs(np.fft.rfft(values * window, axis=1)) ** 2
    frequencies = np.fft.rfftfreq(values.shape[1], d=1.0 / sample_rate_hz)
    alpha_mask = (frequencies >= 8.0) & (frequencies <= 13.0)
    reference_mask = (frequencies >= 4.0) & (frequencies <= 25.0)
    alpha_power = spectrum[:, alpha_mask].sum(axis=1)
    reference_power = spectrum[:, reference_mask].sum(axis=1)
    standard_deviation = np.std(values, axis=1)
    usable = (
        np.isfinite(alpha_power)
        & np.isfinite(reference_power)
        & (reference_power > 1e-9)
        & (standard_deviation > 1e-6)
    )
    active = np.zeros(4, dtype=bool)
    active[list(channel_indices)] = True
    usable &= active
    ratios = alpha_power[usable] / np.maximum(reference_power[usable], 1e-9)
    ratios = ratios[np.isfinite(ratios)]
    if ratios.size == 0:
        return float("nan"), 0.0
    selected = np.sort(ratios)[-min(2, ratios.size) :]
    return float(np.mean(selected)), float(ratios.size / max(len(channel_indices), 1))


def alpha_channel_features(
    eeg: np.ndarray,
    sample_rate_hz: int = 100,
    channel_indices: tuple[int, ...] = (0, 1),
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return per-channel alpha ratios, artifact-aware quality, and usability.

    Quality is unitless and device-scale independent. It combines high-frequency
    contamination, amplitude consistency across the four electrodes, and a
    flat/saturated-signal check. It intentionally does not use future samples.
    """

    values = np.asarray(eeg, dtype=np.float64)
    if values.ndim != 2 or values.shape[0] != 4:
        raise ValueError("eeg must have shape [4, samples]")
    if values.shape[1] < sample_rate_hz * 2:
        return np.full(4, np.nan), np.zeros(4), np.zeros(4, dtype=bool)

    finite_channels = np.isfinite(values).all(axis=1)
    centered = values - np.nanmedian(values, axis=1, keepdims=True)
    window = np.hanning(values.shape[1])[None, :]
    spectrum = np.abs(np.fft.rfft(centered * window, axis=1)) ** 2
    frequencies = np.fft.rfftfreq(values.shape[1], d=1.0 / sample_rate_hz)
    alpha_mask = (frequencies >= 8.0) & (frequencies <= 13.0)
    reference_mask = (frequencies >= 4.0) & (frequencies <= 25.0)
    broad_mask = (frequencies >= 4.0) & (frequencies <= 30.0)
    high_mask = (frequencies >= 20.0) & (frequencies <= 30.0)
    alpha_power = spectrum[:, alpha_mask].sum(axis=1)
    reference_power = spectrum[:, reference_mask].sum(axis=1)
    broad_power = spectrum[:, broad_mask].sum(axis=1)
    high_power = spectrum[:, high_mask].sum(axis=1)
    standard_deviation = np.nanstd(centered, axis=1)
    change_fraction = np.mean(np.abs(np.diff(centered, axis=1)) > 1e-12, axis=1)
    usable = (
        finite_channels
        & np.isfinite(alpha_power)
        & np.isfinite(reference_power)
        & (reference_power > 1e-9)
        & (standard_deviation > 1e-6)
        & (change_fraction > 0.02)
    )
    active = np.zeros(4, dtype=bool)
    active[list(channel_indices)] = True
    usable &= active

    ratios = np.full(4, np.nan, dtype=np.float64)
    ratios[usable] = alpha_power[usable] / np.maximum(reference_power[usable], 1e-9)
    median_std = float(np.median(standard_deviation[usable])) if usable.any() else 1.0
    amplitude_ratio = standard_deviation / max(median_std, 1e-9)
    amplitude_quality = np.exp(
        -0.5 * (np.log(np.maximum(amplitude_ratio, 1e-9)) / np.log(4.0)) ** 2
    )
    high_fraction = high_power / np.maximum(broad_power, 1e-9)
    spectral_quality = np.clip(1.0 - high_fraction / 0.65, 0.0, 1.0)
    continuity_quality = np.clip(change_fraction / 0.20, 0.0, 1.0)
    quality = amplitude_quality * spectral_quality * continuity_quality
    quality[~usable] = 0.0
    return ratios, np.clip(quality, 0.0, 1.0), usable


class DemoSignalFlagger:
    """Causal deterministic alpha/alpha-decay/blink-gesture detector.

    ``stream_step`` accepts arbitrary consecutive chunks and emits edge flags:

    - ``PLAY_MUSIC_ALPHA`` when sustained alpha first appears.
    - ``LOWER_VOLUME_ALPHA_DECAY`` after sustained alpha subsequently decays.
    - ``VOLUME_DOWN_3_BLINKS`` after exactly three rapid blinks.
    - ``VOLUME_UP_5_BLINKS`` immediately after five rapid blinks.

    ``ALPHA_PRESENT`` is also included as a state flag while alpha is present.
    """

    def __init__(self, config: DemoSignalConfig | None = None, *, input_prefiltered: bool = False) -> None:
        self.config = config or DemoSignalConfig()
        self.input_prefiltered = input_prefiltered
        self._validate_config()
        self._main_sos = butter(
            4,
            (0.5, 30.0),
            btype="bandpass",
            fs=self.config.sample_rate_hz,
            output="sos",
        )
        self._blink_sos = butter(
            3,
            (0.5, 8.0),
            btype="bandpass",
            fs=self.config.sample_rate_hz,
            output="sos",
        )
        self.reset()

    def _validate_config(self) -> None:
        if self.config.sample_rate_hz < 64:
            raise ValueError("sample_rate_hz must be at least 64 Hz")
        positive = (
            self.config.calibration_seconds,
            self.config.closed_eye_calibration_seconds,
            self.config.alpha_window_seconds,
            self.config.alpha_update_seconds,
            self.config.alpha_channel_quality_ema_seconds,
            self.config.alpha_channel_switch_hold_seconds,
            self.config.alpha_level_ema_seconds,
            self.config.blink_quiet_baseline_seconds,
            self.config.blink_calibration_seconds,
            self.config.blink_refresh_seconds,
            self.config.blink_adaptive_memory_seconds,
            self.config.blink_adaptive_minimum_seconds,
            self.config.blink_adaptive_update_seconds,
            self.config.blink_adaptive_time_constant_seconds,
            self.config.blink_invalid_guard_seconds,
            self.config.blink_gesture_gap_reset_seconds,
            self.config.blink_post_calibration_guard_seconds,
            self.config.gesture_window_seconds,
            self.config.adaptive_baseline_memory_seconds,
            self.config.adaptive_baseline_update_seconds,
            self.config.adaptive_baseline_time_constant_seconds,
            self.config.alpha_step_hold_seconds,
            self.config.blink_motion_window_seconds,
        )
        if any(value <= 0 for value in positive):
            raise ValueError("all timing parameters must be positive")
        if not 0.0 <= self.config.alpha_min_channel_quality <= 1.0:
            raise ValueError("alpha_min_channel_quality must be in [0, 1]")
        if self.config.alpha_channel_switch_margin < 0.0:
            raise ValueError("alpha_channel_switch_margin must be non-negative")
        if not 0.5 <= self.config.alpha_baseline_quantile < 1.0:
            raise ValueError("alpha_baseline_quantile must be in [0.5, 1)")
        if self.config.alpha_min_consensus_channels not in {1, 2}:
            raise ValueError("alpha_min_consensus_channels must be 1 or 2")
        if not 0.0 < self.config.blink_channel_consensus_fraction <= 1.0:
            raise ValueError("blink_channel_consensus_fraction must be in (0, 1]")
        if not 0.0 < self.config.blink_calibration_minimum_consensus <= 1.0:
            raise ValueError("blink_calibration_minimum_consensus must be in (0, 1]")
        if self.config.blink_calibration_minimum_strength_z <= 0.0:
            raise ValueError("blink_calibration_minimum_strength_z must be positive")
        if not (
            0.0 < self.config.gesture_continuation_min_amplitude_ratio <= 1.0
        ):
            raise ValueError(
                "gesture_continuation_min_amplitude_ratio must be in (0, 1]"
            )
        if not (
            1.0
            < self.config.gesture_gap_recovery_ratio_min
            < self.config.gesture_gap_recovery_ratio_max
        ):
            raise ValueError("gesture gap recovery ratios are invalid")
        if not (
            0.0
            < self.config.blink_baseline_health_scale_ratio_min
            < 1.0
            < self.config.blink_baseline_health_scale_ratio_max
        ):
            raise ValueError("blink baseline health scale ratios are invalid")
        if self.config.blink_baseline_health_center_shift_z_max <= 0.0:
            raise ValueError("blink_baseline_health_center_shift_z_max must be positive")
        if self.config.blink_baseline_health_failures_required < 1:
            raise ValueError("blink_baseline_health_failures_required must be >= 1")
        if (
            self.config.gesture_adaptive_max_interval_seconds
            < self.config.gesture_max_interval_seconds
        ):
            raise ValueError(
                "gesture_adaptive_max_interval_seconds must be >= gesture_max_interval_seconds"
            )
        if not self.config.active_eeg_channels:
            raise ValueError("active_eeg_channels must not be empty")
        if len(set(self.config.active_eeg_channels)) != len(
            self.config.active_eeg_channels
        ) or any(index not in range(4) for index in self.config.active_eeg_channels):
            raise ValueError("active_eeg_channels must be unique indices in [0, 3]")
        if len(self.config.active_eeg_channels) != 2:
            raise ValueError("alpha detection requires exactly two active EEG channels")
        if not self.config.blink_eeg_channels:
            raise ValueError("blink_eeg_channels must not be empty")
        if len(set(self.config.blink_eeg_channels)) != len(
            self.config.blink_eeg_channels
        ) or any(index not in range(4) for index in self.config.blink_eeg_channels):
            raise ValueError("blink_eeg_channels must be unique indices in [0, 3]")
        if not (
            2
            <= self.config.blink_minimum_consensus_channels
            <= len(self.config.blink_eeg_channels)
        ):
            raise ValueError(
                "blink_minimum_consensus_channels must be between 2 and the number of blink channels"
            )
        if not self.config.blink_channel_pairs:
            raise ValueError("blink_channel_pairs must not be empty")
        for pair in self.config.blink_channel_pairs:
            if (
                len(pair) != 2
                or pair[0] == pair[1]
                or any(index not in self.config.blink_eeg_channels for index in pair)
            ):
                raise ValueError(
                    "each blink channel pair must contain two distinct configured blink channels"
                )
        if len(self.config.alpha_step_thresholds) != 2 or not (
            0.0 < self.config.alpha_step_thresholds[0]
            < self.config.alpha_step_thresholds[1]
            < 1.0
        ):
            raise ValueError("alpha_step_thresholds must contain two increasing values in (0,1)")
        if len(self.config.alpha_step_volume_levels) != 3 or any(
            not 0.0 <= value <= 1.0
            for value in self.config.alpha_step_volume_levels
        ):
            raise ValueError("alpha_step_volume_levels must contain three values in [0,1]")

    def reset(self) -> None:
        fs = self.config.sample_rate_hz
        self._samples_seen = 0
        self._main_zi = np.zeros((4, self._main_sos.shape[0], 2), dtype=np.float64)
        self._blink_zi = np.zeros((4, self._blink_sos.shape[0], 2), dtype=np.float64)
        self._filter_initialized = False
        self._last_valid_raw_eeg: np.ndarray | None = None
        self._alpha_buffer = np.empty((4, 0), dtype=np.float64)
        self._alpha_window_samples = int(round(self.config.alpha_window_seconds * fs))
        self._alpha_update_samples = int(round(self.config.alpha_update_seconds * fs))
        self._next_alpha_sample = self._alpha_window_samples
        self._alpha_history: list[float] = []
        baseline_capacity = max(
            8,
            int(
                round(
                    self.config.adaptive_baseline_memory_seconds
                    / self.config.alpha_update_seconds
                )
            ),
        )
        self._adaptive_alpha_history: deque[float] = deque(maxlen=baseline_capacity)
        self._baseline_update_counter = 0
        self._adaptive_baseline_updates = 0
        self._alpha_center: float | None = None
        self._alpha_scale: float | None = None
        self._alpha_on_threshold: float | None = None
        self._alpha_off_threshold: float | None = None
        self._last_alpha_ratio: float | None = None
        self._last_alpha_score: float | None = None
        self._last_alpha_level: float | None = None
        self._alpha_volume_mode = "3"
        self._alpha_step_count = 3
        self._alpha_step = 0
        self._pending_alpha_step = 0
        self._pending_alpha_step_updates = 0
        self._recommended_volume = 0.0
        self._alpha_music_started = False
        self._alpha_present = False
        self._alpha_on_counter = 0
        self._alpha_active_updates = 0
        self._alpha_decay_counter = 0
        self._alpha_peak = 0.0
        self._alpha_channel_quality_ema = np.zeros(4, dtype=np.float64)
        self._alpha_channel_quality_initialized = False
        self._selected_alpha_channel_indices: tuple[int, ...] = ()
        self._selected_alpha_channel_weights: tuple[float, ...] = ()
        self._pending_alpha_channel_indices: tuple[int, ...] = ()
        self._pending_alpha_channel_updates = 0
        self._alpha_channel_switches = 0
        self._last_alpha_channel_quality = 0.0
        self._last_selected_alpha_ratios = np.empty(0, dtype=np.float64)
        self._closed_eye_active = False
        self._closed_eye_history: list[float] = []
        self._closed_eye_reference: float | None = None
        self._blink_calibration: list[list[float]] = [[], [], [], []]
        self._blink_center = np.zeros(4, dtype=np.float64)
        self._blink_scale = np.ones(4, dtype=np.float64)
        self._blink_calibrated = False
        self._blink_calibration_active = False
        self._blink_calibration_samples = 0
        self._blink_threshold_z = self.config.blink_threshold_robust_z
        self._blink_rearm_z = self.config.blink_rearm_robust_z
        self._gesture_min_peak_z = self.config.gesture_min_peak_robust_z
        self._blink_calibration_peak_count = 0
        self._blink_calibration_strength_z: float | None = None
        self._blink_calibration_width_seconds: float | None = None
        self._blink_calibration_interval_seconds: float | None = None
        self._blink_calibration_polarity = 0
        self._blink_calibration_consensus = 0.0
        self._blink_enabled_pairs = tuple(self.config.blink_channel_pairs)
        self._blink_motion_calibration: list[float] = []
        self._blink_motion_std_threshold = self.config.blink_max_acceleration_std
        blink_baseline_capacity = max(
            1,
            int(
                round(
                    self.config.blink_adaptive_memory_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        self._adaptive_blink_history: list[deque[float]] = [
            deque(maxlen=blink_baseline_capacity) for _ in range(4)
        ]
        self._blink_adaptive_last_update_sample = 0
        self._blink_adaptive_baseline_updates = 0
        self._blink_baseline_health_checks = 0
        self._blink_baseline_health_failures = 0
        self._blink_baseline_stale = False
        self._blink_baseline_scale_ratio = np.ones(4, dtype=np.float64)
        self._blink_single_channel_rejections = 0
        self._blink_invalid_gap_rejections = 0
        self._blink_gap_recoveries = 0
        self._last_blink_invalid_sample = -10**12
        self._consecutive_invalid_blink_samples = 0
        self._blink_valid_previous_1 = True
        self._blink_detection_resume_sample = 0
        self._last_blink_strength_z: float | None = None
        self._last_blink_width_seconds: float | None = None
        self._blink_candidate_start_sample: int | None = None
        self._blink_candidate_peak_sample = -1
        self._blink_candidate_peak_score = 0.0
        self._blink_candidate_polarity = 0
        self._blink_candidate_consensus = 0
        self._blink_armed = True
        self._pending_blink_candidates: deque[
            tuple[int, int, int, float, float]
        ] = deque()
        self._blink_score_previous_2 = 0.0
        self._blink_score_previous_1 = 0.0
        self._blink_fused_score_previous_1 = 0.0
        self._blink_secondary_score_previous_1 = 0.0
        self._last_blink_sample = -10**12
        self._blink_times: deque[float] = deque()
        self._blink_amplitudes: deque[float] = deque()
        self._gesture_polarity = 0
        self._blink_polarity_previous_1 = 0
        self._blink_consensus_previous_1 = 0
        self._gesture_cooldown_until = 0.0
        self._blink_interaction_enabled = False
        self._session_active = False
        self._imu_motion_history: deque[float] = deque(
            maxlen=max(
                1,
                int(
                    round(
                        self.config.blink_motion_window_seconds
                        * self.config.sample_rate_hz
                    )
                ),
            )
        )
        self._imu_motion_available = False

    def set_blink_interaction_enabled(
        self,
        enabled: bool,
    ) -> None:
        """Enable/disable persistent blink control independently of alpha detection."""

        self._blink_interaction_enabled = bool(enabled)
        self.reset_blink_gesture_state(clear_cooldown=False)

    def reset_blink_gesture_state(self, *, clear_cooldown: bool = False) -> None:
        """Discard pending blink/gesture state without changing calibration.

        Labelled 0/3/5 trials call this at their start and end so a peak from
        outside the trial cannot complete or contaminate the commanded group.
        """

        self._blink_times.clear()
        self._blink_amplitudes.clear()
        self._gesture_polarity = 0
        self._blink_armed = True
        self._pending_blink_candidates.clear()
        self._blink_score_previous_2 = 0.0
        self._blink_score_previous_1 = 0.0
        self._blink_fused_score_previous_1 = 0.0
        self._blink_secondary_score_previous_1 = 0.0
        self._blink_polarity_previous_1 = 0
        self._blink_consensus_previous_1 = 0
        self._blink_candidate_start_sample = None
        self._blink_candidate_peak_sample = -1
        self._blink_candidate_peak_score = 0.0
        self._blink_candidate_polarity = 0
        self._blink_candidate_consensus = 0
        self._last_blink_sample = -10**12
        self._blink_valid_previous_1 = True
        self._consecutive_invalid_blink_samples = 0
        if clear_cooldown:
            self._gesture_cooldown_until = 0.0

    def set_alpha_volume_mode(self, mode: str | int) -> None:
        """Select 3/10/20 discrete Alpha levels or continuous smoothing."""

        normalized = str(mode).strip().lower()
        if normalized not in {"3", "10", "20", "smooth"}:
            raise ValueError("alpha volume mode must be 3, 10, 20 or smooth")
        self._alpha_volume_mode = normalized
        self._alpha_step_count = 0 if normalized == "smooth" else int(normalized)
        self._alpha_step = 0
        self._pending_alpha_step = 0
        self._pending_alpha_step_updates = 0
        if self._last_alpha_level is not None:
            self._apply_alpha_volume_level()

    @property
    def alpha_volume_mode(self) -> str:
        return self._alpha_volume_mode

    @property
    def blink_interaction_enabled(self) -> bool:
        return self._blink_interaction_enabled

    def set_session_active(self, active: bool) -> None:
        """Inform the adaptive baseline gate without changing detector state."""

        self._session_active = bool(active)

    @property
    def calibration_progress(self) -> float:
        if self.calibration_complete:
            return 1.0
        required = self._required_open_eye_updates()
        return float(np.clip(len(self._alpha_history) / required, 0.0, 1.0))

    @property
    def closed_eye_calibration_complete(self) -> bool:
        return self._closed_eye_reference is not None

    @property
    def closed_eye_calibration_progress(self) -> float:
        if self.closed_eye_calibration_complete:
            return 1.0
        if not self._closed_eye_active:
            return 0.0
        required = max(
            1,
            int(
                round(
                    self.config.closed_eye_calibration_seconds
                    / self.config.alpha_update_seconds
                )
            ),
        )
        return float(np.clip(len(self._closed_eye_history) / required, 0.0, 1.0))

    def begin_closed_eye_calibration(self) -> None:
        if not self.calibration_complete:
            raise RuntimeError("open-eye baseline must be ready first")
        self._closed_eye_history.clear()
        self._closed_eye_reference = None
        self._closed_eye_active = True

    def _required_open_eye_updates(self) -> int:
        calibration_span = max(
            0.0,
            self.config.calibration_seconds - self.config.alpha_window_seconds,
        )
        return max(
            8,
            1 + int(np.floor(calibration_span / self.config.alpha_update_seconds)),
        )

    @property
    def recommended_volume(self) -> float:
        """Current normalized music-volume recommendation in [0, 1]."""

        return self._recommended_volume

    @property
    def calibration_complete(self) -> bool:
        """Whether the independent alpha detector has finished calibration."""

        return self._alpha_center is not None

    @property
    def blink_calibration_complete(self) -> bool:
        """Whether blink baseline calibration is ready for an enabled toggle."""

        return self._blink_calibrated

    @property
    def blink_calibration_progress(self) -> float:
        if self._blink_calibrated:
            return 1.0
        if not self._blink_calibration_active:
            return 0.0
        required = max(
            1,
            int(
                round(
                    (
                        self.config.blink_quiet_baseline_seconds
                        + self.config.blink_calibration_seconds
                    )
                    * self.config.sample_rate_hz
                )
            ),
        )
        return float(np.clip(self._blink_calibration_samples / required, 0.0, 1.0))

    def begin_blink_calibration(self) -> None:
        """Measure a sequence of natural blinks and learn wearer features."""

        self._blink_calibration = [[], [], [], []]
        self._blink_center.fill(0.0)
        self._blink_scale.fill(1.0)
        self._blink_calibrated = False
        self._blink_calibration_active = True
        self._blink_calibration_samples = 0
        self._blink_calibration_peak_count = 0
        self._blink_calibration_strength_z = None
        self._blink_calibration_width_seconds = None
        self._blink_calibration_interval_seconds = None
        self._blink_calibration_polarity = 0
        self._blink_calibration_consensus = 0.0
        self._blink_enabled_pairs = tuple(self.config.blink_channel_pairs)
        self._blink_motion_calibration.clear()
        for history in self._adaptive_blink_history:
            history.clear()
        self._blink_adaptive_last_update_sample = self._samples_seen
        self._blink_adaptive_baseline_updates = 0
        self._blink_baseline_health_checks = 0
        self._blink_baseline_health_failures = 0
        self._blink_baseline_stale = False
        self._blink_baseline_scale_ratio.fill(1.0)
        self._blink_single_channel_rejections = 0
        self._blink_invalid_gap_rejections = 0
        self._blink_gap_recoveries = 0
        self._last_blink_invalid_sample = -10**12
        self._blink_valid_previous_1 = True
        self._blink_detection_resume_sample = 10**12
        self._blink_motion_std_threshold = self.config.blink_max_acceleration_std
        self._blink_threshold_z = self.config.blink_threshold_robust_z
        self._blink_rearm_z = self.config.blink_rearm_robust_z
        self._gesture_min_peak_z = self.config.gesture_min_peak_robust_z
        self._last_blink_strength_z = None
        self._last_blink_width_seconds = None
        self._blink_candidate_start_sample = None
        self._blink_times.clear()
        self._blink_amplitudes.clear()
        self._gesture_polarity = 0
        self._blink_armed = True
        self._pending_blink_candidates.clear()
        self._blink_score_previous_2 = 0.0
        self._blink_score_previous_1 = 0.0
        self._blink_fused_score_previous_1 = 0.0
        self._blink_secondary_score_previous_1 = 0.0

    def calibration_profile(self) -> dict[str, object]:
        """Return the wearer-specific Alpha baseline for session metadata/UI."""

        return {
            "complete": self.calibration_complete,
            "center": self._alpha_center,
            "scale": self._alpha_scale,
            "on_threshold": self._alpha_on_threshold,
            "off_threshold": self._alpha_off_threshold,
            "closed_eye_reference": self._closed_eye_reference,
            "blink_complete": self._blink_calibrated,
            "blink_center": [
                float(self._blink_center[index])
                for index in self.config.blink_eeg_channels
            ],
            "blink_scale": [
                float(self._blink_scale[index])
                for index in self.config.blink_eeg_channels
            ],
            "blink_threshold_robust_z": self._blink_threshold_z,
            "blink_rearm_robust_z": self._blink_rearm_z,
            "blink_gesture_min_peak_robust_z": self._gesture_min_peak_z,
            "blink_peak_count": self._blink_calibration_peak_count,
            "blink_strength_z": self._blink_calibration_strength_z,
            "blink_width_seconds": self._blink_calibration_width_seconds,
            "blink_interval_seconds": self._blink_calibration_interval_seconds,
            "blink_polarity": self._blink_calibration_polarity,
            "blink_consensus": self._blink_calibration_consensus,
            "blink_quiet_baseline_seconds": self.config.blink_quiet_baseline_seconds,
            "blink_continuous_measurement_seconds": self.config.blink_calibration_seconds,
            "blink_calibration_minimum_consensus": self.config.blink_calibration_minimum_consensus,
            "blink_calibration_minimum_strength_z": self.config.blink_calibration_minimum_strength_z,
            "blink_dual_channel_required": True,
            "blink_minimum_consensus_channels": self.config.blink_minimum_consensus_channels,
            "blink_channel_pairs": [
                [first + 1, second + 1]
                for first, second in self.config.blink_channel_pairs
            ],
            "blink_enabled_channel_pairs": [
                [first + 1, second + 1]
                for first, second in self._blink_enabled_pairs
            ],
            "blink_channel_consensus_fraction": self.config.blink_channel_consensus_fraction,
            "blink_motion_std_threshold": self._blink_motion_std_threshold,
            "blink_adaptive_enabled": self.config.adaptive_blink_baseline,
            "blink_adaptive_updates": self._blink_adaptive_baseline_updates,
            "blink_baseline_health_checks": self._blink_baseline_health_checks,
            "blink_baseline_stale": self._blink_baseline_stale,
            "blink_baseline_scale_ratio": [
                float(self._blink_baseline_scale_ratio[index])
                for index in self.config.blink_eeg_channels
            ],
            "blink_single_channel_rejections": self._blink_single_channel_rejections,
            "blink_invalid_gap_rejections": self._blink_invalid_gap_rejections,
            "blink_gap_recoveries": self._blink_gap_recoveries,
            "alpha_volume_mode": self._alpha_volume_mode,
            "adaptive_updates": self._adaptive_baseline_updates,
            "active_eeg_channels": [
                index + 1 for index in self.config.active_eeg_channels
            ],
            "blink_active_eeg_channels": [
                index + 1 for index in self.config.blink_eeg_channels
            ],
        }

    def _filter(self, eeg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        initialize_blink = not self._filter_initialized
        if not self._filter_initialized:
            for channel in range(4):
                if not self.input_prefiltered:
                    self._main_zi[channel] = sosfilt_zi(self._main_sos) * eeg[channel, 0]
            self._filter_initialized = True

        main = np.empty_like(eeg, dtype=np.float64)
        for channel in range(4):
            if self.input_prefiltered:
                main[channel] = eeg[channel]
            else:
                main[channel], self._main_zi[channel] = sosfilt(
                    self._main_sos, eeg[channel], zi=self._main_zi[channel]
                )
        if initialize_blink:
            for channel in range(4):
                self._blink_zi[channel] = sosfilt_zi(self._blink_sos) * main[channel, 0]
        blink = np.empty_like(main)
        for channel in range(4):
            blink[channel], self._blink_zi[channel] = sosfilt(
                self._blink_sos, main[channel], zi=self._blink_zi[channel]
            )
        return main, blink

    def _append_alpha(self, values: np.ndarray) -> None:
        if values.shape[1] == 0:
            return
        self._alpha_buffer = np.concatenate((self._alpha_buffer, values), axis=1)
        if self._alpha_buffer.shape[1] > self._alpha_window_samples:
            self._alpha_buffer = self._alpha_buffer[:, -self._alpha_window_samples :]

    def _set_alpha_thresholds(self, baseline_values: np.ndarray) -> None:
        assert self._alpha_center is not None
        assert self._alpha_scale is not None
        baseline_quantile = float(
            np.quantile(baseline_values, self.config.alpha_baseline_quantile)
        )
        robust_increment = min(
            self.config.alpha_on_robust_z * self._alpha_scale,
            self.config.alpha_max_threshold_above_center,
        )
        self._alpha_on_threshold = max(
            self.config.alpha_absolute_ratio_floor,
            self._alpha_center + robust_increment,
            baseline_quantile + 0.01,
        )
        self._alpha_off_threshold = max(
            self._alpha_center + self.config.alpha_off_robust_z * self._alpha_scale,
            self._alpha_on_threshold - max(self._alpha_scale, 0.015),
        )

    def _calibrate_alpha_if_ready(
        self, events: list[DemoFlagEvent], time_seconds: float
    ) -> None:
        required = self._required_open_eye_updates()
        if self._alpha_center is not None or len(self._alpha_history) < required:
            return
        values = np.asarray(self._alpha_history[:required], dtype=np.float64)
        self._alpha_center, self._alpha_scale = robust_center_scale(values, minimum_scale=0.008)
        if self.config.adaptive_alpha_threshold:
            self._set_alpha_thresholds(values)
        else:
            quantile_90 = float(np.quantile(values, 0.9))
            self._alpha_on_threshold = max(
                self.config.alpha_absolute_ratio_floor,
                self._alpha_center + self.config.alpha_on_robust_z * self._alpha_scale,
                quantile_90 + 0.01,
            )
            self._alpha_off_threshold = max(
                self._alpha_center
                + self.config.alpha_off_robust_z * self._alpha_scale,
                self._alpha_on_threshold - max(self._alpha_scale, 0.015),
            )
        self._adaptive_alpha_history.extend(float(value) for value in values)
        events.append(DemoFlagEvent("CALIBRATION_COMPLETE", time_seconds))

    def _update_realtime_baseline(self, ratio: float) -> None:
        if (
            self._alpha_center is None
            or self._alpha_scale is None
            or self._alpha_on_threshold is None
            or self._closed_eye_active
            or self._session_active
            or self._alpha_present
            or self._last_alpha_channel_quality
            < self.config.adaptive_baseline_min_quality
        ):
            return
        robust_z = abs(ratio - self._alpha_center) / max(self._alpha_scale, 1e-9)
        if robust_z > self.config.adaptive_baseline_max_robust_z:
            return
        self._adaptive_alpha_history.append(float(ratio))
        self._baseline_update_counter += 1
        required = max(
            1,
            int(
                round(
                    self.config.adaptive_baseline_update_seconds
                    / self.config.alpha_update_seconds
                )
            ),
        )
        if self._baseline_update_counter < required or len(self._adaptive_alpha_history) < 8:
            return
        self._baseline_update_counter = 0
        values = np.asarray(self._adaptive_alpha_history, dtype=np.float64)
        center, scale = robust_center_scale(values, minimum_scale=0.008)
        smoothing = 1.0 - np.exp(
            -self.config.adaptive_baseline_update_seconds
            / self.config.adaptive_baseline_time_constant_seconds
        )
        # This is explicitly an eyes-open reference.  It may follow electrode
        # drift while the user is awake before a session, but it is frozen for
        # the whole sleep session so closed-eye/NREM activity cannot redefine it.
        self._alpha_center += smoothing * (center - self._alpha_center)
        self._alpha_scale += smoothing * (scale - self._alpha_scale)
        self._set_alpha_thresholds(values)
        self._adaptive_baseline_updates += 1

    def _update_closed_eye_reference(
        self, ratio: float, time_seconds: float, events: list[DemoFlagEvent]
    ) -> bool:
        if not self._closed_eye_active:
            return False
        self._closed_eye_history.append(float(ratio))
        required = max(
            1,
            int(
                round(
                    self.config.closed_eye_calibration_seconds
                    / self.config.alpha_update_seconds
                )
            ),
        )
        if len(self._closed_eye_history) < required:
            return True
        assert self._alpha_center is not None
        assert self._alpha_scale is not None
        values = np.asarray(self._closed_eye_history[:required], dtype=np.float64)
        measured = float(np.quantile(values, 0.60))
        self._closed_eye_reference = max(
            measured,
            self._alpha_center + max(3.0 * self._alpha_scale, 0.05),
        )
        self._closed_eye_active = False
        events.append(
            DemoFlagEvent(
                "CLOSED_EYE_CALIBRATION_COMPLETE",
                time_seconds,
                self._closed_eye_reference,
            )
        )
        return True

    def _select_alpha_channels(self) -> float:
        ratios, qualities, usable = alpha_channel_features(
            self._alpha_buffer,
            self.config.sample_rate_hz,
            self.config.active_eeg_channels,
        )
        if not usable.any():
            self._last_alpha_channel_quality = 0.0
            return float("nan")

        if not self.config.adaptive_channel_selection:
            candidates = np.flatnonzero(usable)
            ratio_ranked = candidates[np.argsort(ratios[candidates])[::-1]]
            selected = tuple(
                sorted(int(value) for value in ratio_ranked[: min(2, ratio_ranked.size)])
            )
            previous = self._selected_alpha_channel_indices
            if previous and selected != previous:
                self._alpha_channel_switches += 1
            self._selected_alpha_channel_indices = selected
            self._selected_alpha_channel_weights = tuple(
                1.0 / len(selected) for _ in selected
            )
            self._last_selected_alpha_ratios = ratios[list(selected)].copy()
            self._last_alpha_channel_quality = float(
                usable[list(self.config.active_eeg_channels)].mean()
            )
            return float(np.mean(ratios[list(selected)]))

        smoothing = 1.0 - np.exp(
            -self.config.alpha_update_seconds
            / self.config.alpha_channel_quality_ema_seconds
        )
        if not self._alpha_channel_quality_initialized:
            self._alpha_channel_quality_ema = qualities.copy()
            self._alpha_channel_quality_initialized = True
        else:
            self._alpha_channel_quality_ema += smoothing * (
                qualities - self._alpha_channel_quality_ema
            )

        eligible = usable & (
            self._alpha_channel_quality_ema >= self.config.alpha_min_channel_quality
        )
        if not eligible.any():
            eligible = usable.copy()
        scores = self._alpha_channel_quality_ema * (
            0.35 + np.nan_to_num(ratios, nan=0.0)
        )
        candidates = np.flatnonzero(eligible)
        ranked = candidates[np.argsort(scores[candidates])[::-1]]
        candidate = tuple(sorted(int(value) for value in ranked[: min(2, ranked.size)]))

        previous = self._selected_alpha_channel_indices
        if not previous or not all(eligible[index] for index in previous):
            if previous and candidate != previous:
                self._alpha_channel_switches += 1
            self._selected_alpha_channel_indices = candidate
            self._pending_alpha_channel_indices = ()
            self._pending_alpha_channel_updates = 0
        elif candidate != previous:
            current_score = float(np.sum(scores[list(previous)]))
            candidate_score = float(np.sum(scores[list(candidate)]))
            materially_better = candidate_score > current_score * (
                1.0 + self.config.alpha_channel_switch_margin
            )
            if materially_better:
                if candidate == self._pending_alpha_channel_indices:
                    self._pending_alpha_channel_updates += 1
                else:
                    self._pending_alpha_channel_indices = candidate
                    self._pending_alpha_channel_updates = 1
                required = max(
                    1,
                    int(
                        round(
                            self.config.alpha_channel_switch_hold_seconds
                            / self.config.alpha_update_seconds
                        )
                    ),
                )
                if self._pending_alpha_channel_updates >= required:
                    self._selected_alpha_channel_indices = candidate
                    self._alpha_channel_switches += 1
                    self._pending_alpha_channel_indices = ()
                    self._pending_alpha_channel_updates = 0
            else:
                self._pending_alpha_channel_indices = ()
                self._pending_alpha_channel_updates = 0
        else:
            self._pending_alpha_channel_indices = ()
            self._pending_alpha_channel_updates = 0

        selected = self._selected_alpha_channel_indices
        if not selected:
            self._last_alpha_channel_quality = 0.0
            return float("nan")
        raw_weights = np.maximum(
            self._alpha_channel_quality_ema[list(selected)], 1e-6
        )
        weights = raw_weights / raw_weights.sum()
        selected_ratios = ratios[list(selected)]
        finite = np.isfinite(selected_ratios)
        if not finite.any():
            self._last_alpha_channel_quality = 0.0
            return float("nan")
        weights = weights[finite]
        weights /= weights.sum()
        selected_ratios = selected_ratios[finite]
        selected_indices = tuple(
            index for index, keep in zip(selected, finite, strict=True) if keep
        )
        self._selected_alpha_channel_indices = selected_indices
        self._selected_alpha_channel_weights = tuple(float(value) for value in weights)
        self._last_selected_alpha_ratios = selected_ratios.copy()
        self._last_alpha_channel_quality = float(
            np.sum(qualities[list(selected_indices)] * weights)
        )
        return float(np.sum(selected_ratios * weights))

    def _apply_alpha_volume_level(self) -> None:
        if self._last_alpha_level is None:
            return
        if self._alpha_volume_mode == "smooth":
            self._alpha_step = 0
            self._pending_alpha_step = 0
            self._pending_alpha_step_updates = 0
            self._recommended_volume = (
                float(np.clip(self._last_alpha_level, 0.0, 1.0))
                if self._alpha_music_started
                else 0.0
            )
            return

        count = self._alpha_step_count
        level = float(np.clip(self._last_alpha_level, 0.0, 1.0))
        candidate = min(count, int(np.floor(level * count)) + 1)
        hysteresis = min(self.config.alpha_step_hysteresis, 0.35 / count)
        if self._alpha_step > 0:
            lower = (self._alpha_step - 1) / count
            upper = self._alpha_step / count
            if lower - hysteresis <= level <= upper + hysteresis:
                candidate = self._alpha_step
        if candidate == self._pending_alpha_step:
            self._pending_alpha_step_updates += 1
        else:
            self._pending_alpha_step = candidate
            self._pending_alpha_step_updates = 1
        required = max(
            1,
            int(
                round(
                    self.config.alpha_step_hold_seconds
                    / self.config.alpha_update_seconds
                )
            ),
        )
        if self._alpha_step == 0 or self._pending_alpha_step_updates >= required:
            self._alpha_step = candidate
            self._pending_alpha_step_updates = 0
        if not self._alpha_music_started:
            self._recommended_volume = 0.0
        elif count == 3:
            self._recommended_volume = float(
                self.config.alpha_step_volume_levels[self._alpha_step - 1]
            )
        else:
            self._recommended_volume = self._alpha_step / count

    def _update_alpha_level(self, ratio: float) -> None:
        if self._alpha_on_threshold is None or self._alpha_off_threshold is None:
            return
        if self._closed_eye_reference is not None and self._alpha_center is not None:
            lower_reference = self._alpha_center
            upper_reference = self._closed_eye_reference
        else:
            lower_reference = self._alpha_off_threshold
            upper_reference = max(
                self._alpha_peak if self._alpha_music_started else 0.0,
                self._alpha_on_threshold,
            )
        span = max(upper_reference - lower_reference, 0.015)
        raw_level = float(
            np.clip((ratio - lower_reference) / span, 0.0, 1.0)
        )
        if self._last_alpha_level is None:
            self._last_alpha_level = raw_level
        else:
            smoothing = 1.0 - np.exp(
                -self.config.alpha_update_seconds / self.config.alpha_level_ema_seconds
            )
            self._last_alpha_level += smoothing * (raw_level - self._last_alpha_level)
        self._apply_alpha_volume_level()

    def _update_alpha(self, time_seconds: float, events: list[DemoFlagEvent]) -> None:
        ratio = self._select_alpha_channels()
        if not np.isfinite(ratio):
            return
        self._last_alpha_ratio = ratio
        if self._alpha_center is None:
            self._alpha_history.append(ratio)
            self._calibrate_alpha_if_ready(events, time_seconds)
            return

        if self._update_closed_eye_reference(ratio, time_seconds, events):
            self._last_alpha_level = None
            self._alpha_step = 0
            self._recommended_volume = 0.0
            return

        assert self._alpha_scale is not None
        assert self._alpha_on_threshold is not None
        assert self._alpha_off_threshold is not None
        robust_z = (ratio - self._alpha_center) / self._alpha_scale
        self._last_alpha_score = float(1.0 / (1.0 + np.exp(-np.clip(robust_z - 1.0, -20.0, 20.0))))
        self._update_realtime_baseline(ratio)
        self._update_alpha_level(ratio)
        on_updates = max(1, int(round(self.config.alpha_on_hold_seconds / self.config.alpha_update_seconds)))
        decay_updates = max(
            1, int(round(self.config.alpha_decay_hold_seconds / self.config.alpha_update_seconds))
        )

        if not self._alpha_present:
            required_consensus = min(
                self.config.alpha_min_consensus_channels,
                len(self._last_selected_alpha_ratios),
            )
            consensus = int(
                np.sum(
                    self._last_selected_alpha_ratios
                    >= self._alpha_on_threshold
                    * self.config.alpha_consensus_threshold_fraction
                )
            )
            if ratio >= self._alpha_on_threshold and consensus >= required_consensus:
                self._alpha_on_counter += 1
            else:
                self._alpha_on_counter = 0
            if self._alpha_on_counter >= on_updates:
                self._alpha_present = True
                self._alpha_active_updates = 0
                self._alpha_decay_counter = 0
                self._alpha_peak = ratio
                first_music_start = not self._alpha_music_started
                self._alpha_music_started = True
                if first_music_start:
                    self._update_alpha_level(ratio)
                    events.append(DemoFlagEvent("PLAY_MUSIC_ALPHA", time_seconds, ratio))
        else:
            self._alpha_active_updates += 1
            self._alpha_peak = max(self._alpha_peak, ratio)
            minimum_updates = int(
                round(self.config.alpha_min_active_seconds / self.config.alpha_update_seconds)
            )
            decay_level = max(
                self._alpha_off_threshold,
                self._alpha_peak * self.config.alpha_decay_peak_fraction,
            )
            if self._alpha_active_updates >= minimum_updates and ratio <= decay_level:
                self._alpha_decay_counter += 1
            else:
                self._alpha_decay_counter = 0
            if self._alpha_decay_counter >= decay_updates:
                self._alpha_present = False
                self._alpha_on_counter = 0
                self._alpha_decay_counter = 0
                events.append(DemoFlagEvent("LOWER_VOLUME_ALPHA_DECAY", time_seconds, ratio))

    def _calibrate_blink(
        self,
        blink: np.ndarray,
        time_seconds: float,
        events: list[DemoFlagEvent],
        motion_magnitude: np.ndarray | None = None,
    ) -> None:
        if self._blink_calibrated or not self._blink_calibration_active:
            return
        quiet_required = max(
            1,
            int(
                round(
                    self.config.blink_quiet_baseline_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        blink_required = max(
            1,
            int(round(self.config.blink_calibration_seconds * self.config.sample_rate_hz)),
        )
        required = quiet_required + blink_required
        remaining = required - self._blink_calibration_samples
        take = min(blink.shape[1], remaining)
        for channel in self.config.blink_eeg_channels:
            self._blink_calibration[channel].extend(
                blink[channel, :take].tolist()
            )
        if motion_magnitude is not None:
            self._blink_motion_calibration.extend(
                np.asarray(motion_magnitude[:take], dtype=np.float64).tolist()
            )
        self._blink_calibration_samples += take
        if self._blink_calibration_samples < required:
            return
        active_indices = list(self.config.blink_eeg_channels)
        full_calibration = np.asarray(
            [self._blink_calibration[channel] for channel in active_indices],
            dtype=np.float64,
        )
        quiet_baseline = full_calibration[:, :quiet_required]
        calibration = full_calibration[:, quiet_required:]
        for local_channel, channel in enumerate(active_indices):
            values = quiet_baseline[local_channel]
            self._blink_center[channel], self._blink_scale[channel] = robust_center_scale(
                values, minimum_scale=max(float(np.std(values)) * 0.05, 1e-3)
            )
        signed = (
            calibration - self._blink_center[active_indices, None]
        ) / self._blink_scale[active_indices, None]
        standardized = np.abs(signed)
        local_lookup = {
            channel: local_index
            for local_index, channel in enumerate(active_indices)
        }
        pair_local_indices = [
            (local_lookup[first], local_lookup[second])
            for first, second in self.config.blink_channel_pairs
        ]
        pair_primary = np.asarray(
            [
                np.max(standardized[list(pair)], axis=0)
                for pair in pair_local_indices
            ]
        )
        pair_secondary = np.asarray(
            [
                np.min(standardized[list(pair)], axis=0)
                for pair in pair_local_indices
            ]
        )
        pair_fused = np.sqrt(np.maximum(pair_primary * pair_secondary, 0.0))
        winning_pairs = np.argmax(pair_fused, axis=0)
        sample_indices = np.arange(calibration.shape[1])
        primary_scores = pair_primary[winning_pairs, sample_indices]
        secondary_scores = pair_secondary[winning_pairs, sample_indices]
        fused_scores = pair_fused[winning_pairs, sample_indices]
        minimum_distance = max(
            1,
            int(round(self.config.blink_refractory_seconds * self.config.sample_rate_hz)),
        )
        candidate_peaks, _ = find_peaks(
            fused_scores,
            height=2.0,
            prominence=0.8,
            distance=minimum_distance,
            width=(
                max(1, int(round(0.025 * self.config.sample_rate_hz))),
                max(2, int(round(0.80 * self.config.sample_rate_hz))),
            ),
        )
        # Calibration must show a real paired response, not a very strong
        # single-channel pulse multiplied by ordinary noise on its partner.
        secondary_floor = max(
            2.0,
            2.0 * self.config.blink_channel_consensus_fraction,
        )
        consensus = np.sum(
            pair_secondary >= secondary_floor,
            axis=0,
        )
        pair_support = (
            pair_secondary[:, candidate_peaks] >= secondary_floor
        ) & (pair_fused[:, candidate_peaks] >= 2.0)
        minimum_pair_peaks = 5
        enabled_pair_indices = [
            index
            for index in range(len(self.config.blink_channel_pairs))
            if int(np.count_nonzero(pair_support[index])) >= minimum_pair_peaks
        ]
        self._blink_enabled_pairs = tuple(
            self.config.blink_channel_pairs[index]
            for index in enabled_pair_indices
        )
        dual_channel = (
            np.any(pair_support[enabled_pair_indices], axis=0)
            if enabled_pair_indices
            else np.zeros(candidate_peaks.size, dtype=bool)
        )
        peaks = candidate_peaks[dual_channel]
        self._blink_calibration_consensus = float(
            peaks.size / max(candidate_peaks.size, 1)
        )
        self._blink_calibration_peak_count = int(peaks.size)
        self._blink_calibration_active = False
        if peaks.size < 5:
            events.append(
                DemoFlagEvent(
                    "BLINK_CALIBRATION_FAILED",
                    time_seconds,
                    int(peaks.size),
                )
            )
            return

        strengths = fused_scores[peaks]
        widths = peak_widths(fused_scores, peaks, rel_height=0.5)[0]
        peak_channels = np.argmax(standardized[:, peaks], axis=0)
        polarities = np.sign(signed[peak_channels, peaks]).astype(np.int8)
        positive_fraction = float(np.mean(polarities > 0))
        negative_fraction = float(np.mean(polarities < 0))
        if max(positive_fraction, negative_fraction) >= 0.60:
            self._blink_calibration_polarity = (
                1 if positive_fraction >= negative_fraction else -1
            )
        self._blink_calibration_strength_z = float(np.median(strengths))
        self._blink_calibration_width_seconds = float(
            np.median(widths) / self.config.sample_rate_hz
        )
        if peaks.size >= 2:
            self._blink_calibration_interval_seconds = float(
                np.median(np.diff(peaks)) / self.config.sample_rate_hz
            )
        # Headband orientation and reference contact can invert individual
        # channels. Polarity remains diagnostic, while simultaneous response in
        # at least two of EEG1-EEG4 is the hard calibration requirement.
        feature_pattern_valid = (
            len(active_indices) >= self.config.blink_minimum_consensus_channels
            and self._blink_calibration_consensus
            >= self.config.blink_calibration_minimum_consensus
            and self._blink_calibration_strength_z
            >= self.config.blink_calibration_minimum_strength_z
        )
        if not feature_pattern_valid:
            events.append(
                DemoFlagEvent(
                    "BLINK_CALIBRATION_FAILED",
                    time_seconds,
                    int(peaks.size),
                )
            )
            return
        if self._blink_motion_calibration:
            motion = np.asarray(self._blink_motion_calibration, dtype=np.float64)
            motion_window = max(
                2,
                int(
                    round(
                        self.config.blink_motion_window_seconds
                        * self.config.sample_rate_hz
                    )
                ),
            )
            motion_step = max(1, motion_window // 2)
            motion_stds = [
                float(np.std(motion[start : start + motion_window]))
                for start in range(0, max(1, motion.size - motion_window + 1), motion_step)
                if motion[start : start + motion_window].size >= 2
            ]
            if motion_stds:
                learned_motion = float(np.quantile(motion_stds, 0.90)) * 2.5
                self._blink_motion_std_threshold = float(
                    np.clip(
                        max(self.config.blink_max_acceleration_std, learned_motion),
                        self.config.blink_max_acceleration_std,
                        2000.0,
                    )
                )
        lower_strength = float(np.quantile(strengths, 0.25))
        # EEG3+EEG4 is much stronger on the current headset. When that pair is
        # calibrated, cap the operational threshold so the naturally smaller
        # fourth/fifth blink remains detectable. A legacy EEG1+EEG2-only fit
        # keeps the older, more conservative rule to reject filter tails.
        auxiliary_pair_enabled = (2, 3) in self._blink_enabled_pairs
        threshold_factor = 0.30 if auxiliary_pair_enabled else 0.45
        threshold_ceiling = 3.25 if auxiliary_pair_enabled else 6.0
        self._blink_threshold_z = float(
            np.clip(
                lower_strength * threshold_factor,
                2.5,
                threshold_ceiling,
            )
        )
        self._blink_rearm_z = float(
            np.clip(self._blink_threshold_z * 0.45, 0.8, 1.8)
        )
        # A peak that clears the wearer-specific detection threshold is allowed
        # into the timing gesture.  Requiring a second, higher amplitude gate
        # previously dropped the third/fourth blink as the causal filter settled.
        self._gesture_min_peak_z = self._blink_threshold_z
        for local_channel, channel in enumerate(active_indices):
            self._adaptive_blink_history[channel].extend(
                float(value) for value in quiet_baseline[local_channel]
            )
        self._blink_adaptive_last_update_sample = int(
            round(time_seconds * self.config.sample_rate_hz)
        )
        self._blink_calibrated = True
        self._blink_candidate_start_sample = None
        self._pending_blink_candidates.clear()
        self._blink_times.clear()
        self._blink_amplitudes.clear()
        self._blink_detection_resume_sample = int(
            round(
                (
                    time_seconds
                    + self.config.blink_post_calibration_guard_seconds
                )
                * self.config.sample_rate_hz
            )
        )
        events.append(
            DemoFlagEvent(
                "BLINK_CALIBRATION_COMPLETE",
                time_seconds,
                int(peaks.size),
            )
        )

    def _finalize_gesture(self, now_seconds: float, events: list[DemoFlagEvent]) -> None:
        if not self._blink_times:
            return
        gap = now_seconds - self._blink_times[-1]
        if gap < self._gesture_end_gap_limit_seconds():
            return
        count = len(self._blink_times)
        weak_fourth_tail = False
        if count == 4 and len(self._blink_amplitudes) == 4:
            first_three_reference = float(
                np.median(np.asarray(list(self._blink_amplitudes)[:3]))
            )
            weak_fourth_tail = (
                self._blink_amplitudes[-1]
                / max(first_three_reference, 1e-9)
                < self.config.gesture_continuation_min_amplitude_ratio
            )
        if (
            (count == 3 or weak_fourth_tail)
            and now_seconds >= self._gesture_cooldown_until
            and self._gesture_motion_ok()
        ):
            events.append(DemoFlagEvent("BLINK_3", now_seconds, 3))
            events.append(DemoFlagEvent("VOLUME_DOWN_3_BLINKS", now_seconds, 3))
            self._gesture_cooldown_until = now_seconds + self.config.gesture_cooldown_seconds
        self._blink_times.clear()
        self._blink_amplitudes.clear()
        self._gesture_polarity = 0

    def _gesture_max_interval_limit_seconds(self) -> float:
        """Return a wearer-aware upper bound between consecutive blinks."""

        learned = self._blink_calibration_interval_seconds
        if learned is None or not np.isfinite(learned):
            return self.config.gesture_max_interval_seconds
        # Deliberate continuous blinks should stay rhythmic.  Allow slower
        # wearers than the default while keeping unrelated natural blinks from
        # merging into a command over more than 1.8 seconds.
        learned_limit = float(
            np.clip(
                learned * 2.25,
                self.config.gesture_max_interval_seconds,
                self.config.gesture_adaptive_max_interval_seconds,
            )
        )
        return max(self.config.gesture_max_interval_seconds, learned_limit)

    def _gesture_min_interval_limit_seconds(self) -> float:
        """Reject the opposite lobe/ringing of one blink as a second blink."""

        learned = self._blink_calibration_interval_seconds
        if learned is None or not np.isfinite(learned):
            return self.config.gesture_min_interval_seconds
        learned_floor = float(np.clip(learned * 0.65, 0.0, 0.50))
        return max(self.config.gesture_min_interval_seconds, learned_floor)

    def _gesture_end_gap_limit_seconds(self) -> float:
        """Keep three-blink finalization strictly after the five-blink window."""

        return max(
            self.config.gesture_end_gap_seconds,
            self._gesture_max_interval_limit_seconds() + 0.25,
        )

    def _gesture_motion_ok(self) -> bool:
        if not self._imu_motion_available or len(self._imu_motion_history) < 2:
            return True
        return (
            float(np.std(np.asarray(self._imu_motion_history, dtype=np.float64)))
            <= self._blink_motion_std_threshold
        )

    def _register_blink(
        self,
        time_seconds: float,
        polarity: int,
        amplitude: float,
        width_seconds: float,
        gesture_eligible: bool,
        events: list[DemoFlagEvent],
    ) -> None:
        self._last_blink_strength_z = float(amplitude)
        self._last_blink_width_seconds = float(width_seconds)
        if time_seconds < self._gesture_cooldown_until:
            return
        if not gesture_eligible:
            events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
            return
        if amplitude < self._gesture_min_peak_z:
            events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
            return
        if self._blink_times:
            interval = time_seconds - self._blink_times[-1]
            if interval < self._gesture_min_interval_limit_seconds():
                return
            expected_interval = self._blink_calibration_interval_seconds
            last_invalid_seconds = (
                self._last_blink_invalid_sample / self.config.sample_rate_hz
            )
            if (
                len(self._blink_times) >= 2
                and expected_interval is not None
                and expected_interval > 0.0
                and self._blink_times[-1]
                < last_invalid_seconds
                < time_seconds
                and self.config.gesture_gap_recovery_ratio_min
                <= interval / expected_interval
                <= self.config.gesture_gap_recovery_ratio_max
            ):
                recovered_time = self._blink_times[-1] + interval / 2.0
                recovered_amplitude = float(
                    np.sqrt(
                        max(self._blink_amplitudes[-1] * amplitude, 0.0)
                    )
                )
                self._blink_times.append(recovered_time)
                self._blink_amplitudes.append(recovered_amplitude)
                self._blink_gap_recoveries += 1
                interval = time_seconds - self._blink_times[-1]
            if interval > self._gesture_max_interval_limit_seconds():
                self._blink_times.clear()
                self._blink_amplitudes.clear()
                self._gesture_polarity = 0
        if self._blink_times and time_seconds - self._blink_times[-1] > self.config.gesture_window_seconds:
            self._blink_times.clear()
            self._blink_amplitudes.clear()
            self._gesture_polarity = 0
        if not self._blink_times:
            self._gesture_polarity = polarity
        if len(self._blink_amplitudes) >= 2:
            reference_amplitude = float(np.median(self._blink_amplitudes))
            amplitude_ratio = amplitude / max(reference_amplitude, 1e-9)
            if not (
                self.config.gesture_min_amplitude_ratio
                <= amplitude_ratio
                <= self.config.gesture_max_amplitude_ratio
            ):
                events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
                return
        self._blink_times.append(time_seconds)
        self._blink_amplitudes.append(amplitude)
        while self._blink_times and time_seconds - self._blink_times[0] > self.config.gesture_window_seconds:
            self._blink_times.popleft()
            self._blink_amplitudes.popleft()
        if len(self._blink_times) >= 3:
            intervals = np.diff(np.asarray(self._blink_times, dtype=np.float64))
            if float(intervals.max() - intervals.min()) > self.config.gesture_max_interval_jitter_seconds:
                if len(self._blink_times) == 4:
                    first_three_reference = float(
                        np.median(np.asarray(list(self._blink_amplitudes)[:3]))
                    )
                    weak_fourth_tail = (
                        self._blink_amplitudes[-1]
                        / max(first_three_reference, 1e-9)
                        < self.config.gesture_continuation_min_amplitude_ratio
                    )
                    if weak_fourth_tail:
                        self._blink_times.pop()
                        self._blink_amplitudes.pop()
                        events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
                        return
                latest = self._blink_times[-1]
                latest_amplitude = self._blink_amplitudes[-1]
                self._blink_times.clear()
                self._blink_amplitudes.clear()
                self._blink_times.append(latest)
                self._blink_amplitudes.append(latest_amplitude)
                events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
                return
        events.append(DemoFlagEvent("BLINK", time_seconds, amplitude))
        if len(self._blink_times) >= 5:
            if self._gesture_motion_ok():
                events.append(DemoFlagEvent("BLINK_5", time_seconds, 5))
                events.append(DemoFlagEvent("VOLUME_UP_5_BLINKS", time_seconds, 5))
            self._blink_times.clear()
            self._blink_amplitudes.clear()
            self._gesture_polarity = 0
            self._gesture_cooldown_until = time_seconds + self.config.gesture_cooldown_seconds

    def _update_blink_adaptive_baseline(
        self,
        blink: np.ndarray,
        standardized: np.ndarray,
        valid: np.ndarray,
        global_end: int,
    ) -> None:
        """Monitor baseline drift; optional adaptation is disabled by default."""

        if (
            not self._blink_calibrated
            or not self._gesture_motion_ok()
        ):
            return
        active_indices = list(self.config.blink_eeg_channels)
        secondary = np.max(
            np.asarray(
                [
                    np.min(standardized[list(pair)], axis=0)
                    for pair in self._blink_enabled_pairs
                ]
            ),
            axis=0,
        )
        dual_floor = (
            self._blink_threshold_z
            * self.config.blink_channel_consensus_fraction
        )
        background = np.asarray(valid, dtype=bool) & (secondary < dual_floor)
        if background.any():
            for channel in active_indices:
                self._adaptive_blink_history[channel].extend(
                    float(value) for value in blink[channel, background]
                )

        update_samples = max(
            1,
            int(
                round(
                    self.config.blink_adaptive_update_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        if global_end - self._blink_adaptive_last_update_sample < update_samples:
            return
        minimum_samples = max(
            1,
            int(
                round(
                    self.config.blink_adaptive_minimum_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        if any(
            len(self._adaptive_blink_history[channel]) < minimum_samples
            for channel in active_indices
        ):
            return

        health_bad = False
        targets: list[tuple[int, float, float]] = []
        for channel in active_indices:
            values = np.asarray(
                self._adaptive_blink_history[channel], dtype=np.float64
            )
            center = float(np.median(values))
            mad_scale = 1.4826 * float(np.median(np.abs(values - center)))
            quantile_scale = float(
                (np.quantile(values, 0.90) - np.quantile(values, 0.10))
                / 2.5631
            )
            target_scale = max(mad_scale, quantile_scale, 1e-3)
            current_scale = max(float(self._blink_scale[channel]), 1e-3)
            scale_ratio = float(target_scale / current_scale)
            center_shift_z = float(
                abs(center - self._blink_center[channel]) / current_scale
            )
            self._blink_baseline_scale_ratio[channel] = scale_ratio
            if (
                scale_ratio < self.config.blink_baseline_health_scale_ratio_min
                or scale_ratio > self.config.blink_baseline_health_scale_ratio_max
                or center_shift_z
                > self.config.blink_baseline_health_center_shift_z_max
            ):
                health_bad = True
            targets.append((channel, center, target_scale))

        self._blink_baseline_health_checks += 1
        if health_bad:
            self._blink_baseline_health_failures += 1
        else:
            self._blink_baseline_health_failures = 0
        if (
            self._blink_baseline_health_failures
            >= self.config.blink_baseline_health_failures_required
        ):
            self._blink_baseline_stale = True
            self._blink_times.clear()
            self._blink_amplitudes.clear()
            self._pending_blink_candidates.clear()

        if self.config.adaptive_blink_baseline and not self._blink_baseline_stale:
            smoothing = 1.0 - np.exp(
                -self.config.blink_adaptive_update_seconds
                / self.config.blink_adaptive_time_constant_seconds
            )
            for channel, center, target_scale in targets:
                current_scale = max(float(self._blink_scale[channel]), 1e-3)
                guarded_scale = float(
                    np.clip(
                        target_scale,
                        current_scale * 0.50,
                        current_scale * 2.00,
                    )
                )
                guarded_center = float(
                    np.clip(
                        center,
                        self._blink_center[channel] - 2.0 * current_scale,
                        self._blink_center[channel] + 2.0 * current_scale,
                    )
                )
                self._blink_center[channel] += smoothing * (
                    guarded_center - self._blink_center[channel]
                )
                self._blink_scale[channel] += smoothing * (
                    guarded_scale - self._blink_scale[channel]
                )
            self._blink_adaptive_baseline_updates += 1
        self._blink_adaptive_last_update_sample = global_end

    def _detect_blinks(
        self,
        blink: np.ndarray,
        global_start: int,
        events: list[DemoFlagEvent],
        valid: np.ndarray | None = None,
    ) -> None:
        if not self._blink_calibrated:
            return
        signed_standardized = (
            blink - self._blink_center[:, None]
        ) / self._blink_scale[:, None]
        standardized = np.abs(signed_standardized)
        channel_energy = np.std(blink, axis=1)
        active = np.zeros(4, dtype=bool)
        active[list(self.config.blink_eeg_channels)] = True
        usable = active & (
            channel_energy > np.maximum(self._blink_scale * 0.05, 1e-6)
        )
        usable_pairs = [
            pair
            for pair in self._blink_enabled_pairs
            if usable[pair[0]] and usable[pair[1]]
        ]
        if not usable_pairs:
            self._blink_score_previous_2 = 0.0
            self._blink_score_previous_1 = 0.0
            self._blink_fused_score_previous_1 = 0.0
            self._blink_secondary_score_previous_1 = 0.0
            return
        pair_primary = np.asarray(
            [
                np.max(standardized[list(pair)], axis=0)
                for pair in usable_pairs
            ]
        )
        pair_secondary = np.asarray(
            [
                np.min(standardized[list(pair)], axis=0)
                for pair in usable_pairs
            ]
        )
        pair_fused = np.sqrt(np.maximum(pair_primary * pair_secondary, 0.0))
        winning_pairs = np.argmax(pair_fused, axis=0)
        sample_indices = np.arange(blink.shape[1])
        primary_scores = pair_primary[winning_pairs, sample_indices]
        secondary_scores = pair_secondary[winning_pairs, sample_indices]
        fused_scores = pair_fused[winning_pairs, sample_indices]
        winning_pair_channels = np.asarray(usable_pairs, dtype=np.int64)[winning_pairs]
        winning_pair_values = standardized[
            winning_pair_channels,
            sample_indices[:, None],
        ]
        winning_local_channels = np.argmax(winning_pair_values, axis=1)
        primary_channel_indices = winning_pair_channels[
            sample_indices,
            winning_local_channels,
        ]
        polarities = np.sign(
            signed_standardized[
                primary_channel_indices,
                sample_indices,
            ]
        ).astype(np.int8)
        secondary_floor = (
            self._blink_threshold_z
            * self.config.blink_channel_consensus_fraction
        )
        consensus = np.where(secondary_scores >= secondary_floor, 2, 0)
        validity = (
            np.ones(blink.shape[1], dtype=bool)
            if valid is None
            else np.asarray(valid, dtype=bool)
        )
        self._update_blink_adaptive_baseline(
            blink,
            standardized,
            validity,
            global_start + blink.shape[1],
        )
        if self._blink_baseline_stale:
            self._blink_times.clear()
            self._blink_amplitudes.clear()
            self._pending_blink_candidates.clear()
            return
        refractory = int(round(self.config.blink_refractory_seconds * self.config.sample_rate_hz))
        invalid_guard = max(
            1,
            int(
                round(
                    self.config.blink_invalid_guard_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        expected_width = self._blink_calibration_width_seconds or 0.12
        gap_reset_samples = max(
            1,
            int(
                round(
                    self.config.blink_gesture_gap_reset_seconds
                    * self.config.sample_rate_hz
                )
            ),
        )
        # Peak timing follows the paired fused envelope, not the strongest
        # individual channel. This prevents a one-channel spike from shifting
        # the shared blink peak and corrupting the inter-blink rhythm.
        for local_index, primary_score in enumerate(fused_scores):
            sample_index = global_start + local_index
            time_seconds = sample_index / self.config.sample_rate_hz
            current_valid = bool(validity[local_index])
            if not current_valid:
                self._last_blink_invalid_sample = sample_index
                self._consecutive_invalid_blink_samples += 1
                if self._consecutive_invalid_blink_samples >= gap_reset_samples:
                    self._blink_times.clear()
                    self._blink_amplitudes.clear()
                    self._gesture_polarity = 0
            else:
                self._consecutive_invalid_blink_samples = 0

            if sample_index < self._blink_detection_resume_sample:
                self._blink_score_previous_2 = self._blink_score_previous_1
                self._blink_score_previous_1 = float(primary_score)
                self._blink_fused_score_previous_1 = float(
                    fused_scores[local_index]
                )
                self._blink_secondary_score_previous_1 = float(
                    secondary_scores[local_index]
                )
                self._blink_polarity_previous_1 = int(polarities[local_index])
                self._blink_consensus_previous_1 = int(consensus[local_index])
                self._blink_valid_previous_1 = current_valid
                continue

            # Keep a short output delay, but do not retroactively reject a peak
            # because a later BLE packet was lost. The causal filter cannot be
            # contaminated by future samples; only the recovery period after a
            # known gap is unsafe. Retroactive rejection was erasing one blink
            # from otherwise clean five-blink groups.
            while (
                self._pending_blink_candidates
                and self._pending_blink_candidates[0][0] <= sample_index
            ):
                (
                    _due_sample,
                    pending_peak_sample,
                    pending_polarity,
                    pending_score,
                    pending_width,
                ) = self._pending_blink_candidates.popleft()
                if self._gesture_motion_ok():
                    self._register_blink(
                        pending_peak_sample / self.config.sample_rate_hz,
                        pending_polarity,
                        pending_score,
                        pending_width,
                        True,
                        events,
                    )
            if (
                self._blink_score_previous_1 >= self._blink_threshold_z
                and self._blink_score_previous_1 >= self._blink_score_previous_2
                and self._blink_score_previous_1 > primary_score
                and sample_index - 1 - self._last_blink_sample >= refractory
            ):
                peak_sample = sample_index - 1
                peak_score = self._blink_fused_score_previous_1
                self._last_blink_sample = peak_sample
                transport_valid = (
                    self._blink_valid_previous_1
                    and peak_sample - self._last_blink_invalid_sample >= invalid_guard
                )
                dual_channel_valid = transport_valid and (
                    self._blink_consensus_previous_1
                    >= self.config.blink_minimum_consensus_channels
                    and self._blink_secondary_score_previous_1
                    >= secondary_floor
                    and peak_score >= self._blink_threshold_z
                )
                if not transport_valid:
                    self._blink_invalid_gap_rejections += 1
                elif not dual_channel_valid:
                    self._blink_single_channel_rejections += 1
                else:
                    self._pending_blink_candidates.append(
                        (
                            peak_sample + invalid_guard,
                            peak_sample,
                            self._blink_polarity_previous_1,
                            peak_score,
                            expected_width,
                        )
                    )
            self._blink_score_previous_2 = self._blink_score_previous_1
            self._blink_score_previous_1 = float(primary_score)
            self._blink_fused_score_previous_1 = float(fused_scores[local_index])
            self._blink_secondary_score_previous_1 = float(
                secondary_scores[local_index]
            )
            self._blink_polarity_previous_1 = int(polarities[local_index])
            self._blink_consensus_previous_1 = int(consensus[local_index])
            self._blink_valid_previous_1 = current_valid
            self._finalize_gesture(time_seconds, events)

    def stream_step(
        self,
        eeg: np.ndarray,
        imu: np.ndarray | None = None,
        valid: np.ndarray | None = None,
    ) -> DemoFlagOutput:
        values = np.array(eeg, dtype=np.float64, copy=True)
        if values.ndim != 2 or values.shape[0] != 4:
            raise ValueError("eeg must have shape [4, samples]")
        if values.shape[1] == 0:
            raise ValueError("eeg chunk must not be empty")
        motion_magnitude: np.ndarray | None = None
        if imu is not None:
            acceleration = np.asarray(imu)
            if acceleration.ndim != 2 or acceleration.shape[1] != values.shape[1]:
                raise ValueError("imu must have shape [channels, samples]")
            if acceleration.shape[0] >= 3:
                motion_magnitude = np.sqrt(
                    np.square(acceleration[:3], dtype=np.float64).sum(axis=0)
                )
                self._imu_motion_history.extend(
                    float(value) for value in motion_magnitude
                )
                self._imu_motion_available = True
        if valid is None:
            validity = np.ones(values.shape[1], dtype=bool)
        else:
            validity = np.array(valid, dtype=bool, copy=True)
            if validity.shape != (values.shape[1],):
                raise ValueError("valid must have shape [samples]")
        finite = np.isfinite(values).all(axis=0)
        validity &= finite
        if not validity.all():
            for index in np.flatnonzero(~validity):
                if index > 0:
                    values[:, index] = values[:, index - 1]
                elif self._last_valid_raw_eeg is not None:
                    values[:, index] = self._last_valid_raw_eeg
                else:
                    values[:, index] = 0.0
        self._last_valid_raw_eeg = values[:, -1].copy()

        global_start = self._samples_seen
        filtered, blink = self._filter(values)
        events: list[DemoFlagEvent] = []
        blink_calibration_was_active = self._blink_calibration_active
        self._calibrate_blink(
            blink,
            (global_start + values.shape[1]) / self.config.sample_rate_hz,
            events,
            motion_magnitude,
        )
        if self._blink_interaction_enabled and not blink_calibration_was_active:
            self._detect_blinks(blink, global_start, events, validity)

        cursor = 0
        global_end = global_start + values.shape[1]
        while self._next_alpha_sample <= global_end:
            take = self._next_alpha_sample - (global_start + cursor)
            self._append_alpha(filtered[:, cursor : cursor + take])
            cursor += take
            self._update_alpha(
                self._next_alpha_sample / self.config.sample_rate_hz,
                events,
            )
            self._next_alpha_sample += self._alpha_update_samples
        self._append_alpha(filtered[:, cursor:])
        self._samples_seen = global_end
        now_seconds = self._samples_seen / self.config.sample_rate_hz
        self._finalize_gesture(now_seconds, events)
        events.sort(key=lambda event: (event.time_seconds, event.flag))

        flags = [event.flag for event in events]
        if self._alpha_present:
            flags.append("ALPHA_PRESENT")
        if self._blink_interaction_enabled:
            flags.append("BLINK_INTERACTION_ENABLED")
        ordered_flags = tuple(dict.fromkeys(flags))
        signal_quality = float(validity.mean() * self._last_alpha_channel_quality)
        return DemoFlagOutput(
            time_seconds=now_seconds,
            flags=ordered_flags,
            events=tuple(events),
            alpha_ratio=self._last_alpha_ratio,
            alpha_score=self._last_alpha_score,
            alpha_level=self._last_alpha_level,
            alpha_step=self._alpha_step,
            alpha_step_count=self._alpha_step_count,
            alpha_volume_mode=self._alpha_volume_mode,
            recommended_volume=self._recommended_volume,
            alpha_present=self._alpha_present,
            selected_alpha_channels=tuple(
                index + 1 for index in self._selected_alpha_channel_indices
            ),
            alpha_channel_weights=self._selected_alpha_channel_weights,
            alpha_channel_switches=self._alpha_channel_switches,
            calibration_complete=self.calibration_complete,
            calibration_progress=self.calibration_progress,
            closed_eye_calibration_complete=self.closed_eye_calibration_complete,
            closed_eye_calibration_progress=self.closed_eye_calibration_progress,
            adaptive_baseline_updates=self._adaptive_baseline_updates,
            open_eye_alpha_baseline=self._alpha_center,
            closed_eye_alpha_reference=self._closed_eye_reference,
            blink_calibration_complete=self.blink_calibration_complete,
            blink_calibration_progress=self.blink_calibration_progress,
            blink_count_pending=len(self._blink_times),
            blink_strength_z=self._last_blink_strength_z,
            blink_width_seconds=self._last_blink_width_seconds,
            blink_adaptive_baseline_updates=self._blink_adaptive_baseline_updates,
            blink_single_channel_rejections=self._blink_single_channel_rejections,
            blink_invalid_gap_rejections=self._blink_invalid_gap_rejections,
            blink_baseline_health_checks=self._blink_baseline_health_checks,
            blink_baseline_stale=self._blink_baseline_stale,
            blink_dual_channel_required=True,
            blink_interaction_enabled=self._blink_interaction_enabled,
            signal_quality=signal_quality,
        )

    def process_chunks(
        self,
        chunks: Iterable[tuple[np.ndarray, np.ndarray | None, np.ndarray | None]],
    ) -> list[DemoFlagOutput]:
        return [self.stream_step(eeg, imu, valid) for eeg, imu, valid in chunks]
