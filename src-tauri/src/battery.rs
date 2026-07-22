use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 2026-07-23 真机测试：上位机显示 3.29 V 时设备耗尽并关机。
pub const BATTERY_EMPTY_VOLTAGE: f64 = 3.29;
/// 暂用单节锂电池常见满电端点；获得真机满电稳定电压后应再次校准。
pub const BATTERY_FULL_VOLTAGE: f64 = 4.20;
pub const BATTERY_LOW_VOLTAGE: f64 = 3.35;
const BATTERY_SMOOTHING_WINDOW: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BatteryLevel {
    Charging,
    Normal,
    Low,
    Empty,
}

impl BatteryLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Charging => "charging",
            Self::Normal => "normal",
            Self::Low => "low",
            Self::Empty => "empty",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BatteryEstimate {
    pub smoothed_voltage: f64,
    pub estimated_percent: u8,
    pub level: BatteryLevel,
}

#[derive(Default)]
pub struct BatteryEstimator {
    samples: VecDeque<(Instant, f64)>,
}

impl BatteryEstimator {
    pub fn update(&mut self, voltage: f64, charging: bool) -> BatteryEstimate {
        self.update_at(voltage, charging, Instant::now())
    }

    fn update_at(&mut self, voltage: f64, charging: bool, timestamp: Instant) -> BatteryEstimate {
        self.samples.push_back((timestamp, voltage));
        while self.samples.front().is_some_and(|(sample_time, _)| {
            timestamp.saturating_duration_since(*sample_time) > BATTERY_SMOOTHING_WINDOW
        }) {
            self.samples.pop_front();
        }

        let mut voltages = self
            .samples
            .iter()
            .map(|(_, sample_voltage)| *sample_voltage)
            .collect::<Vec<_>>();
        voltages.sort_by(f64::total_cmp);
        let middle = voltages.len() / 2;
        let smoothed_voltage = if voltages.len() % 2 == 0 {
            (voltages[middle - 1] + voltages[middle]) / 2.0
        } else {
            voltages[middle]
        };
        let estimated_percent = estimate_percent(smoothed_voltage);
        let level = if charging {
            BatteryLevel::Charging
        } else if smoothed_voltage <= BATTERY_EMPTY_VOLTAGE {
            BatteryLevel::Empty
        } else if smoothed_voltage <= BATTERY_LOW_VOLTAGE {
            BatteryLevel::Low
        } else {
            BatteryLevel::Normal
        };

        BatteryEstimate {
            smoothed_voltage,
            estimated_percent,
            level,
        }
    }
}

fn estimate_percent(voltage: f64) -> u8 {
    (((voltage - BATTERY_EMPTY_VOLTAGE) / (BATTERY_FULL_VOLTAGE - BATTERY_EMPTY_VOLTAGE) * 100.0)
        .round()
        .clamp(0.0, 100.0)) as u8
}

#[cfg(test)]
mod tests {
    use super::{BatteryEstimator, BatteryLevel};
    use std::time::{Duration, Instant};

    #[test]
    fn maps_the_measured_cutoff_to_empty_and_full_endpoint_to_one_hundred_percent() {
        let origin = Instant::now();
        let mut empty = BatteryEstimator::default();
        let empty_estimate = empty.update_at(3.29, false, origin);
        assert_eq!(empty_estimate.estimated_percent, 0);
        assert_eq!(empty_estimate.level, BatteryLevel::Empty);

        let mut full = BatteryEstimator::default();
        let full_estimate = full.update_at(4.20, false, origin);
        assert_eq!(full_estimate.estimated_percent, 100);
        assert_eq!(full_estimate.level, BatteryLevel::Normal);
    }

    #[test]
    fn median_window_rejects_a_single_voltage_sag_and_expires_old_samples() {
        let origin = Instant::now();
        let mut estimator = BatteryEstimator::default();
        estimator.update_at(3.90, false, origin);
        estimator.update_at(3.10, false, origin + Duration::from_secs(1));
        let stable = estimator.update_at(3.90, false, origin + Duration::from_secs(2));
        assert!((stable.smoothed_voltage - 3.90).abs() < f64::EPSILON);
        assert_eq!(stable.level, BatteryLevel::Normal);

        let expired = estimator.update_at(3.34, false, origin + Duration::from_secs(33));
        assert!((expired.smoothed_voltage - 3.34).abs() < f64::EPSILON);
        assert_eq!(expired.level, BatteryLevel::Low);
    }

    #[test]
    fn charging_state_takes_priority_over_low_voltage_warning() {
        let mut estimator = BatteryEstimator::default();
        let estimate = estimator.update(3.30, true);
        assert_eq!(estimate.level, BatteryLevel::Charging);
    }
}
