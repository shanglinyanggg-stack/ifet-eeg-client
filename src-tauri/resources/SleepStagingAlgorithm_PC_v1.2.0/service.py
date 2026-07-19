from __future__ import annotations

import argparse
import json
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "sdk"))

from realtime_sleep_staging.demo_signal_flags import (  # noqa: E402
    DemoSignalFlagger,
)
from realtime_sleep_staging.desktop_upper_runtime import (  # noqa: E402
    DesktopUpperRuntime,
)


def _jsonable(value: Any) -> Any:
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


class DemoRuntime:
    """Thread-safe HTTP adapter for the independent Alpha/blink state machines."""

    def __init__(self) -> None:
        self.detector = DemoSignalFlagger(input_prefiltered=False)
        self.session_id: str | None = None
        self.lock = threading.RLock()
        self.blink_calibration_status = "idle"
        self.blink_calibration_failure_reason: str | None = None
        self.last_packet = self._empty_packet()

    def status(self) -> dict[str, Any]:
        config = self.detector.config
        return {
            "schema_version": "headset-demo-flags/v9",
            "algorithm_version": "1.0.21",
            "session_id": self.session_id,
            "sample_rate_hz": config.sample_rate_hz,
            "recommended_step_milliseconds": 500,
            "calibration_seconds": config.calibration_seconds,
            "closed_eye_calibration_seconds": config.closed_eye_calibration_seconds,
            "blink_calibration_seconds": config.blink_calibration_seconds,
            "blink_quiet_baseline_seconds": config.blink_quiet_baseline_seconds,
            "blink_calibration_requires_explicit_start": True,
            "input_prefiltered": self.detector.input_prefiltered,
            "last_packet": self.last_packet,
        }

    def reset(
        self,
        session_id: str | None = None,
        blink_interaction_enabled: bool = False,
    ) -> dict[str, Any]:
        with self.lock:
            self.detector.reset()
            self.session_id = None if session_id is None else str(session_id)
            self.blink_calibration_status = "idle"
            self.blink_calibration_failure_reason = None
            if blink_interaction_enabled:
                self.detector.set_blink_interaction_enabled(True)
            self.last_packet = self._empty_packet(blink_interaction_enabled)
            return self.last_packet

    def set_blink_interaction_enabled(
        self,
        enabled: bool,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_session(session_id)
            self.detector.set_blink_interaction_enabled(bool(enabled))
            self.last_packet = self._decorate_packet(self.last_packet)
            return self.last_packet

    def begin_blink_calibration(
        self,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_session(session_id)
            self.detector.begin_blink_calibration()
            self.blink_calibration_status = "running"
            self.blink_calibration_failure_reason = None
            self.last_packet = self._decorate_packet(self.last_packet)
            return self.last_packet

    def begin_alpha_calibration(
        self,
        kind: str,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_session(session_id)
            if kind == "open-eye":
                self.detector.begin_open_eye_calibration()
            elif kind == "closed-eye":
                self.detector.begin_closed_eye_calibration()
            else:
                raise ValueError("alpha calibration kind must be open-eye or closed-eye")
            self.last_packet = self._decorate_packet(self.last_packet)
            return self.last_packet

    def configure(
        self,
        alpha_volume_mode: str | int | None = None,
        session_active: bool | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_session(session_id)
            if alpha_volume_mode is not None:
                self.detector.set_alpha_volume_mode(alpha_volume_mode)
            if session_active is not None:
                self.detector.set_session_active(bool(session_active))
            self.last_packet = self._decorate_packet(self.last_packet)
            return self.last_packet

    def step(
        self,
        eeg: Any,
        imu: Any | None = None,
        valid: Any | None = None,
        session_id: str | None = None,
        timestamp: Any | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            self._ensure_session(session_id)
            output = self.detector.stream_step(
                np.asarray(eeg, dtype=np.float32),
                None if imu is None else np.asarray(imu, dtype=np.float32),
                None if valid is None else np.asarray(valid, dtype=bool),
            )
            self._sync_blink_calibration_status(output.events)
            self.last_packet = self._decorate_packet({
                **output.to_packet(),
                "session_id": self.session_id,
                "source_timestamp": timestamp,
            })
            return self.last_packet

    def _ensure_session(self, session_id: str | None) -> None:
        if session_id is None:
            return
        incoming = str(session_id)
        if self.session_id is None:
            self.session_id = incoming
        elif self.session_id != incoming:
            self.reset(incoming)

    def _sync_blink_calibration_status(self, events: Any) -> None:
        flags = {event.flag for event in events}
        if "BLINK_CALIBRATION_COMPLETE" in flags:
            self.blink_calibration_status = "complete"
            self.blink_calibration_failure_reason = None
            return
        if "BLINK_CALIBRATION_FAILED" not in flags:
            return
        profile = self.detector.calibration_profile()
        config = self.detector.config
        peak_count = int(profile.get("blink_peak_count", 0))
        consensus = float(profile.get("blink_consensus", 0.0))
        minimum_consensus = float(config.blink_calibration_minimum_consensus)
        self.blink_calibration_status = "failed"
        if peak_count < 5:
            self.blink_calibration_failure_reason = "insufficient_dual_channel_peaks"
        elif consensus < minimum_consensus:
            self.blink_calibration_failure_reason = "insufficient_dual_channel_consensus"
        else:
            self.blink_calibration_failure_reason = "calibration_quality_gate_failed"

    def _decorate_packet(self, packet: dict[str, Any]) -> dict[str, Any]:
        profile = self.detector.calibration_profile()
        state = dict(packet.get("state", {}))
        state.update(
            {
                "alpha_present": bool(
                    packet.get("state", {}).get("alpha_present", False)
                    and self.detector.calibration_complete
                ),
                "calibration_complete": self.detector.calibration_complete,
                "calibration_progress": self.detector.calibration_progress,
                "closed_eye_calibration_complete": (
                    self.detector.closed_eye_calibration_complete
                ),
                "closed_eye_calibration_progress": (
                    self.detector.closed_eye_calibration_progress
                ),
                "blink_calibration_complete": self.detector.blink_calibration_complete,
                "blink_calibration_progress": self.detector.blink_calibration_progress,
                "blink_calibration_status": self.blink_calibration_status,
                "blink_calibration_failure_reason": self.blink_calibration_failure_reason,
                "blink_interaction_enabled": self.detector.blink_interaction_enabled,
                "blink_dual_channel_required": True,
                "blink_baseline_stale": bool(profile.get("blink_baseline_stale", False)),
                "blink_baseline_frozen": bool(profile.get("blink_baseline_frozen", False)),
                "blink_control_ready": bool(profile.get("blink_control_ready", False)),
                "blink_stabilization_remaining_seconds": float(
                    profile.get("blink_stabilization_remaining_seconds", 0.0)
                ),
                "blink_group_decoder_enabled": bool(
                    profile.get("blink_group_decoder_enabled", True)
                ),
            }
        )
        telemetry = dict(packet.get("telemetry", {}))
        telemetry.update(
            {
                "open_eye_alpha_baseline": profile.get("center"),
                "closed_eye_alpha_reference": profile.get("closed_eye_reference"),
                "alpha_volume_mode": self.detector.alpha_volume_mode,
                "alpha_step_count": (
                    0
                    if self.detector.alpha_volume_mode == "smooth"
                    else int(self.detector.alpha_volume_mode)
                ),
                "recommended_volume": self.detector.recommended_volume,
                "blink_calibration_peak_count": profile.get("blink_peak_count", 0),
                "blink_calibration_consensus_fraction": profile.get("blink_consensus", 0.0),
                "blink_threshold_robust_z": profile.get("blink_threshold_robust_z"),
                "blink_rearm_robust_z": profile.get("blink_rearm_robust_z"),
                "blink_motion_std_threshold": profile.get("blink_motion_std_threshold"),
                "blink_enabled_channel_pairs": profile.get("blink_enabled_channel_pairs", []),
                "blink_invalid_gap_rejections": profile.get("blink_invalid_gap_rejections", 0),
                "blink_baseline_health_checks": profile.get("blink_baseline_health_checks", 0),
                "blink_gap_recoveries": profile.get("blink_gap_recoveries", 0),
                "open_eye_alpha_initial_baseline": profile.get("initial_center"),
                "alpha_on_threshold": profile.get("on_threshold"),
                "alpha_off_threshold": profile.get("off_threshold"),
                "blink_baseline_recovery_progress": profile.get(
                    "blink_baseline_recovery_progress", 0.0
                ),
                "blink_baseline_recoveries": profile.get(
                    "blink_baseline_recoveries", 0
                ),
                "blink_runtime_disabled_pairs": profile.get(
                    "blink_runtime_disabled_channel_pairs", []
                ),
                "blink_burst_rejections": profile.get("blink_burst_rejections", 0),
                "blink_template_ready": profile.get("blink_template_ready", False),
                "blink_template_correlation": profile.get(
                    "blink_template_last_correlation"
                ),
                "blink_template_matches": profile.get("blink_template_matches", 0),
                "blink_template_rejections": profile.get(
                    "blink_template_rejections", 0
                ),
                "blink_group_evaluations": profile.get("blink_group_evaluations", 0),
                "blink_group_commands": profile.get("blink_group_commands", 0),
                "blink_group_rejections": profile.get("blink_group_rejections", 0),
            }
        )
        if not self.detector.calibration_complete:
            telemetry.update(
                {
                    "alpha_ratio": None,
                    "alpha_score": None,
                    "alpha_level": None,
                    "alpha_step": 0,
                }
            )
        state_flags = [
            flag
            for flag in packet.get("state_flags", [])
            if flag
            not in {
                "CALIBRATION_COMPLETE",
                "CLOSED_EYE_CALIBRATION_COMPLETE",
                "BLINK_INTERACTION_ENABLED",
            }
        ]
        if self.detector.calibration_complete:
            state_flags.append("CALIBRATION_COMPLETE")
        if self.detector.closed_eye_calibration_complete:
            state_flags.append("CLOSED_EYE_CALIBRATION_COMPLETE")
        if self.detector.blink_interaction_enabled:
            state_flags.append("BLINK_INTERACTION_ENABLED")
        return {
            **packet,
            "schema_version": "headset-demo-flags/v9",
            "state": state,
            "telemetry": telemetry,
            "state_flags": list(dict.fromkeys(state_flags)),
        }

    def _empty_packet(
        self, blink_interaction_enabled: bool = False
    ) -> dict[str, Any]:
        return {
            "schema_version": "headset-demo-flags/v9",
            "session_id": self.session_id,
            "timestamp_ms": 0,
            "source_timestamp": None,
            "action_flags": [],
            "state_flags": [],
            "state": {
                "alpha_present": False,
                "calibration_complete": False,
                "calibration_progress": 0.0,
                "closed_eye_calibration_complete": False,
                "closed_eye_calibration_progress": 0.0,
                "blink_calibration_complete": False,
                "blink_calibration_progress": 0.0,
                "blink_calibration_status": self.blink_calibration_status,
                "blink_calibration_failure_reason": self.blink_calibration_failure_reason,
                "blink_interaction_enabled": blink_interaction_enabled,
                "blink_count_pending": 0,
                "blink_dual_channel_required": True,
                "blink_baseline_stale": False,
                "blink_baseline_frozen": False,
                "blink_control_ready": False,
                "blink_stabilization_remaining_seconds": 0.0,
                "blink_group_decoder_enabled": True,
            },
            "telemetry": {
                "alpha_ratio": None,
                "alpha_score": None,
                "alpha_level": None,
                "alpha_step": 0,
                "alpha_step_count": 3,
                "alpha_volume_mode": "3",
                "recommended_volume": 0.0,
                "signal_quality": 0.0,
                "selected_alpha_channels": [],
                "alpha_channel_weights": [],
                "alpha_channel_switches": 0,
                "open_eye_alpha_baseline": None,
                "closed_eye_alpha_reference": None,
                "open_eye_alpha_initial_baseline": None,
                "alpha_on_threshold": None,
                "alpha_off_threshold": None,
                "adaptive_baseline_updates": 0,
                "blink_strength_z": None,
                "blink_width_seconds": None,
                "blink_adaptive_baseline_updates": 0,
                "blink_single_channel_rejections": 0,
                "blink_calibration_peak_count": 0,
                "blink_calibration_consensus_fraction": 0.0,
                "blink_threshold_robust_z": None,
                "blink_rearm_robust_z": None,
                "blink_motion_std_threshold": None,
                "blink_enabled_channel_pairs": [],
                "blink_invalid_gap_rejections": 0,
                "blink_baseline_health_checks": 0,
                "blink_gap_recoveries": 0,
                "blink_baseline_recovery_progress": 0.0,
                "blink_baseline_recoveries": 0,
                "blink_runtime_disabled_pairs": [],
                "blink_burst_rejections": 0,
                "blink_template_ready": False,
                "blink_template_correlation": None,
                "blink_template_matches": 0,
                "blink_template_rejections": 0,
                "blink_group_evaluations": 0,
                "blink_group_commands": 0,
                "blink_group_rejections": 0,
            },
            "events": [],
        }


class CombinedRuntime:
    def __init__(
        self,
        pipeline_config: Path,
        state_path: Path,
        restore: bool,
        intra_op_threads: int,
    ) -> None:
        self.staging = DesktopUpperRuntime(
            pipeline_config=pipeline_config,
            state_path=state_path,
            restore=restore,
            intra_op_threads=intra_op_threads,
        )
        self.demo = DemoRuntime()

    def status(self) -> dict[str, Any]:
        return {
            **self.staging.status(),
            "api_version": 2,
            "demo": self.demo.status(),
        }


class _Handler(BaseHTTPRequestHandler):
    runtime: CombinedRuntime
    maximum_body_bytes = 8 * 1024 * 1024

    def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(
            _jsonable(payload), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > self.maximum_body_bytes:
            raise ValueError("Request body is empty or too large")
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self._send(HTTPStatus.OK, self.runtime.status())

    def do_POST(self) -> None:  # noqa: N802
        try:
            payload = self._body()
            if self.path == "/step":
                result = self.runtime.staging.step(
                    payload["eeg_5s"],
                    payload["imu_5s"],
                    payload.get("valid_5s"),
                    payload.get("session_id"),
                    payload.get("timestamp"),
                )
            elif self.path == "/reset":
                result = self.runtime.staging.reset(payload.get("session_id"))
            elif self.path == "/state/save":
                result = self.runtime.staging.save_state()
            elif self.path == "/state/load":
                result = self.runtime.staging.load_state()
            elif self.path == "/demo/reset":
                result = self.runtime.demo.reset(
                    payload.get("session_id"),
                    bool(payload.get("blink_interaction_enabled", False)),
                )
            elif self.path == "/demo/blink":
                result = self.runtime.demo.set_blink_interaction_enabled(
                    bool(payload["enabled"]),
                    payload.get("session_id"),
                )
            elif self.path == "/demo/blink-calibration":
                action = str(payload.get("action", "start")).strip().lower()
                if action not in {"start", "restart"}:
                    raise ValueError("blink calibration action must be start or restart")
                result = self.runtime.demo.begin_blink_calibration(
                    payload.get("session_id"),
                )
            elif self.path == "/demo/alpha-calibration":
                result = self.runtime.demo.begin_alpha_calibration(
                    str(payload.get("kind", "")).strip().lower(),
                    payload.get("session_id"),
                )
            elif self.path == "/demo/config":
                result = self.runtime.demo.configure(
                    payload.get("alpha_volume_mode"),
                    payload.get("session_active"),
                    payload.get("session_id"),
                )
            elif self.path == "/demo/step":
                result = self.runtime.demo.step(
                    payload["eeg"],
                    payload.get("imu"),
                    payload.get("valid"),
                    payload.get("session_id"),
                    payload.get("timestamp"),
                )
            else:
                self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            self._send(HTTPStatus.OK, result)
        except (KeyError, TypeError, ValueError, RuntimeError) as error:
            self._send(
                HTTPStatus.BAD_REQUEST,
                {"error": type(error).__name__, "message": str(error)},
            )

    def log_message(self, format: str, *args: Any) -> None:
        return


def serve(runtime: CombinedRuntime, host: str, port: int) -> None:
    handler = type("IfetSleepRuntimeHandler", (_Handler,), {"runtime": runtime})
    server = ThreadingHTTPServer((host, port), handler)
    print(
        json.dumps(
            {
                "service": "desktop_upper_sleep_staging",
                "url": f"http://{host}:{port}",
                "health": f"http://{host}:{port}/health",
                "demo_schema": "headset-demo-flags/v9",
                "blink_algorithm": "1.0.21",
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Causal sleep and demo signal service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-restore", action="store_true")
    parser.add_argument("--intra-op-threads", type=int, default=1)
    parser.add_argument("--state-path", type=Path)
    args = parser.parse_args()
    runtime = CombinedRuntime(
        pipeline_config=ROOT / "config/online_pipeline_config.json",
        state_path=args.state_path or ROOT / "runtime_state/sleep_state.npz",
        restore=not args.no_restore,
        intra_op_threads=args.intra_op_threads,
    )
    serve(runtime, args.host, args.port)


if __name__ == "__main__":
    main()
