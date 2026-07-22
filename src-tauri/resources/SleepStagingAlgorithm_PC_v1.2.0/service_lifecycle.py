from __future__ import annotations

import ctypes
import os
import sys
import time
from ctypes import wintypes
from typing import Protocol


class ShutdownServer(Protocol):
    def shutdown(self) -> None: ...


def process_is_alive(pid: int | None) -> bool:
    """Return whether the desktop host process still exists."""
    if pid is None:
        return True
    if pid <= 0:
        return False
    if sys.platform == "win32":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        process_query_limited_information = 0x1000
        still_active = 259
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and (
                exit_code.value == still_active
            )
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def watch_parent(
    server: ShutdownServer,
    parent_pid: int,
    poll_interval_seconds: float = 1.0,
) -> None:
    while process_is_alive(parent_pid):
        time.sleep(poll_interval_seconds)
    # shutdown() must be called from a thread other than serve_forever().
    server.shutdown()
