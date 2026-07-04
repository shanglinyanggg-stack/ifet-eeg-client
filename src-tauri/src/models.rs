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
    pub eeg1: i32,
    pub eeg2: i32,
    pub eeg3: i32,
    pub eeg4: i32,
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
    pub packet: DecodedPacket,
}
