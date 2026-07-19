from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
from scipy.signal import butter, sosfilt, sosfilt_zi

from .stream_features import frozen_sleeptransformer_features
from .stream_policy import ControlConfig, HierarchicalStageConfig


STATE_SCHEMA_VERSION = 1
PHASE_COUNT = 6
CONTEXT_LENGTH = 8
TOKEN_SHAPE = (29, 44)
AUXILIARY_FEATURES = 6


@dataclass
class ProbabilityControlState:
    ema: np.ndarray = field(default_factory=lambda: np.zeros(3, dtype=np.float64))
    initialized: bool = False
    is_sleep: bool = False
    sleep_count: int = 0
    wake_count: int = 0


@dataclass
class HierarchicalDecoderState:
    control: ProbabilityControlState = field(default_factory=ProbabilityControlState)
    sleep_stage: int = 1
    rem_count: int = 0
    nrem_count: int = 0


@dataclass
class MobileStreamState:
    filter_zi: np.ndarray
    filter_initialized: bool
    rolling_signal: np.ndarray
    rolling_valid: np.ndarray
    rolling_count: int
    chunks_seen: int
    phase_tokens: np.ndarray
    phase_auxiliary: np.ndarray
    phase_valid: np.ndarray
    phase_filled: np.ndarray
    standard_decoder: HierarchicalDecoderState = field(
        default_factory=HierarchicalDecoderState
    )
    recovery_decoder: HierarchicalDecoderState = field(
        default_factory=HierarchicalDecoderState
    )
    music_controller: ProbabilityControlState = field(
        default_factory=ProbabilityControlState
    )


def _update_control(
    probability: np.ndarray,
    state: ProbabilityControlState,
    config: ControlConfig,
) -> tuple[np.ndarray, bool]:
    current = np.asarray(probability, dtype=np.float64)
    if current.shape != (3,):
        raise ValueError("probability must have shape [3]")
    if not state.initialized:
        state.ema = current.copy()
        state.initialized = True
    else:
        state.ema = (
            config.ema_alpha * current + (1.0 - config.ema_alpha) * state.ema
        )
    sleep_probability = float(state.ema[1] + state.ema[2])
    if state.is_sleep:
        state.wake_count = (
            state.wake_count + 1
            if sleep_probability <= config.wake_on_threshold
            else 0
        )
        state.sleep_count = 0
        if state.wake_count >= config.wake_confirm_updates:
            state.is_sleep = False
            state.wake_count = 0
    else:
        state.sleep_count = (
            state.sleep_count + 1
            if sleep_probability >= config.sleep_on_threshold
            else 0
        )
        state.wake_count = 0
        if state.sleep_count >= config.sleep_confirm_updates:
            state.is_sleep = True
            state.sleep_count = 0
    return state.ema.copy(), state.is_sleep


def _update_hierarchical_decoder(
    probability: np.ndarray,
    state: HierarchicalDecoderState,
    config: HierarchicalStageConfig,
) -> tuple[int, np.ndarray, float]:
    smoothed, sleeping = _update_control(probability, state.control, config.control)
    conditional_rem = float(
        smoothed[2] / max(float(smoothed[1] + smoothed[2]), 1e-8)
    )
    if not sleeping:
        state.sleep_stage = 1
        state.rem_count = 0
        state.nrem_count = 0
        return 0, smoothed, conditional_rem
    if state.sleep_stage == 1:
        state.rem_count = (
            state.rem_count + 1
            if conditional_rem >= config.rem_on_threshold
            else 0
        )
        state.nrem_count = 0
        if state.rem_count >= config.rem_confirm_updates:
            state.sleep_stage = 2
            state.rem_count = 0
    else:
        state.nrem_count = (
            state.nrem_count + 1
            if conditional_rem <= config.rem_off_threshold
            else 0
        )
        state.rem_count = 0
        if state.nrem_count >= config.nrem_confirm_updates:
            state.sleep_stage = 1
            state.nrem_count = 0
    return state.sleep_stage, smoothed, conditional_rem


