from __future__ import annotations

import argparse
import json
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np

from .config import PROJECT_ROOT
from .mobile_stream_runtime import MobileStreamRuntime, MobileStreamState


DEFAULT_CONFIG = (
    PROJECT_ROOT
    / "artifacts/baselines/nested_raw_fusion_5seeds/deployment_all_subjects"
    / "desktop_upper_package/online_pipeline_config.desktop.json"
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


class DesktopUpperRuntime:
    """Thread-safe local service adapter for the strict 5-second runtime."""

    def __init__(
        self,
        pipeline_config: str | Path = DEFAULT_CONFIG,
        state_path: str | Path | None = None,
        restore: bool = True,
        intra_op_threads: int = 1,
    ) -> None:
        self.runtime = MobileStreamRuntime(
            pipeline_config,
            providers=["CPUExecutionProvider"],
            intra_op_threads=intra_op_threads,
            model_config_key="onnx_fp32_branches",
            fallback_model_filename="cnn_sleeptransformer_branches_fp32.onnx",
        )
        self.state_path = Path(state_path).resolve() if state_path else None
        self.session_path = (
            self.state_path.with_suffix(self.state_path.suffix + ".session.json")
            if self.state_path
            else None
        )
        self.state: MobileStreamState = self.runtime.new_state()
        self.session_id: str | None = None
        self.lock = threading.RLock()
        if restore and self.state_path and self.state_path.exists():
            self.load_state()

    def reset(self, session_id: str | None = None) -> dict[str, Any]:
        with self.lock:
            self.state = self.runtime.new_state()
            self.session_id = session_id
            if self.state_path:
                self.save_state()
            return self.status()

    def status(self) -> dict[str, Any]:
        return {
            "service": "desktop_upper_sleep_staging",
            "algorithm": self.runtime.config.get("selected_algorithm"),
            "session_id": self.session_id,
            "chunks_seen": self.state.chunks_seen,
            "decision_ready": self.state.rolling_count == self.runtime.window_samples,
            "sample_rate_hz": self.runtime.sample_rate_hz,
            "step_seconds": self.runtime.step_seconds,
            "window_seconds": self.runtime.window_seconds,
            "providers": [session.get_providers() for session in self.runtime.sessions],
            "state_persistence": self.state_path is not None,
        }

    def step(
        self,
        eeg_5s: Any,
        imu_5s: Any,
        valid_5s: Any | None = None,
        session_id: str | None = None,
        timestamp: Any | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            if session_id is not None:
                if self.session_id is None:
                    self.session_id = str(session_id)
                elif str(session_id) != self.session_id:
                    self.state = self.runtime.new_state()
                    self.session_id = str(session_id)
            prediction, self.state = self.runtime.stream_step(
                np.asarray(eeg_5s, dtype=np.float32),
                np.asarray(imu_5s, dtype=np.float32),
                self.state,
                None if valid_5s is None else np.asarray(valid_5s, dtype=bool),
            )
            response: dict[str, Any] = {
                "api_version": 1,
                "session_id": self.session_id,
                "timestamp": timestamp,
                **prediction,
            }
            if prediction.get("decision_valid"):
                stage = int(prediction["stage_decoder_prediction3"])
                labels = ("W", "NREM", "REM")
                sleep_detected = stage != 0
                response.update(
                    {
                        "selected_prediction3": stage,
                        "selected_stage": labels[stage],
                        "sleep_detected": sleep_detected,
                        "selected_sleep_probability": float(
                            np.asarray(prediction["stage_decoder_probability3"])[1:].sum()
                        ),
                        "intervention_action_candidate": (
                            "stop_music" if sleep_detected else "play_music"
                        ),
                        "intervention_action": (
                            "stop_music" if sleep_detected else "play_music"
                        )
                        if prediction.get("autonomous_music_allowed", False)
                        else "hold_previous_state",
                    }
                )
            else:
                response.update(
                    {
                        "selected_prediction3": None,
                        "selected_stage": None,
                        "sleep_detected": None,
                        "selected_sleep_probability": None,
                        "intervention_action_candidate": "hold_previous_state",
                        "intervention_action": "hold_previous_state",
                    }
                )
            if self.state_path:
                self.save_state()
            return _jsonable(response)

    def save_state(self) -> dict[str, Any]:
        if self.state_path is None or self.session_path is None:
            raise RuntimeError("No state path was configured")
        with self.lock:
            # Desktop disks do not need compression for this small state.  An
            # uncompressed atomic NPZ avoids making disk I/O the critical path
            # while remaining directly readable by the shared loader.
            self.runtime.save_state(self.state, self.state_path, compressed=False)
            temporary = self.session_path.with_suffix(self.session_path.suffix + ".tmp")
            temporary.write_text(
                json.dumps({"session_id": self.session_id}, ensure_ascii=False),
                encoding="utf-8",
            )
            os.replace(temporary, self.session_path)
            return {
                "state_path": str(self.state_path),
                "session_id": self.session_id,
                "chunks_seen": self.state.chunks_seen,
            }

    def load_state(self) -> dict[str, Any]:
        if self.state_path is None or self.session_path is None:
            raise RuntimeError("No state path was configured")
        with self.lock:
            self.state = self.runtime.load_state(self.state_path)
            metadata = (
                json.loads(self.session_path.read_text(encoding="utf-8"))
                if self.session_path.exists()
                else {}
            )
            self.session_id = metadata.get("session_id")
            return self.status()


class _Handler(BaseHTTPRequestHandler):
    runtime: DesktopUpperRuntime
    maximum_body_bytes = 8 * 1024 * 1024

    def _send(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(_jsonable(payload), ensure_ascii=False, allow_nan=False).encode(
            "utf-8"
        )
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
                result = self.runtime.step(
                    payload["eeg_5s"],
                    payload["imu_5s"],
                    payload.get("valid_5s"),
                    payload.get("session_id"),
                    payload.get("timestamp"),
                )
            elif self.path == "/reset":
                result = self.runtime.reset(payload.get("session_id"))
            elif self.path == "/state/save":
                result = self.runtime.save_state()
            elif self.path == "/state/load":
                result = self.runtime.load_state()
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


def serve(
    runtime: DesktopUpperRuntime, host: str = "127.0.0.1", port: int = 8765
) -> None:
    handler = type("DesktopUpperHandler", (_Handler,), {"runtime": runtime})
    server = ThreadingHTTPServer((host, port), handler)
    print(
        json.dumps(
            {
                "service": "desktop_upper_sleep_staging",
                "url": f"http://{host}:{port}",
                "health": f"http://{host}:{port}/health",
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
    parser = argparse.ArgumentParser(description="Serve strict online staging to a desktop upper computer")
    parser.add_argument("--pipeline-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--state-path",
        type=Path,
        default=PROJECT_ROOT / "runtime_state/desktop_upper_sleep_state.npz",
    )
    parser.add_argument("--no-restore", action="store_true")
    parser.add_argument("--intra-op-threads", type=int, default=1)
    args = parser.parse_args()
    runtime = DesktopUpperRuntime(
        args.pipeline_config,
        args.state_path,
        restore=not args.no_restore,
        intra_op_threads=args.intra_op_threads,
    )
    serve(runtime, args.host, args.port)


if __name__ == "__main__":
    main()
