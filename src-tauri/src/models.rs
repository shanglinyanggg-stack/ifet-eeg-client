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
    pub device_sequence: Option<u8>,
    pub packet: DecodedPacket,
}