def _cnn_features(window: np.ndarray, coverage: float) -> tuple[np.ndarray, np.ndarray]:
    eeg = window[:4]
    eeg_mean = eeg.mean(axis=1, keepdims=True)
    eeg_std = eeg.std(axis=1, keepdims=True).clip(min=1.0)
    eeg_normalized = np.clip((eeg - eeg_mean) / eeg_std, -8.0, 8.0)
    acceleration = np.sqrt(
        np.square(window[4:7], dtype=np.float64).sum(axis=0)
    ).astype(np.float32)
    acceleration_std = max(float(acceleration.std()), 1.0)
    acceleration_normalized = np.clip(
        (acceleration - acceleration.mean()) / acceleration_std, -8.0, 8.0
    )[None, :]
    signal = np.concatenate((eeg_normalized, acceleration_normalized), axis=0).astype(
        np.float32
    )
    auxiliary = np.concatenate(
        (
            np.log10(eeg_std[:, 0] + 1.0),
            np.asarray(
                [np.log10(acceleration_std + 1.0), coverage], dtype=np.float32
            ),
        )
    ).astype(np.float32)
    return signal, auxiliary


def _maximum_false_run(values: np.ndarray) -> int:
    invalid = ~np.asarray(values, dtype=bool)
    if not invalid.any():
        return 0
    padded = np.concatenate(([False], invalid, [False])).astype(np.int8)
    changes = np.diff(padded)
    starts = np.flatnonzero(changes == 1)
    stops = np.flatnonzero(changes == -1)
    return int(np.max(stops - starts))


def _control_arrays(prefix: str, state: ProbabilityControlState) -> dict[str, np.ndarray]:
    return {
        f"{prefix}_ema": np.asarray(state.ema, dtype=np.float64),
        f"{prefix}_initialized": np.asarray(state.initialized, dtype=np.bool_),
        f"{prefix}_is_sleep": np.asarray(state.is_sleep, dtype=np.bool_),
        f"{prefix}_sleep_count": np.asarray(state.sleep_count, dtype=np.int64),
        f"{prefix}_wake_count": np.asarray(state.wake_count, dtype=np.int64),
    }


def _control_from_archive(
    archive: Any, prefix: str
) -> ProbabilityControlState:
    return ProbabilityControlState(
        ema=np.asarray(archive[f"{prefix}_ema"], dtype=np.float64).copy(),
        initialized=bool(archive[f"{prefix}_initialized"]),
        is_sleep=bool(archive[f"{prefix}_is_sleep"]),
        sleep_count=int(archive[f"{prefix}_sleep_count"]),
        wake_count=int(archive[f"{prefix}_wake_count"]),
    )


def _decoder_arrays(prefix: str, state: HierarchicalDecoderState) -> dict[str, np.ndarray]:
    output = _control_arrays(f"{prefix}_control", state.control)
    output.update(
        {
            f"{prefix}_sleep_stage": np.asarray(state.sleep_stage, dtype=np.int64),
            f"{prefix}_rem_count": np.asarray(state.rem_count, dtype=np.int64),
            f"{prefix}_nrem_count": np.asarray(state.nrem_count, dtype=np.int64),
        }
    )
    return output


def _decoder_from_archive(archive: Any, prefix: str) -> HierarchicalDecoderState:
    return HierarchicalDecoderState(
        control=_control_from_archive(archive, f"{prefix}_control"),
        sleep_stage=int(archive[f"{prefix}_sleep_stage"]),
        rem_count=int(archive[f"{prefix}_rem_count"]),
        nrem_count=int(archive[f"{prefix}_nrem_count"]),
    )


