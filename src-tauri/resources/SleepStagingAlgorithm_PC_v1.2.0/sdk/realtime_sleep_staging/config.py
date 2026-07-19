from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = PROJECT_ROOT / "configs" / "sessions.json"
DEFAULT_ALIGNMENT_CONFIG = PROJECT_ROOT / "configs" / "all_alignment_sessions.json"


@dataclass(frozen=True)
class Session:
    session_id: str
    subject_id: str
    subject_name: str
    site: str
    device_version: str
    wearable_csv: Path
    psg_edf: Path
    labels: Path
    label_format: str
    refined_offset_seconds: float
    anchor_wearable_seconds: float
    anchor_psg_seconds: float
    alignment_channel: str
    alignment_reference_abs_r: float
    validation_start_delta_seconds: float
    validation_duration_seconds: float

    @property
    def wearable_alignment_channel(self) -> str:
        return self.alignment_channel.split("~", 1)[0]

    @property
    def psg_alignment_channel(self) -> str:
        return self.alignment_channel.split("~", 1)[1]


@dataclass(frozen=True)
class StudyConfig:
    target_sample_rate_hz: int
    window_seconds: int
    step_seconds: int
    classes: tuple[str, ...]
    sessions: tuple[Session, ...]
    source_path: Path


@dataclass(frozen=True)
class AlignmentSession:
    session_id: str
    subject_id: str
    subject_name: str
    site: str
    wearable_csv: Path
    psg_edf: Path
    refined_offset_seconds: float
    anchor_wearable_seconds: float
    anchor_psg_seconds: float
    alignment_channel: str
    alignment_reference_abs_r: float
    validation_start_delta_seconds: float
    validation_duration_seconds: float

    @property
    def wearable_alignment_channel(self) -> str:
        return self.alignment_channel.split("~", 1)[0]

    @property
    def psg_alignment_channel(self) -> str:
        return self.alignment_channel.split("~", 1)[1]


@dataclass(frozen=True)
class AlignmentConfig:
    target_sample_rate_hz: int
    sessions: tuple[AlignmentSession, ...]
    excluded: tuple[dict[str, Any], ...]
    source_path: Path


def load_config(path: str | Path = DEFAULT_CONFIG) -> StudyConfig:
    source = Path(path).resolve()
    with source.open("r", encoding="utf-8") as handle:
        raw: dict[str, Any] = json.load(handle)

    def resolved(value: str) -> Path:
        return (source.parent / value).resolve()

    sessions = []
    for item in raw["sessions"]:
        item = dict(item)
        for field in ("wearable_csv", "psg_edf", "labels"):
            item[field] = resolved(item[field])
        sessions.append(Session(**item))
    return StudyConfig(
        target_sample_rate_hz=int(raw["target_sample_rate_hz"]),
        window_seconds=int(raw["window_seconds"]),
        step_seconds=int(raw["step_seconds"]),
        classes=tuple(raw["classes"]),
        sessions=tuple(sessions),
        source_path=source,
    )


def load_alignment_config(path: str | Path = DEFAULT_ALIGNMENT_CONFIG) -> AlignmentConfig:
    source = Path(path).resolve()
    with source.open("r", encoding="utf-8") as handle:
        raw: dict[str, Any] = json.load(handle)

    sessions = []
    for item in raw["sessions"]:
        item = dict(item)
        for field in ("wearable_csv", "psg_edf"):
            item[field] = (source.parent / item[field]).resolve()
        sessions.append(AlignmentSession(**item))
    return AlignmentConfig(
        target_sample_rate_hz=int(raw["target_sample_rate_hz"]),
        sessions=tuple(sessions),
        excluded=tuple(raw.get("excluded", [])),
        source_path=source,
    )
