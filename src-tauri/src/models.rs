use crate::battery::BatteryLevel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub rssi: i16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub message: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleDiagnosticsEvent {
    pub link_request_status: String,
    pub connection_interval_ms: Option<f64>,
    pub peripheral_latency: Option<u16>,
    pub received_slot_rate_hz: f64,
    pub usable_eeg_sample_rate_hz: f64,
    pub zero_adc_slots: usize,
    pub identical_adjacent_adc_slots: usize,
    pub suspicious_notifications: usize,
    pub rtc_raw: Option<u32>,
    pub window_seconds: f64,
    pub transmit_interval_ms: u32,
    pub expected_samples_per_notification: usize,
    pub packing_confirmed: bool,
    pub notification_rate_hz: f64,
    pub observed_sample_rate_hz: f64,
    pub logical_sample_rate_hz: f64,
    pub requested_sample_rate_hz: u32,
    pub samples_per_notification: usize,
    pub buffered_notifications: usize,
    pub processing_delay_ms: i64,
    pub peak_processing_delay_ms: i64,
    pub rejected_notifications: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatteryEvent {
    pub timestamp: String,
    pub sequence: u8,
    pub charging: bool,
    pub raw_value: u32,
    pub voltage: f64,
    pub smoothed_voltage: f64,
    pub estimated_percent: u8,
    pub level: BatteryLevel,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PpgSample {
    pub ir1: u32,
    pub red1: u32,
    pub green1: u32,
    pub ir2: u32,
    pub red2: u32,
    pub green2: u32,
    pub acc_x: i16,
    pub acc_y: i16,
    pub acc_z: i16,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EegSample {
    pub eeg1: u32,
    pub eeg2: u32,
    pub eeg3: u32,
    pub eeg4: u32,
    pub flag: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedPacket {
    pub sequence: Option<u8>,
    pub ppg: PpgSample,
    pub eeg: Option<EegSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleEvent {
    pub timestamp: String,
    pub sample_rate_hz: u32,
    pub valid: bool,
    pub observed: bool,
    pub device_sequence: Option<u8>,
    pub packet: DecodedPacket,
}
