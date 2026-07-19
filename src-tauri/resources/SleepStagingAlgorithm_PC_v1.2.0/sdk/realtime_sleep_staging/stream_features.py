from __future__ import annotations

import numpy as np


FREQUENCY_BANDS_HZ = (
    (0.5, 2.0),
    (2.0, 4.0),
    (4.0, 6.0),
    (6.0, 8.0),
    (8.0, 10.0),
    (10.0, 12.0),
    (12.0, 16.0),
    (16.0, 20.0),
    (20.0, 25.0),
    (25.0, 30.0),
    (30.0, 35.01),
)


def _spectral_tokens(
    windows: np.ndarray,
    sample_rate_hz: int,
    frame_samples: int,
    hop_samples: int,
) -> np.ndarray:
    eeg = np.asarray(windows[:, :4], dtype=np.float32)
    eeg -= eeg.mean(axis=-1, keepdims=True)
    eeg /= eeg.std(axis=-1, keepdims=True).clip(min=1.0)
    framed = np.lib.stride_tricks.sliding_window_view(eeg, frame_samples, axis=-1)
    framed = framed[..., ::hop_samples, :]
    tapered = framed * np.hanning(frame_samples).astype(np.float32)
    power = np.square(np.abs(np.fft.rfft(tapered, axis=-1)), dtype=np.float64)
    frequencies = np.fft.rfftfreq(frame_samples, d=1.0 / sample_rate_hz)
    bands = []
    for low, high in FREQUENCY_BANDS_HZ:
        selected = (frequencies >= low) & (frequencies < high)
        bands.append(np.log10(power[..., selected].mean(axis=-1) + 1e-8))
    return np.stack(bands, axis=-1).transpose(0, 2, 1, 3).reshape(
        len(windows), framed.shape[-2], -1
    )


def _auxiliary(windows: np.ndarray, coverage: np.ndarray) -> np.ndarray:
    eeg_std = windows[:, :4].std(axis=-1).clip(min=1.0)
    acceleration = np.sqrt(np.square(windows[:, 4:7], dtype=np.float64).sum(axis=1))
    acceleration_std = acceleration.std(axis=-1).clip(min=1.0)
    return np.concatenate(
        (
            np.log10(eeg_std + 1.0),
            np.log10(acceleration_std + 1.0)[:, None],
            coverage.astype(np.float32)[:, None],
        ),
        axis=1,
    ).astype(np.float32)


def frozen_sleeptransformer_features(
    windows: np.ndarray,
    coverage: np.ndarray,
    sample_rate_hz: int,
    frame_samples: int,
    hop_samples: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Reproduce the deployed checkpoints without mutating persistent buffers."""

    temporary = np.asarray(windows, dtype=np.float32).copy()
    tokens = _spectral_tokens(
        temporary, sample_rate_hz, frame_samples, hop_samples
    ).astype(np.float16)
    auxiliary = _auxiliary(temporary, np.asarray(coverage, dtype=np.float32))
    return tokens, auxiliary
