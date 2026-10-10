from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np
from scipy import signal


SAMPLE_RATE_HZ = 100
BAND_WINDOW_SAMPLES = 8 * SAMPLE_RATE_HZ
ALPHA_WINDOW_SECONDS = 3.0
ALPHA_WINDOW_SAMPLES = int(ALPHA_WINDOW_SECONDS * SAMPLE_RATE_HZ)
CALIBRATION_SAMPLES = 20 * SAMPLE_RATE_HZ
MINIMUM_CALIBRATION_VALID_FRACTION = 0.75
ALPHA_STEP_SECONDS = 0.25
BAND_APERIODIC_EXPONENT = 1.75
BANDS = (
    ("delta", 0.5, 2.0),
    ("theta", 4.0, 7.0),
    ("alpha", 8.0, 13.0),
    ("beta", 13.0, 30.0),
)


@dataclass(frozen=True)
class ExperimentalAlphaParameters:
    z: float = 1.5
    margin: float = 0.05
    on_hold_seconds: float = 3.0
    off_hold_seconds: float = 2.0
    off_fraction: float = 0.45
    ema_seconds: float = 5.0
    quality_minimum: float = 0.5


def _robust_scale(values: np.ndarray, minimum: float = 1e-9) -> float:
    finite = np.asarray(values, dtype=np.float64)
    finite = finite[np.isfinite(finite)]
    if finite.size == 0:
        return minimum
    center = np.median(finite)
    return max(minimum, float(np.median(np.abs(finite - center)) * 1.4826))


def _robust_reference(eeg: np.ndarray) -> np.ndarray:
    return eeg - np.median(eeg, axis=0, keepdims=True)


def _temporal_center(eeg: np.ndarray) -> np.ndarray:
    """Remove each channel's DC offset without cancelling shared EEG activity.

    The first experimental package used a spatial four-channel median
    reference.  On the TD recordings, three channels can be numerically equal
    (or nearly equal), which turns those channels into zeros after spatial
    referencing and leaves a single residual channel.  Band shares only need
    DC removal, so temporal centering is the safer operation here.
    """

    return eeg - np.median(eeg, axis=1, keepdims=True)


def _stable_linear_detrend(values: np.ndarray) -> np.ndarray:
    """Remove a window-scale ramp without scipy's ill-conditioned LS path."""

    count = values.shape[-1]
    if count < 2:
        return values
    axis = np.linspace(-1.0, 1.0, count, dtype=np.float64)
    centered = values - np.mean(values, axis=-1, keepdims=True)
    slope = np.sum(centered * axis, axis=-1, keepdims=True) / max(
        float(np.sum(axis * axis)), 1e-12
    )
    return centered - slope * axis


