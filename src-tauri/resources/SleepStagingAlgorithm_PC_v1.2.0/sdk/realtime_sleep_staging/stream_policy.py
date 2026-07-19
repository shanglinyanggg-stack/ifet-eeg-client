from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ControlConfig:
    ema_alpha: float
    sleep_on_threshold: float
    wake_on_threshold: float
    sleep_confirm_updates: int
    wake_confirm_updates: int


@dataclass(frozen=True)
class HierarchicalStageConfig:
    ema_alpha: float
    sleep_on_threshold: float
    wake_on_threshold: float
    sleep_confirm_updates: int
    wake_confirm_updates: int
    rem_on_threshold: float
    rem_off_threshold: float
    rem_confirm_updates: int
    nrem_confirm_updates: int

    @property
    def control(self) -> ControlConfig:
        return ControlConfig(
            self.ema_alpha,
            self.sleep_on_threshold,
            self.wake_on_threshold,
            self.sleep_confirm_updates,
            self.wake_confirm_updates,
        )