class MobileStreamRuntime:
    """Strictly causal 5-second reference runtime for the five-seed ensemble.

    The input is already timestamp-binned and forward-filled. EEG is still raw
    and is filtered here with a persistent causal SOS state. Only accelerometer
    axes 0..2 are consumed by the frozen model; optional gyroscope axes are
    accepted but never substituted for missing accelerometer information.
    """

    def __init__(
        self,
        pipeline_config: str | Path,
        providers: list[str] | None = None,
        intra_op_threads: int = 1,
        retain_diagnostics: bool = False,
        model_config_key: str = "onnx_dynamic_int8_branches",
        fallback_model_filename: str = "cnn_sleeptransformer_branches_dynamic_int8.onnx",
    ) -> None:
        self.config_path = Path(pipeline_config).resolve()
        raw_config = self.config_path.read_bytes()
        self.config_hash = hashlib.sha256(raw_config).hexdigest()
        self.config = json.loads(raw_config.decode("utf-8"))
        self.sample_rate_hz = int(self.config["sample_rate_hz"])
        self.step_seconds = int(self.config["decision_interval_seconds"])
        self.window_seconds = int(self.config["signal_window_seconds"])
        self.chunk_samples = self.sample_rate_hz * self.step_seconds
        self.window_samples = self.sample_rate_hz * self.window_seconds
        if self.window_samples // self.chunk_samples != PHASE_COUNT:
            raise ValueError("The frozen runtime requires six 5-second phases per window")
        self.minimum_coverage = float(
            self.config["preprocessing"]["minimum_window_coverage"]
        )
        mapping = tuple(
            int(value)
            for value in self.config["preprocessing"].get(
                "model_eeg_channel_mapping", [0, 1, 0, 1]
            )
        )
        if len(mapping) != 4 or any(value not in range(4) for value in mapping):
            raise ValueError(
                "preprocessing.model_eeg_channel_mapping must contain four indices in [0,3]"
            )
        self.model_eeg_channel_mapping = mapping
        self.source_eeg_channels = tuple(sorted(set(mapping)))
        self.maximum_gap_seconds = float(
            self.config["preprocessing"]["maximum_contiguous_gap_seconds"]
        )
        band = self.config["preprocessing"]["wearable_eeg_bandpass_hz"]
        self.sos = butter(
            4,
            (float(band[0]), float(band[1])),
            btype="bandpass",
            fs=self.sample_rate_hz,
            output="sos",
        )
        self.filter_initial = sosfilt_zi(self.sos)
        self.stage_config = HierarchicalStageConfig(**self.config["stage_decoder"])
        self.music_config = ControlConfig(**self.config["music_controller"])
        standard_fusion = self.config.get("fusion_policy", {}).get(
            "standard_continuous", {}
        )
        self.cnn_weight = float(standard_fusion.get("cnn_weight", 0.6))
        self.transformer_weight = float(
            standard_fusion.get("sleeptransformer_weight", 0.4)
        )
        if not np.isclose(self.cnn_weight + self.transformer_weight, 1.0):
            raise ValueError("CNN and SleepTransformer fusion weights must sum to one")
        options = ort.SessionOptions()
        options.intra_op_num_threads = intra_op_threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        selected_providers = providers or ["CPUExecutionProvider"]
        self.model_paths: list[Path] = []
        self.sessions: list[ort.InferenceSession] = []
        self.model_sha256: list[str] = []
        for model in self.config["models"]:
            if model_config_key not in model:
                raise KeyError(
                    f"Pipeline model is missing deployment key {model_config_key!r}"
                )
            path = self._resolve_model_path(
                str(model[model_config_key]),
                int(model["seed"]),
                fallback_model_filename,
            )
            self.model_paths.append(path)
            self.model_sha256.append(hashlib.sha256(path.read_bytes()).hexdigest())
            self.sessions.append(
                ort.InferenceSession(
                    str(path), sess_options=options, providers=selected_providers
                )
            )
        if not self.sessions:
            raise RuntimeError("No branch ONNX models are configured")
        self.retain_diagnostics = retain_diagnostics
        self.last_inputs: dict[str, np.ndarray] | None = None
        self.last_branch_outputs: list[tuple[np.ndarray, ...]] | None = None

    def _resolve_model_path(
        self, value: str, seed: int, fallback_model_filename: str
    ) -> Path:
        path = Path(value)
        candidates = [
            path,
            self.config_path.parent / path if not path.is_absolute() else path,
            self.config_path.parents[3] / path if not path.is_absolute() else path,
            self.config_path.parent
            / f"seed_{seed}"
            / "export"
            / fallback_model_filename,
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate.resolve()
        raise FileNotFoundError(
            f"Cannot locate branch ONNX model for seed {seed}: {value}"
        )

    def new_state(self) -> MobileStreamState:
        sections = self.sos.shape[0]
        return MobileStreamState(
            filter_zi=np.zeros((4, sections, 2), dtype=np.float64),
            filter_initialized=False,
            rolling_signal=np.zeros((7, self.window_samples), dtype=np.float32),
            rolling_valid=np.zeros(self.window_samples, dtype=bool),
            rolling_count=0,
            chunks_seen=0,
            phase_tokens=np.zeros(
                (PHASE_COUNT, CONTEXT_LENGTH) + TOKEN_SHAPE, dtype=np.float16
            ),
            phase_auxiliary=np.zeros(
                (PHASE_COUNT, CONTEXT_LENGTH, AUXILIARY_FEATURES), dtype=np.float32
            ),
            phase_valid=np.zeros((PHASE_COUNT, CONTEXT_LENGTH), dtype=bool),
            phase_filled=np.zeros(PHASE_COUNT, dtype=np.int8),
        )

    def _filter_chunk(
        self, eeg: np.ndarray, acceleration: np.ndarray, state: MobileStreamState
    ) -> np.ndarray:
        raw_eeg = np.asarray(eeg, dtype=np.float64)
        output = np.empty((7, self.chunk_samples), dtype=np.float32)
        if not state.filter_initialized:
            for channel in range(4):
                state.filter_zi[channel] = self.filter_initial * raw_eeg[channel, 0]
            state.filter_initialized = True
        for channel in range(4):
            filtered, state.filter_zi[channel] = sosfilt(
                self.sos, raw_eeg[channel], zi=state.filter_zi[channel]
            )
            output[channel] = filtered.astype(np.float32)
        output[4:7] = np.asarray(acceleration[:3], dtype=np.float32)
        return output

    def _append_rolling(
        self, chunk: np.ndarray, valid: np.ndarray, state: MobileStreamState
    ) -> None:
        shift = self.chunk_samples
        state.rolling_signal[:, :-shift] = state.rolling_signal[:, shift:]
        state.rolling_signal[:, -shift:] = chunk
        state.rolling_valid[:-shift] = state.rolling_valid[shift:]
        state.rolling_valid[-shift:] = valid
        state.rolling_count = min(self.window_samples, state.rolling_count + shift)
        state.chunks_seen += 1

    @staticmethod
    def _append_context(
        phase: int,
        token: np.ndarray | None,
        auxiliary: np.ndarray | None,
        is_valid: bool,
        state: MobileStreamState,
    ) -> None:
        state.phase_tokens[phase, :-1] = state.phase_tokens[phase, 1:]
        state.phase_auxiliary[phase, :-1] = state.phase_auxiliary[phase, 1:]
        state.phase_valid[phase, :-1] = state.phase_valid[phase, 1:]
        state.phase_tokens[phase, -1] = 0.0 if token is None else token
        state.phase_auxiliary[phase, -1] = (
            0.0 if auxiliary is None else auxiliary
        )
        state.phase_valid[phase, -1] = is_valid
        state.phase_filled[phase] = min(
            CONTEXT_LENGTH, int(state.phase_filled[phase]) + 1
        )

    def _infer(
        self,
        signal: np.ndarray,
        cnn_auxiliary: np.ndarray,
        tokens: np.ndarray,
        transformer_auxiliary: np.ndarray,
        context_valid: np.ndarray,
    ) -> tuple[np.ndarray, np.ndarray, float, float]:
        inputs = {
            "signal": np.ascontiguousarray(signal[None], dtype=np.float32),
            "cnn_auxiliary": np.ascontiguousarray(
                cnn_auxiliary[None], dtype=np.float32
            ),
            "tokens": np.ascontiguousarray(tokens[None], dtype=np.float32),
            "transformer_auxiliary": np.ascontiguousarray(
                transformer_auxiliary[None], dtype=np.float32
            ),
            "context_valid": np.ascontiguousarray(context_valid[None], dtype=bool),
        }
        branch_outputs = [tuple(session.run(None, inputs)) for session in self.sessions]
        cnn_probability = np.mean(
            np.stack([output[0][0] for output in branch_outputs]), axis=0
        ).astype(np.float64)
        transformer_probability = np.mean(
            np.stack([output[1][0] for output in branch_outputs]), axis=0
        ).astype(np.float64)
        cnn_sleep_probability = float(
            np.mean([float(output[2][0]) for output in branch_outputs])
        )
        transformer_sleep_probability = float(
            np.mean([float(output[3][0]) for output in branch_outputs])
        )
        if self.retain_diagnostics:
            self.last_inputs = {name: value.copy() for name, value in inputs.items()}
            self.last_branch_outputs = branch_outputs
        return (
            cnn_probability,
            transformer_probability,
            cnn_sleep_probability,
            transformer_sleep_probability,
        )

    def stream_step(
        self,
        eeg_5s: np.ndarray,
        imu_5s: np.ndarray,
        state: MobileStreamState,
        valid_5s: np.ndarray | None = None,
    ) -> tuple[dict[str, Any], MobileStreamState]:
        started = time.perf_counter_ns()
        eeg = np.asarray(eeg_5s)
        imu = np.asarray(imu_5s)
        if eeg.shape != (4, self.chunk_samples):
            raise ValueError(
                f"eeg_5s must have shape [4,{self.chunk_samples}], got {eeg.shape}"
            )
        if imu.shape not in (
            (3, self.chunk_samples),
            (6, self.chunk_samples),
        ):
            raise ValueError(
                f"imu_5s must have shape [3|6,{self.chunk_samples}], got {imu.shape}"
            )
        model_eeg = np.asarray(
            eeg[list(self.model_eeg_channel_mapping)], dtype=eeg.dtype
        )
        if not np.isfinite(model_eeg).all() or not np.isfinite(imu[:3]).all():
            raise ValueError("Inputs must be finite after timestamp binning and imputation")
        valid = (
            np.ones(self.chunk_samples, dtype=bool)
            if valid_5s is None
            else np.asarray(valid_5s, dtype=bool)
        )
        if valid.shape != (self.chunk_samples,):
            raise ValueError(f"valid_5s must have shape [{self.chunk_samples}]")
        filtered = self._filter_chunk(model_eeg, imu, state)
        self._append_rolling(filtered, valid, state)
        base: dict[str, Any] = {
            "decision_ready": state.rolling_count == self.window_samples,
            "decision_valid": False,
            "chunks_seen": state.chunks_seen,
            "end_seconds": state.chunks_seen * self.step_seconds,
            "imu_axes_received": int(imu.shape[0]),
            "eeg_channels_used": [index + 1 for index in self.source_eeg_channels],
            "model_eeg_channel_mapping": [
                index + 1 for index in self.model_eeg_channel_mapping
            ],
            "future_samples_used": False,
        }
        if state.rolling_count < self.window_samples:
            base["runtime_step_ms"] = (time.perf_counter_ns() - started) / 1e6
            return base, state

        coverage = float(state.rolling_valid.mean())
        maximum_gap = _maximum_false_run(state.rolling_valid) / self.sample_rate_hz
        quality_valid = (
            coverage >= self.minimum_coverage
            and maximum_gap <= self.maximum_gap_seconds
        )
        phase = state.chunks_seen % PHASE_COUNT
        token: np.ndarray | None = None
        transformer_auxiliary: np.ndarray | None = None
        if quality_valid:
            batch_token, batch_auxiliary = frozen_sleeptransformer_features(
                state.rolling_signal[None],
                np.asarray([coverage], dtype=np.float32),
                self.sample_rate_hz,
                2 * self.sample_rate_hz,
                self.sample_rate_hz,
            )
            token = batch_token[0]
            transformer_auxiliary = batch_auxiliary[0]
        self._append_context(
            phase, token, transformer_auxiliary, quality_valid, state
        )
        context_valid = state.phase_valid[phase].copy()
        context_valid_count = int(context_valid.sum())
        base.update(
            {
                "decision_valid": quality_valid,
                "coverage": coverage,
                "maximum_contiguous_gap_seconds": maximum_gap,
                "quality": coverage if quality_valid else 0.0,
                "phase": phase,
                "context_valid_count": context_valid_count,
                "context_attempt_count": int(state.phase_filled[phase]),
            }
        )
        if not quality_valid:
            base["runtime_step_ms"] = (time.perf_counter_ns() - started) / 1e6
            return base, state

        signal, cnn_auxiliary = _cnn_features(state.rolling_signal, coverage)
        cnn_probability, transformer_probability, cnn_sleep, transformer_sleep = (
            self._infer(
                signal,
                cnn_auxiliary,
                state.phase_tokens[phase],
                state.phase_auxiliary[phase],
                context_valid,
            )
        )
        fixed_probability = (
            self.cnn_weight * cnn_probability
            + self.transformer_weight * transformer_probability
        )
        fixed_probability /= fixed_probability.sum()
        fixed_sleep_probability = (
            self.cnn_weight * cnn_sleep
            + self.transformer_weight * transformer_sleep
        )
        transformer_weight = (
            self.transformer_weight
            if context_valid_count == CONTEXT_LENGTH
            else 0.0
        )
        recovery_probability = (
            (1.0 - transformer_weight) * cnn_probability
            + transformer_weight * transformer_probability
        )
        recovery_probability /= recovery_probability.sum()
        stage_prediction, stage_smoothed, conditional_rem = (
            _update_hierarchical_decoder(
                fixed_probability, state.standard_decoder, self.stage_config
            )
        )
        recovery_prediction, recovery_smoothed, recovery_conditional_rem = (
            _update_hierarchical_decoder(
                recovery_probability, state.recovery_decoder, self.stage_config
            )
        )
        music_smoothed, music_sleep_state = _update_control(
            fixed_probability, state.music_controller, self.music_config
        )
        base.update(
            {
                "p3": fixed_probability,
                "p_sleep": fixed_sleep_probability,
                "cnn_p3": cnn_probability,
                "sleeptransformer_p3": transformer_probability,
                "raw_prediction3": int(np.argmax(fixed_probability)),
                "stage_decoder_probability3": stage_smoothed,
                "stage_decoder_prediction3": int(stage_prediction),
                "conditional_rem_probability": conditional_rem,
                "recovery_p3": recovery_probability,
                "recovery_stage_probability3": recovery_smoothed,
                "recovery_stage_prediction3": int(recovery_prediction),
                "recovery_conditional_rem_probability": recovery_conditional_rem,
                "recovery_low_confidence": context_valid_count < CONTEXT_LENGTH,
                "music_probability3": music_smoothed,
                "music_sleep_state": bool(music_sleep_state),
                "music_action": "stop" if music_sleep_state else "play",
                "autonomous_music_allowed": context_valid_count == CONTEXT_LENGTH,
            }
        )
        base["runtime_step_ms"] = (time.perf_counter_ns() - started) / 1e6
        return base, state

    def _state_metadata(self) -> dict[str, Any]:
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "config_sha256": self.config_hash,
            "model_sha256": self.model_sha256,
            "sample_rate_hz": self.sample_rate_hz,
            "chunk_samples": self.chunk_samples,
            "window_samples": self.window_samples,
            "phase_count": PHASE_COUNT,
            "context_length": CONTEXT_LENGTH,
            "model_eeg_channel_mapping": list(self.model_eeg_channel_mapping),
        }

    def state_arrays(self, state: MobileStreamState) -> dict[str, np.ndarray]:
        arrays = {
            "metadata_json": np.asarray(
                json.dumps(self._state_metadata(), sort_keys=True), dtype=np.str_
            ),
            "filter_zi": np.asarray(state.filter_zi, dtype=np.float64),
            "filter_initialized": np.asarray(
                state.filter_initialized, dtype=np.bool_
            ),
            "rolling_signal": np.asarray(state.rolling_signal, dtype=np.float32),
            "rolling_valid": np.asarray(state.rolling_valid, dtype=np.bool_),
            "rolling_count": np.asarray(state.rolling_count, dtype=np.int64),
            "chunks_seen": np.asarray(state.chunks_seen, dtype=np.int64),
            "phase_tokens": np.asarray(state.phase_tokens, dtype=np.float16),
            "phase_auxiliary": np.asarray(state.phase_auxiliary, dtype=np.float32),
            "phase_valid": np.asarray(state.phase_valid, dtype=np.bool_),
            "phase_filled": np.asarray(state.phase_filled, dtype=np.int8),
        }
        arrays.update(_decoder_arrays("standard_decoder", state.standard_decoder))
        arrays.update(_decoder_arrays("recovery_decoder", state.recovery_decoder))
        arrays.update(_control_arrays("music_controller", state.music_controller))
        return arrays

    def resident_state_bytes(self, state: MobileStreamState) -> int:
        return int(
            sum(array.nbytes for array in self.state_arrays(state).values())
        )

    def save_state(
        self,
        state: MobileStreamState,
        path: str | Path,
        compressed: bool = True,
    ) -> Path:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        with temporary.open("wb") as handle:
            writer = np.savez_compressed if compressed else np.savez
            writer(handle, **self.state_arrays(state))
        os.replace(temporary, destination)
        return destination

    def load_state(self, path: str | Path) -> MobileStreamState:
        with np.load(path, allow_pickle=False) as archive:
            metadata = json.loads(str(archive["metadata_json"]))
            if metadata != self._state_metadata():
                raise ValueError(
                    "Persisted state was created by a different config or model set"
                )
            state = MobileStreamState(
                filter_zi=np.asarray(archive["filter_zi"], dtype=np.float64).copy(),
                filter_initialized=bool(archive["filter_initialized"]),
                rolling_signal=np.asarray(
                    archive["rolling_signal"], dtype=np.float32
                ).copy(),
                rolling_valid=np.asarray(
                    archive["rolling_valid"], dtype=bool
                ).copy(),
                rolling_count=int(archive["rolling_count"]),
                chunks_seen=int(archive["chunks_seen"]),
                phase_tokens=np.asarray(
                    archive["phase_tokens"], dtype=np.float16
                ).copy(),
                phase_auxiliary=np.asarray(
                    archive["phase_auxiliary"], dtype=np.float32
                ).copy(),
                phase_valid=np.asarray(archive["phase_valid"], dtype=bool).copy(),
                phase_filled=np.asarray(
                    archive["phase_filled"], dtype=np.int8
                ).copy(),
                standard_decoder=_decoder_from_archive(
                    archive, "standard_decoder"
                ),
                recovery_decoder=_decoder_from_archive(
                    archive, "recovery_decoder"
                ),
                music_controller=_control_from_archive(
                    archive, "music_controller"
                ),
            )
        expected = self.new_state()
        for name in (
            "filter_zi",
            "rolling_signal",
            "rolling_valid",
            "phase_tokens",
            "phase_auxiliary",
            "phase_valid",
            "phase_filled",
        ):
            if getattr(state, name).shape != getattr(expected, name).shape:
                raise ValueError(f"Persisted state has invalid {name} shape")
        return state

    def state_schema(self) -> dict[str, Any]:
        empty = self.new_state()
        return {
            "schema_version": STATE_SCHEMA_VERSION,
            "serialization": "atomic compressed NPZ; allow_pickle=False",
            "compatibility_key": "config SHA-256 plus ordered ONNX model SHA-256 values",
            "arrays": {
                name: {"dtype": str(value.dtype), "shape": list(value.shape)}
                for name, value in self.state_arrays(empty).items()
            },
            "resident_state_bytes": self.resident_state_bytes(empty),
            "semantic_state": {
                "filter_zi": "four EEG channels with persistent causal SOS state",
                "rolling_signal": "latest 30 seconds of four EEG plus three accelerometer channels",
                "phase_tokens": "six 5-second phases, each holding eight contexts spaced 30 seconds apart",
                "decoders": "standard stage, recovery stage, and independent music-controller state",
            },
        }
