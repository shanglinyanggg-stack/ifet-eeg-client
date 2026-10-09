#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal
from sklearn.metrics import roc_auc_score

from realtime_sleep_staging.experimental_band_alpha import (
    BAND_APERIODIC_EXPONENT,
    BANDS,
    ExperimentalBandAlphaRuntime,
    _integrate,
    _robust_reference,
    _stable_linear_detrend,
    _temporal_center,
)


DEFAULT_DATASET = Path(
    "/Users/ysl/Developer/EEGDM/result/"
    "wearable_psg_4ch_aligned_dataset_2026_06_7group_manual_human_"
    "lagcorrected_npz_2026_06_28"
)
VALIDATION_SESSIONS = (
    "sleep_2026_06_12_overnight",
    "sleep_2026_06_15_overnight",
    "sleep_2026_06_16_overnight",
)
PHASE_VALIDATION_MODULE = Path(
    "/Users/ysl/Developer/EEGDM/eegdm_v3_harness/sleep_staging/"
    "validate_ifet_band_alpha_algorithms_2026_08_24.py"
)


def _usability(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scale = np.median(np.abs(values[:, :2]), axis=2) * 1.4826
    derivative = np.diff(values[:, :2], axis=2)
    changing = np.mean(np.abs(derivative) > 1e-10, axis=2)
    derivative_scale = np.median(
        np.abs(derivative - np.median(derivative, axis=2, keepdims=True)), axis=2
    ) * 1.4826
    peak_z = np.max(np.abs(values[:, :2]), axis=2) / np.maximum(scale, 1e-9)
    jump_z = np.max(np.abs(derivative), axis=2) / np.maximum(
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


def epoch_band_shares(epoch: np.ndarray) -> tuple[np.ndarray, float]:
    windows = np.lib.stride_tricks.sliding_window_view(epoch, 800, axis=-1)
    windows = np.moveaxis(windows[..., ::100, :], -2, 0)
    temporal = windows - np.median(windows, axis=2, keepdims=True)
    spatial = windows - np.median(windows, axis=1, keepdims=True)
    spatial -= np.median(spatial, axis=2, keepdims=True)
    temporal_scale, temporal_usable = _usability(temporal)
    spatial_scale, spatial_usable = _usability(spatial)
    use_spatial = np.count_nonzero(spatial_usable, axis=1) >= 2
    analysis = np.where(use_spatial[:, None, None], spatial, temporal)
    channel_scale = np.where(use_spatial[:, None], spatial_scale, temporal_scale)
    usable = np.where(use_spatial[:, None], spatial_usable, temporal_usable)
    clean = np.mean(temporal_usable, axis=1) >= 0.5
    normalized = analysis[:, :2] / np.maximum(channel_scale[..., None], 1e-9)
    normalized[~usable] = 0.0
    normalized = _stable_linear_detrend(
        np.clip(np.nan_to_num(normalized), -50.0, 50.0)
    )
    frequencies, powers = signal.welch(
        normalized,
        fs=100,
        window="hann",
        nperseg=400,
        noverlap=300,
        detrend="constant",
        axis=-1,
        scaling="density",
    )
    centers = np.asarray([np.sqrt(low * high) for _, low, high in BANDS])
    compensation = centers**BAND_APERIODIC_EXPONENT
    scores = np.stack(
        [_integrate(powers, frequencies, low, high) for _, low, high in BANDS],
        axis=-1,
    ) * compensation
    drift = _integrate(powers, frequencies, 0.0, 0.5)
    delta = _integrate(powers, frequencies, 0.5, 2.0)
    scores[..., 0] *= np.clip(
        delta / np.maximum(delta + 2.0 * drift, 1e-12), 0.15, 1.0
    )
    totals = np.sum(np.maximum(scores, 0.0), axis=2)
    valid_channels = usable & np.isfinite(totals) & (totals > 1e-12)
    channel_shares = np.maximum(scores, 0.0) / np.maximum(totals[..., None], 1e-12)
    channel_shares[~valid_channels] = np.nan
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        shares = np.nanmedian(channel_shares, axis=1)
    shares /= np.maximum(np.nansum(shares, axis=1, keepdims=True), 1e-12)
    shares[~clean] = np.nan
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        epoch_share = np.nanmedian(shares, axis=0)
    return epoch_share, float(np.mean(clean))


def runtime_parity(epoch: np.ndarray, expected: np.ndarray) -> float:
    runtime = ExperimentalBandAlphaRuntime()
    output = None
    rows = []
    for start in range(0, epoch.shape[1], 100):
        output = runtime.step(
            epoch[:, start : start + 100], None, np.ones(min(100, epoch.shape[1] - start), bool)
        )
        if output["band_shares"] is not None:
            rows.append([output["band_shares"][name] for name, _, _ in BANDS])
    if output is None or not rows:
        raise RuntimeError("runtime parity replay produced no band shares")
    actual = np.nanmedian(np.asarray(rows), axis=0)
    actual /= np.sum(actual)
    return float(np.max(np.abs(actual - expected)))


def phase_replay() -> dict[str, object]:
    spec = importlib.util.spec_from_file_location("ifet_phase_validation", PHASE_VALIDATION_MODULE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the phase validation module")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    report: dict[str, object] = {}
    for recording in module.PHASE_RECORDINGS:
        loaded = module.load_phase_recording(recording)
        segments = module.phase_segments(loaded)
        recording_report: dict[str, object] = {}
        for state in ("open", "closed"):
            eeg = segments[state][:, 20 * 100 :]
            imu = segments[f"{state}_imu"][:, 20 * 100 :]
            runtime = ExperimentalBandAlphaRuntime()
            rows = []
            for start in range(0, eeg.shape[1] - 24, 25):
                output = runtime.step(
                    eeg[:, start : start + 25],
                    imu[:, start : start + 25],
                    np.ones(25, dtype=bool),
                )
                if output["band_shares"] is not None and runtime.band_samples_since_update == 0:
                    rows.append([output["band_shares"][name] for name, _, _ in BANDS])
            shares = np.asarray(rows, dtype=np.float64)
            recording_report[state] = {
                "windows": int(len(shares)),
                "delta_dominance": float(np.mean(np.argmax(shares, axis=1) == 0)),
                "alpha_dominance": float(np.mean(np.argmax(shares, axis=1) == 2)),
                "median_shares": {
                    name: float(np.median(shares[:, index]))
                    for index, (name, _, _) in enumerate(BANDS)
                },
            }
        report[recording.name] = recording_report
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, object]] = []
    parity_error = None
    for session_id in VALIDATION_SESSIONS:
        path = args.dataset / f"{session_id}_4ch_aligned.npz"
        with np.load(path, allow_pickle=True) as archive:
            eeg = np.asarray(archive["headset_uv"], dtype=np.float64)
            labels = np.asarray(archive["y"], dtype=np.int64)
        for index, (epoch, label) in enumerate(zip(eeg, labels)):
            shares, clean_fraction = epoch_band_shares(epoch)
            if parity_error is None and np.all(np.isfinite(shares)):
                parity_error = runtime_parity(epoch, shares)
            rows.append(
                {
                    "session_id": session_id,
                    "epoch": index,
                    "manual_stage": int(label),
                    "clean_fraction": clean_fraction,
                    **{
                        name: float(shares[band_index])
                        for band_index, (name, _, _) in enumerate(BANDS)
                    },
                }
            )

    frame = pd.DataFrame(rows)
    finite = np.isfinite(frame[[name for name, _, _ in BANDS]]).all(axis=1)
    scored = frame.loc[finite].copy()
    target = scored["manual_stage"].eq(3).to_numpy()
    values = scored[[name for name, _, _ in BANDS]].to_numpy()
    top = values.argmax(axis=1)
    wake = scored["manual_stage"].eq(0).to_numpy()
    expected_order = np.asarray([3, 2, 1, 0])
    report = {
        "schema_version": "ifet-band-alpha-r2-focused-validation/v1",
        "algorithm_package_version": "1.2.0+band-alpha-exp.20260824.2",
        "release_approved": False,
        "reason": "Focused correction replay only; the previously locked full Alpha holdout gate remains failed.",
        "psg_holdout": {
            "epochs": int(len(scored)),
            "n3_epochs": int(np.sum(target)),
            "coverage": float(np.mean(finite)),
            "delta_n3_auroc": float(roc_auc_score(target, values[:, 0])),
            "n3_delta_dominance": float(np.mean(top[target] == 0)),
            "non_n3_delta_dominance": float(np.mean(top[~target] == 0)),
            "wake_delta_dominance": float(np.mean(top[wake] == 0)),
            "wake_beta_alpha_theta_delta_exact_order": float(
                np.mean(np.all(np.argsort(-values[wake], axis=1) == expected_order, axis=1))
            ),
        },
        "open_closed_phase_replay": phase_replay(),
        "implementation_parity_max_abs_error": parity_error,
        "alpha_threshold_contract": {
            "ui_unit": "normalized_fraction_0_to_1",
            "internal_unit": "log_evidence",
            "negative_ui_threshold_allowed": False,
        },
    }
    frame.to_csv(args.output / "band_epoch_metrics.csv", index=False)
    (args.output / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