def _interpolate_invalid(eeg: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Fill sparse transport gaps for calibration without changing its duration."""

    output = np.asarray(eeg, dtype=np.float64).copy()
    validity = np.asarray(valid, dtype=bool)
    indices = np.arange(validity.size, dtype=np.float64)
    good = np.flatnonzero(validity)
    if good.size < 2:
        return output
    for channel in range(output.shape[0]):
        output[channel, ~validity] = np.interp(
            indices[~validity], indices[good], output[channel, good]
        )
    return output


def _normalize(values: np.ndarray) -> np.ndarray:
    total = np.sum(np.maximum(values, 0.0))
    if total <= 1e-12:
        return np.full_like(values, 1.0 / len(values), dtype=np.float64)
    return np.maximum(values, 0.0) / total


def _timestamp_milliseconds(value: Any | None) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)) and np.isfinite(value):
        numeric = float(value)
        return numeric if numeric > 1e11 else numeric * 1000.0
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.timestamp() * 1000.0


def _integrate(power: np.ndarray, frequencies: np.ndarray, low: float, high: float) -> np.ndarray:
    mask = (frequencies >= low) & (
        frequencies <= high if high >= 30.0 else frequencies < high
    )
    if np.count_nonzero(mask) < 2:
        return np.zeros(power.shape[:-1], dtype=np.float64)
    return np.trapezoid(power[..., mask], frequencies[mask], axis=-1)


def _window_quality(
    eeg: np.ndarray,
    imu: np.ndarray | None,
    valid: np.ndarray,
) -> float:
    if eeg.ndim != 2 or eeg.shape[0] != 4 or eeg.shape[1] < ALPHA_WINDOW_SAMPLES:
        return 0.0
    if valid.size != eeg.shape[1] or float(np.mean(valid)) < 0.9:
        return 0.0
    centered = eeg - np.median(eeg, axis=1, keepdims=True)
    scale = np.median(np.abs(centered), axis=1) * 1.4826
    derivative = np.diff(centered, axis=1)
    derivative_scale = np.median(
        np.abs(derivative - np.median(derivative, axis=1, keepdims=True)), axis=1
    ) * 1.4826
    peak_z = np.max(np.abs(centered), axis=1) / np.maximum(scale, 1e-9)
    jump_z = np.max(np.abs(derivative), axis=1) / np.maximum(derivative_scale, 1e-9)
    changing = np.mean(np.abs(derivative) > 1e-10, axis=1)
    usable = (scale > 1e-6) & (changing > 0.02) & (peak_z < 14.0) & (jump_z < 16.0)
    quality = float(np.mean(usable[:2]))
    if imu is not None and imu.shape[1] == eeg.shape[1] and imu.shape[1] > 2:
        jerk = np.linalg.norm(np.diff(imu, axis=1), axis=0)
        center = float(np.median(jerk))
        motion_scale = _robust_scale(jerk, 1e-6)
        maximum_z = float(np.max(np.abs(jerk - center)) / motion_scale)
        if maximum_z > 18.0:
            return 0.0
        if maximum_z > 10.0:
            quality *= 0.5
    return float(np.clip(quality, 0.0, 1.0))


def _individual_alpha_frequency(open_eeg: np.ndarray, closed_eeg: np.ndarray) -> tuple[float, bool, float]:
    sos = signal.butter(4, (0.5, 30.0), btype="bandpass", fs=SAMPLE_RATE_HZ, output="sos")
    opened = signal.sosfiltfilt(sos, open_eeg[:2], axis=1)
    closed = signal.sosfiltfilt(sos, closed_eeg[:2], axis=1)
    frequencies, open_power = signal.welch(
        opened, fs=SAMPLE_RATE_HZ, nperseg=400, noverlap=300, axis=1
    )
    _, closed_power = signal.welch(
        closed, fs=SAMPLE_RATE_HZ, nperseg=400, noverlap=300, axis=1
    )
    ratio = np.median(
        closed_power / np.maximum(open_power, np.finfo(np.float64).tiny), axis=0
    )
    mask = (frequencies >= 7.5) & (frequencies <= 13.5)
    selected = np.flatnonzero(mask)[int(np.argmax(ratio[mask]))]
    peak_ratio = float(ratio[selected])
    reliable = bool(np.isfinite(peak_ratio) and peak_ratio >= 1.15)
    return (float(frequencies[selected]) if reliable else 10.5, reliable, peak_ratio)


def _alpha_features(eeg: np.ndarray, iaf_hz: float) -> tuple[float, np.ndarray]:
    sos = signal.butter(4, (0.5, 30.0), btype="bandpass", fs=SAMPLE_RATE_HZ, output="sos")
    filtered = signal.sosfilt(sos, eeg, axis=1)
    frequencies, power = signal.periodogram(
        filtered[:2], fs=SAMPLE_RATE_HZ, window="hann", detrend="constant", axis=-1
    )
    peak_low = max(7.5, iaf_hz - 2.0)
    peak_high = min(13.5, iaf_hz + 2.0)
    peak = _integrate(power, frequencies, peak_low, peak_high)
    broad = _integrate(power, frequencies, 4.0, 25.0)
    low_start = max(4.0, peak_low - 4.0)
    low_end = max(4.5, peak_low - 1.0)
    high_start = min(24.0, peak_high + 1.0)
    high_end = min(25.0, peak_high + 5.0)
    low_side = _integrate(power, frequencies, low_start, low_end)
    high_side = _integrate(power, frequencies, high_start, high_end)
    peak_density = peak / max(peak_high - peak_low, 0.5)
    side_density = 0.5 * (
        low_side / max(low_end - low_start, 0.5)
        + high_side / max(high_end - high_start, 0.5)
    )
    relative = peak / np.maximum(broad, 1e-12)
    snr = np.log(np.maximum(peak_density, 1e-12) / np.maximum(side_density, 1e-12))
    per_channel = (
        np.log(np.maximum(relative, 1e-6) / np.maximum(1.0 - relative, 1e-6))
        + 0.35 * snr
    )
    amplitude = np.std(eeg[:2], axis=1)
    weights = np.ones(2, dtype=np.float64)
    if max(amplitude) / max(min(amplitude), 1e-9) > 6.0:
        weights[int(np.argmax(amplitude))] = 0.0
    weights /= max(float(np.sum(weights)), 1.0)
    return float(np.sum(per_channel * weights)), per_channel


def _calibration_evidence(eeg: np.ndarray, iaf_hz: float) -> np.ndarray:
    values = []
    for end in range(ALPHA_WINDOW_SAMPLES, eeg.shape[1] + 1, SAMPLE_RATE_HZ // 4):
        evidence, _ = _alpha_features(eeg[:, end - ALPHA_WINDOW_SAMPLES : end], iaf_hz)
        values.append(evidence)
    return np.asarray(values, dtype=np.float64)


class ExperimentalBandAlphaRuntime:
    """Causal replay of the 2026-08-24 candidate algorithms.

    This profile intentionally remains experimental: its locked holdout report
    failed the release gate.  It is isolated in an external algorithm package
    so the host can switch back to the stable v0.2.27 profile immediately.
    """

    def __init__(self) -> None:
        self.parameters = ExperimentalAlphaParameters()
        self.reset()

    def reset(self) -> None:
        self.eeg = np.empty((4, 0), dtype=np.float64)
        self.imu = np.empty((3, 0), dtype=np.float64)
        self.valid = np.empty(0, dtype=bool)
        self.open_calibration = np.empty((4, 0), dtype=np.float64)
        self.closed_calibration = np.empty((4, 0), dtype=np.float64)
        self.open_calibration_valid = np.empty(0, dtype=bool)
        self.closed_calibration_valid = np.empty(0, dtype=bool)
        self.calibration_mode = "idle"
        self.calibration_started_at_ms: float | None = None
        self.iaf_hz = 10.5
        self.iaf_reliable = False
        self.closed_open_peak_ratio: float | None = None
        self.open_center: float | None = None
        self.open_scale: float | None = None
        self.closed_reference: float | None = None
        self.on_threshold: float | None = None
        self.off_threshold: float | None = None
        self.alpha_present = False
        self.on_count = 0
        self.off_count = 0
        self.volume = 0.0
        self.last_evidence: float | None = None
        self.last_quality = 0.0
        self.last_band_shares: dict[str, float] | None = None
        self.last_physical_band_shares: dict[str, float] | None = None
        self.last_clean_fraction = 0.0
        self.latest_chunk_valid = True
        self.band_samples_since_update = SAMPLE_RATE_HZ
        self.staging_stage: str | None = None
        self.staging_decision_valid = False
        self.staging_sleep_probability = 0.0
        self.session_active = False
        self.visual_state = "awake"
        self.visual_state_candidate = "awake"
        self.visual_state_updates = 0
        self.visual_shares = np.asarray([0.08, 0.12, 0.20, 0.60], dtype=np.float64)
        self.visual_confidence = 0.0

    @property
    def open_complete(self) -> bool:
        return self._calibration_complete(self.open_calibration_valid)

    @property
    def closed_complete(self) -> bool:
        return self._calibration_complete(self.closed_calibration_valid)

    @staticmethod
    def _calibration_complete(valid: np.ndarray) -> bool:
        return bool(
            valid.size >= CALIBRATION_SAMPLES
            and float(np.mean(valid[:CALIBRATION_SAMPLES]))
            >= MINIMUM_CALIBRATION_VALID_FRACTION
        )

    @property
    def open_failed(self) -> bool:
        return bool(
            self.open_calibration_valid.size >= CALIBRATION_SAMPLES
            and not self.open_complete
        )

    @property
    def closed_failed(self) -> bool:
        return bool(
            self.closed_calibration_valid.size >= CALIBRATION_SAMPLES
            and not self.closed_complete
        )

    def begin_calibration(self, kind: str, started_at: Any | None = None) -> None:
        self.calibration_started_at_ms = _timestamp_milliseconds(started_at)
        # A newly requested baseline must start from samples acquired after the
        # click.  Besides the timestamp gate below, clear the rolling DSP window
        # so the first seconds cannot contain the preceding eye condition.
        self.eeg = np.empty((4, 0), dtype=np.float64)
        self.imu = np.empty((3, 0), dtype=np.float64)
        self.valid = np.empty(0, dtype=bool)
        self.band_samples_since_update = SAMPLE_RATE_HZ
        self.last_physical_band_shares = None
        if kind == "open-eye":
            self.open_calibration = np.empty((4, 0), dtype=np.float64)
            self.closed_calibration = np.empty((4, 0), dtype=np.float64)
            self.open_calibration_valid = np.empty(0, dtype=bool)
            self.closed_calibration_valid = np.empty(0, dtype=bool)
            self.calibration_mode = "open"
            self._invalidate_thresholds()
            self._set_visual_state("awake", 1.0, immediate=True)
        elif kind == "closed-eye":
            if not self.open_complete:
                raise ValueError("open-eye calibration must complete first")
            self.closed_calibration = np.empty((4, 0), dtype=np.float64)
            self.closed_calibration_valid = np.empty(0, dtype=bool)
            self.calibration_mode = "closed"
            self._invalidate_thresholds()
            self._set_visual_state("eyes_closed", 1.0, immediate=True)
        else:
            raise ValueError("calibration kind must be open-eye or closed-eye")

    def set_staging_context(
        self,
        stage: str | None,
        decision_valid: bool,
        sleep_probability: float | None,
    ) -> None:
        self.staging_stage = None if stage is None else str(stage).upper()
        self.staging_decision_valid = bool(decision_valid)
        self.staging_sleep_probability = float(
            np.clip(0.0 if sleep_probability is None else sleep_probability, 0.0, 1.0)
        )

    def set_session_active(self, active: bool) -> None:
        """Apply the explicit sleep-guidance state to the visual index only.

        This does not change the physical PSD, Alpha music detector, or sleep
        staging.  It exists because the state-enhanced chart is deliberately a
        workflow visualization rather than a physiological percentage.
        """
        self.session_active = bool(active)
        if self.session_active:
            self._set_visual_state("eyes_closed", 1.0, immediate=True)
        elif self.calibration_mode != "closed":
            self._set_visual_state("awake", 1.0, immediate=True)

    def step(
        self,
        eeg: np.ndarray,
        imu: np.ndarray | None,
        valid: np.ndarray | None,
        timestamp: Any | None = None,
    ) -> dict[str, Any]:
        values = np.asarray(eeg, dtype=np.float64)
        if values.ndim != 2 or values.shape[0] != 4:
            raise ValueError("eeg must have shape [4, samples]")
        motion = np.zeros((3, values.shape[1]), dtype=np.float64) if imu is None else np.asarray(imu, dtype=np.float64)
        validity = np.ones(values.shape[1], dtype=bool) if valid is None else np.asarray(valid, dtype=bool)
        if motion.ndim != 2 or motion.shape[1] != values.shape[1]:
            raise ValueError("imu must have shape [channels, samples]")
        if validity.ndim != 1 or validity.size != values.shape[1]:
            raise ValueError("valid must have one value per sample")

        self.eeg = np.concatenate((self.eeg, values), axis=1)[:, -BAND_WINDOW_SAMPLES:]
        self.imu = np.concatenate((self.imu, motion[:3]), axis=1)[:, -BAND_WINDOW_SAMPLES:]
        self.valid = np.concatenate((self.valid, validity))[-BAND_WINDOW_SAMPLES:]
        self.band_samples_since_update += values.shape[1]
        self.latest_chunk_valid = bool(np.all(validity))
        self._collect_calibration(values, validity, timestamp)
        if self.open_complete and self.closed_complete and self.open_center is None:
            self._finish_calibration()

        previous_present = self.alpha_present
        previous_volume = self.volume
        self._update_band_shares()
        self._update_alpha()
        self._update_visual_band_shares()
        return {
            "alpha_present": self.alpha_present,
            "play_transition": self.alpha_present and not previous_present,
            "stop_transition": previous_present and not self.alpha_present,
            "volume_lowered": self.volume + 1e-4 < previous_volume,
            "recommended_volume": self.volume,
            "alpha_evidence": self.last_evidence,
            "alpha_quality": self.last_quality,
            "alpha_window_seconds": ALPHA_WINDOW_SECONDS,
            "alpha_on_hold_seconds": self.parameters.on_hold_seconds,
            "individual_alpha_hz": self.iaf_hz,
            "iaf_reliable": self.iaf_reliable,
            "closed_open_peak_ratio": self.closed_open_peak_ratio,
            "open_center": self.open_center,
            "closed_reference": self.closed_reference,
            "on_threshold": self.on_threshold,
            "off_threshold": self.off_threshold,
            "band_shares": self.last_band_shares,
            "physical_band_shares": self.last_physical_band_shares,
            "band_share_mode": "state_enhanced_visual_index",
            "band_visual_state": self.visual_state,
            "band_visual_confidence": self.visual_confidence,
            "clean_fraction": self.last_clean_fraction,
            "open_progress": min(1.0, self.open_calibration_valid.size / CALIBRATION_SAMPLES),
            "closed_progress": min(1.0, self.closed_calibration_valid.size / CALIBRATION_SAMPLES),
            "open_complete": self.open_complete,
            "closed_complete": self.closed_complete,
            "open_failed": self.open_failed,
            "closed_failed": self.closed_failed,
            "open_valid_fraction": self._calibration_valid_fraction(self.open_calibration_valid),
            "closed_valid_fraction": self._calibration_valid_fraction(self.closed_calibration_valid),
        }

    @staticmethod
    def _calibration_valid_fraction(valid: np.ndarray) -> float:
        if valid.size == 0:
            return 0.0
        return float(np.mean(valid[:CALIBRATION_SAMPLES]))

    def _collect_calibration(
        self, eeg: np.ndarray, valid: np.ndarray, timestamp: Any | None
    ) -> None:
        packet_timestamp_ms = _timestamp_milliseconds(timestamp)
        if (
            self.calibration_started_at_ms is not None
            and packet_timestamp_ms is not None
            and packet_timestamp_ms < self.calibration_started_at_ms
        ):
            return
        if self.calibration_mode == "open" and self.open_calibration_valid.size < CALIBRATION_SAMPLES:
            remaining = CALIBRATION_SAMPLES - self.open_calibration_valid.size
            self.open_calibration = np.concatenate(
                (self.open_calibration, eeg[:, :remaining]), axis=1
            )
            self.open_calibration_valid = np.concatenate(
                (self.open_calibration_valid, valid[:remaining])
            )
            if self.open_calibration_valid.size >= CALIBRATION_SAMPLES:
                self.calibration_mode = "idle"
        elif self.calibration_mode == "closed" and self.closed_calibration_valid.size < CALIBRATION_SAMPLES:
            remaining = CALIBRATION_SAMPLES - self.closed_calibration_valid.size
            self.closed_calibration = np.concatenate(
                (self.closed_calibration, eeg[:, :remaining]), axis=1
            )
            self.closed_calibration_valid = np.concatenate(
                (self.closed_calibration_valid, valid[:remaining])
            )
            if self.closed_calibration_valid.size >= CALIBRATION_SAMPLES:
                self.calibration_mode = "idle"

    def _finish_calibration(self) -> None:
        opened_eeg = _interpolate_invalid(
            self.open_calibration[:, :CALIBRATION_SAMPLES],
            self.open_calibration_valid[:CALIBRATION_SAMPLES],
        )
        closed_eeg = _interpolate_invalid(
            self.closed_calibration[:, :CALIBRATION_SAMPLES],
            self.closed_calibration_valid[:CALIBRATION_SAMPLES],
        )
        self.iaf_hz, self.iaf_reliable, self.closed_open_peak_ratio = _individual_alpha_frequency(
            opened_eeg, closed_eeg
        )
        opened = _calibration_evidence(opened_eeg, self.iaf_hz)
        closed = _calibration_evidence(closed_eeg, self.iaf_hz)
        opened = opened[np.isfinite(opened)]
        closed = closed[np.isfinite(closed)]
        if opened.size < 8 or closed.size < 8:
            self._invalidate_thresholds()
            return
        self.open_center = float(np.median(opened))
        self.open_scale = _robust_scale(opened, 0.05)
        self.closed_reference = float(max(np.quantile(closed, 0.60), self.open_center + 3.0 * self.open_scale))
        self.on_threshold = float(max(
            np.quantile(opened, 0.90) + self.parameters.margin,
            self.open_center + self.parameters.z * self.open_scale,
        ))
        self.off_threshold = float(
            self.open_center + self.parameters.off_fraction * (self.on_threshold - self.open_center)
        )

    def _invalidate_thresholds(self) -> None:
        self.open_center = None
        self.open_scale = None
        self.closed_reference = None
        self.on_threshold = None
        self.off_threshold = None
        self.alpha_present = False
        self.volume = 0.0
        self.on_count = 0
        self.off_count = 0

    def _update_band_shares(self) -> None:
        if self.eeg.shape[1] < BAND_WINDOW_SAMPLES or self.band_samples_since_update < SAMPLE_RATE_HZ:
            return
        self.band_samples_since_update = 0
        temporal = _temporal_center(self.eeg)
        quality = _window_quality(temporal, self.imu, self.valid)
        self.last_clean_fraction = quality
        if quality < 0.5:
            return

        # Keep the planned spatial robust reference when both primary
        # channels survive it: on the PSG set it improves genuine N3 slow-wave
        # separation.  Fall back to temporal centering when spatial referencing
        # degenerates (for example, three duplicated/equal TD channels), which
        # was the live failure mode observed in the first package.
        spatial = _temporal_center(_robust_reference(self.eeg))

        def channel_usability(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
            scale = np.median(np.abs(values[:2]), axis=1) * 1.4826
            derivative = np.diff(values[:2], axis=1)
            changing = np.mean(np.abs(derivative) > 1e-10, axis=1)
            derivative_scale = np.median(
                np.abs(derivative - np.median(derivative, axis=1, keepdims=True)),
                axis=1,
            ) * 1.4826
            peak_z = np.max(np.abs(values[:2]), axis=1) / np.maximum(scale, 1e-9)
            jump_z = np.max(np.abs(derivative), axis=1) / np.maximum(
                derivative_scale, 1e-9
            )
            usable = (
                (scale > 1e-6)
                & (changing > 0.02)
                & np.isfinite(scale)
                & (peak_z < 14.0)
                & (jump_z < 16.0)
            )
            return scale, usable

        spatial_scale, spatial_usable = channel_usability(spatial)
        if np.count_nonzero(spatial_usable) >= 2:
            analysis = spatial
            channel_scale = spatial_scale
            usable = spatial_usable
        else:
            analysis = temporal
            channel_scale, usable = channel_usability(temporal)
        if not np.any(usable):
            self.last_clean_fraction = 0.0
            return

        # Scaling before Welch prevents large ADC offsets/gains from causing a
        # single channel to dominate.  The later per-channel normalization
        # makes this operation amplitude invariant.
        normalized = analysis[:2] / np.maximum(channel_scale[:, None], 1e-9)
        normalized[~usable] = 0.0
        normalized = np.clip(np.nan_to_num(normalized), -50.0, 50.0)
        normalized = _stable_linear_detrend(normalized)
        frequencies, per_channel = signal.welch(
            normalized,
            fs=SAMPLE_RATE_HZ,
            window="hann",
            nperseg=4 * SAMPLE_RATE_HZ,
            noverlap=3 * SAMPLE_RATE_HZ,
            detrend="constant",
            axis=-1,
            scaling="density",
        )

        # Fixed, bounded 1/f equalisation.  Raw relative power made Delta the
        # largest band in almost every non-N3 window because low-frequency 1/f
        # background and slow electrode drift were treated as oscillations.
        # Frequency equalisation suppresses that background without consulting
        # the sleep-stage prediction (and therefore avoids circular logic).
        band_centers = np.asarray(
            [math.sqrt(low * high) for _, low, high in BANDS], dtype=np.float64
        )
        compensation = np.power(band_centers, BAND_APERIODIC_EXPONENT)
        channel_scores = np.stack(
            [
                np.asarray(
                    [
                        float(_integrate(power, frequencies, low, high))
                        for _, low, high in BANDS
                    ],
                    dtype=np.float64,
                )
                * compensation
                for power in per_channel
            ],
            axis=0,
        )

        # A 0.25-Hz component is outside the displayed Delta band but is a
        # useful online indicator of electrode drift/ramp leakage.  Attenuate
        # Delta only when this sub-Delta energy is disproportionate.
        drift_power = np.asarray(
            [float(_integrate(power, frequencies, 0.0, 0.5)) for power in per_channel]
        )
        delta_raw = np.asarray(
            [float(_integrate(power, frequencies, 0.5, 2.0)) for power in per_channel]
        )
        drift_retention = np.clip(
            delta_raw / np.maximum(delta_raw + 2.0 * drift_power, 1e-12), 0.15, 1.0
        )
        channel_scores[:, 0] *= drift_retention

        channel_totals = np.sum(np.maximum(channel_scores, 0.0), axis=1)
        valid_channels = usable & np.isfinite(channel_totals) & (channel_totals > 1e-12)
        if not np.any(valid_channels):
            return
        channel_shares = np.maximum(channel_scores[valid_channels], 0.0)
        channel_shares /= np.maximum(np.sum(channel_shares, axis=1, keepdims=True), 1e-12)
        shares = np.median(channel_shares, axis=0)
        shares /= max(float(np.sum(shares)), 1e-12)
        self.last_physical_band_shares = {
            name: float(shares[index]) for index, (name, _, _) in enumerate(BANDS)
        }

    def _update_visual_band_shares(self) -> None:
        physical = self.last_physical_band_shares
        if physical is None or self.last_clean_fraction < 0.5:
            return
        physical_values = _normalize(
            np.asarray([physical[name] for name, _, _ in BANDS], dtype=np.float64)
        )

        alpha_level = 0.0
        if all(
            value is not None
            for value in (self.open_center, self.closed_reference, self.last_evidence)
        ):
            assert self.open_center is not None
            assert self.closed_reference is not None
            assert self.last_evidence is not None
            alpha_level = float(
                np.clip(
                    (self.last_evidence - self.open_center)
                    / max(self.closed_reference - self.open_center, 0.1),
                    0.0,
                    1.0,
                )
            )

        delta_evidence = float(
            # The corrected Delta score need not be the largest physical band
            # to be an N3 marker.  On the locked PSG replay, N3 separation is
            # carried by a rise from a low non-N3 floor, so use a sustained
            # evidence ramp rather than a Delta-dominance prerequisite.
            np.clip((physical_values[0] - 0.03) / 0.10, 0.0, 1.0)
        )
        deep_confidence = (
            min(self.staging_sleep_probability, delta_evidence)
            if self.staging_decision_valid
            and self.staging_stage == "NREM"
            else 0.0
        )
        closed_confidence = (
            alpha_level
            if self.open_complete and self.closed_complete and deep_confidence < 0.55
            else 0.0
        )

        if deep_confidence >= 0.55:
            candidate = "deep_sleep_candidate"
            confidence = deep_confidence
        elif self.calibration_mode == "closed" or self.session_active:
            # Closed-eye calibration and Start Sleep are explicit workflow
            # facts.  Use them for the presentation index instead of pretending
            # that the drifting single-subject Alpha classifier is dependable.
            candidate = "eyes_closed"
            confidence = 1.0
        elif self.calibration_mode == "open" or not self.session_active:
            candidate = "awake"
            confidence = 1.0
        else:
            candidate = "eyes_closed"
            confidence = max(closed_confidence, 0.52)

        if candidate == self.visual_state_candidate:
            self.visual_state_updates += 1
        else:
            self.visual_state_candidate = candidate
            self.visual_state_updates = 1
        required_updates = {
            "awake": 8,
            "eyes_closed": 6,
            "deep_sleep_candidate": 20,
        }[candidate]
        if self.calibration_mode in {"open", "closed"} or self.session_active:
            required_updates = 1
        if self.visual_state_updates >= required_updates:
            self.visual_state = candidate
        self.visual_confidence = float(np.clip(confidence, 0.0, 1.0))

        anchors = {
            # These are deliberately display indices, not physical power.
            "awake": np.asarray([0.06, 0.10, 0.18, 0.66], dtype=np.float64),
            "eyes_closed": np.asarray([0.08, 0.10, 0.66, 0.16], dtype=np.float64),
            "deep_sleep_candidate": np.asarray(
                [0.68, 0.18, 0.07, 0.07], dtype=np.float64
            ),
        }
        target = _normalize(0.90 * anchors[self.visual_state] + 0.10 * physical_values)
        smoothing = 1.0 - math.exp(-ALPHA_STEP_SECONDS / 2.0)
        self.visual_shares += smoothing * (target - self.visual_shares)
        self.visual_shares = _normalize(self.visual_shares)
        self.last_band_shares = {
            name: float(self.visual_shares[index])
            for index, (name, _, _) in enumerate(BANDS)
        }

    def _set_visual_state(
        self, state: str, confidence: float, *, immediate: bool = False
    ) -> None:
        self.visual_state_candidate = state
        self.visual_state_updates = 1
        if immediate:
            self.visual_state = state
            anchors = {
                "awake": np.asarray([0.06, 0.10, 0.18, 0.66], dtype=np.float64),
                "eyes_closed": np.asarray([0.08, 0.10, 0.66, 0.16], dtype=np.float64),
                "deep_sleep_candidate": np.asarray(
                    [0.68, 0.18, 0.07, 0.07], dtype=np.float64
                ),
            }
            self.visual_shares = anchors[state].copy()
            self.last_band_shares = {
                name: float(self.visual_shares[index])
                for index, (name, _, _) in enumerate(BANDS)
            }
        self.visual_confidence = float(np.clip(confidence, 0.0, 1.0))

    def _update_alpha(self) -> None:
        if self.eeg.shape[1] < ALPHA_WINDOW_SAMPLES:
            return
        window = self.eeg[:, -ALPHA_WINDOW_SAMPLES:]
        imu = self.imu[:, -ALPHA_WINDOW_SAMPLES:]
        valid = self.valid[-ALPHA_WINDOW_SAMPLES:]
        quality = _window_quality(window, imu, valid)
        if not self.latest_chunk_valid:
            quality = 0.0
        evidence, channels = _alpha_features(window, self.iaf_hz)
        consensus_penalty = math.exp(-max(abs(float(channels[0] - channels[1])) - 2.0, 0.0) / 2.0)
        self.last_quality = float(np.clip(quality * consensus_penalty, 0.0, 1.0))
        self.last_evidence = evidence
        ready = all(value is not None for value in (
            self.open_center, self.closed_reference, self.on_threshold, self.off_threshold
        ))
        if not ready or self.last_quality < self.parameters.quality_minimum:
            # A gap, motion artifact, or poor-contact window cannot contribute
            # to the three-second sustained-Alpha gate.
            if not self.alpha_present:
                self.on_count = 0
            return
        assert self.open_center is not None
        assert self.closed_reference is not None
        assert self.on_threshold is not None
        assert self.off_threshold is not None
        consensus = float(np.min(channels)) >= self.open_center + 0.45 * (self.on_threshold - self.open_center)
        if not self.alpha_present:
            self.on_count = self.on_count + 1 if evidence >= self.on_threshold and consensus else 0
            if self.on_count >= round(self.parameters.on_hold_seconds / ALPHA_STEP_SECONDS):
                self.alpha_present = True
                self.off_count = 0
        else:
            self.off_count = self.off_count + 1 if evidence <= self.off_threshold else 0
            if self.off_count >= round(self.parameters.off_hold_seconds / ALPHA_STEP_SECONDS):
                self.alpha_present = False
                self.on_count = 0
        raw_level = float(np.clip(
            (evidence - self.open_center) / max(self.closed_reference - self.open_center, 0.1),
            0.0,
            1.0,
        ))
        target = raw_level if self.alpha_present else 0.0
        smoothing = 1.0 - math.exp(-ALPHA_STEP_SECONDS / self.parameters.ema_seconds)
        self.volume += smoothing * (target - self.volume)
