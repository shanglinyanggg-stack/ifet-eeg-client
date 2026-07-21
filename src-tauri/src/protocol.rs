use crate::models::{DecodedPacket, EegSample, PpgSample};

const TD_FIXED_BYTES: usize = 27;
const TD_RTC_BYTES: usize = 4;
const TD_EEG_SAMPLE_BYTES: usize = 12;
const TD_SEQUENCE_CLOCK_HZ: f64 = 125.0;
pub const DEFAULT_SAMPLE_RATE_HZ: u32 = 125;

pub fn sample_interval_nanoseconds(sample_rate_hz: u32) -> i64 {
    1_000_000_000_i64 / i64::from(sample_rate_hz.max(1))
}

pub fn samples_per_notification(sample_rate_hz: u32) -> Option<usize> {
    match sample_rate_hz {
        125 => Some(1),
        250 => Some(2),
        500 => Some(4),
        1_000 => Some(8),
        _ => None,
    }
}

pub fn sample_rate_command(sample_rate_hz: u32) -> Option<[u8; 2]> {
    let parameter = match sample_rate_hz {
        125 => 0x01,
        250 => 0x02,
        500 => 0x03,
        1_000 => 0x04,
        _ => return None,
    };
    Some([0x72, parameter])
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PacketKind {
    V8,
    Td10,
}

struct ParsedNotification {
    packets: Vec<DecodedPacket>,
    kind: PacketKind,
    device_sequence: u8,
}

#[derive(Debug, Clone)]
pub struct StreamPacket {
    pub packet: DecodedPacket,
    pub valid: bool,
    pub device_sequence: Option<u8>,
}

pub struct PacketStreamDecoder {
    previous_packet: Option<DecodedPacket>,
    previous_device_sequence: Option<u8>,
    previous_notification_samples: usize,
    nominal_sequence_delta: Option<usize>,
    output_sequence: u8,
    sample_rate_hz: u32,
}

impl Default for PacketStreamDecoder {
    fn default() -> Self {
        Self::new(DEFAULT_SAMPLE_RATE_HZ)
    }
}

impl PacketStreamDecoder {
    pub fn new(sample_rate_hz: u32) -> Self {
        Self {
            previous_packet: None,
            previous_device_sequence: None,
            previous_notification_samples: 0,
            nominal_sequence_delta: None,
            output_sequence: 0,
            sample_rate_hz,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate_hz: u32) {
        if self.sample_rate_hz == sample_rate_hz {
            return;
        }
        self.sample_rate_hz = sample_rate_hz;
        self.clear_stream();
    }

    pub fn push(&mut self, raw: &[u8]) -> Vec<StreamPacket> {
        let Some(parsed) = parse_notification(raw) else {
            return Vec::new();
        };
        match parsed.kind {
            PacketKind::V8 => {
                self.clear_stream();
                self.output_sequence = parsed.device_sequence;
                self.emit_packets(parsed.packets, parsed.device_sequence, 0)
            }
            PacketKind::Td10 => self.push_td(parsed.packets, parsed.device_sequence),
        }
    }

    fn push_td(&mut self, packets: Vec<DecodedPacket>, device_sequence: u8) -> Vec<StreamPacket> {
        let notification_samples = packets.len();
        let Some(previous_sequence) = self.previous_device_sequence else {
            self.output_sequence = device_sequence;
            let rows = self.emit_packets(packets, device_sequence, 0);
            self.previous_notification_samples = notification_samples;
            return rows;
        };

        let delta = device_sequence.wrapping_sub(previous_sequence) as usize;
        if delta == 0 || delta > 128 {
            return Vec::new();
        }
        if delta > 64 {
            self.clear_stream();
            self.output_sequence = device_sequence;
            let rows = self.emit_packets(packets, device_sequence, 0);
            self.previous_notification_samples = notification_samples;
            return rows;
        }

        // 设备序号来自 125 Hz 时钟。旧固件可能每 4 tick 只上报一个 EEG
        // 端点，新固件则在同一通知中带上间隔内的全部样本。用首个正常间隔
        // 自适应通知步长，同时按实际包内样本数判断是否需要补齐，兼容两种格式。
        let nominal_delta = match self.nominal_sequence_delta {
            Some(current) if delta < current => {
                self.nominal_sequence_delta = Some(delta);
                delta
            }
            Some(current) => current,
            None => {
                self.nominal_sequence_delta = Some(delta);
                delta
            }
        };
        let estimated_notifications =
            ((delta as f64 / nominal_delta.max(1) as f64).round() as usize).max(1);
        let missing_notifications = estimated_notifications.saturating_sub(1);
        let expected_sample_distance =
            ((delta as f64 * self.sample_rate_hz as f64 / TD_SEQUENCE_CLOCK_HZ).round() as usize)
                .max(1);
        let missing_samples =
            expected_sample_distance.saturating_sub(self.previous_notification_samples);
        let mut rows = Vec::with_capacity(missing_samples + packets.len());
        if let (Some(previous), Some(next)) =
            (self.previous_packet.clone(), packets.first().cloned())
        {
            for missing_index in 0..missing_samples {
                self.output_sequence = self.output_sequence.wrapping_add(1);
                let fraction = (missing_index + 1) as f64 / (missing_samples + 1) as f64;
                let mut output = interpolate_packet(&previous, &next, fraction);
                output.sequence = Some(self.output_sequence);
                rows.push(StreamPacket {
                    packet: output,
                    // 旧单样本格式在正常通知间隔内的插值属于时钟恢复；只有
                    // 真正跳过了一个或多个通知时才计入传输丢包。
                    valid: missing_notifications == 0,
                    device_sequence: Some(previous_sequence.wrapping_add(
                        ((delta * (missing_index + 1)) / (missing_samples + 1)) as u8,
                    )),
                });
            }
        }
        rows.extend(self.emit_packets(packets, device_sequence, 1));
        self.previous_notification_samples = notification_samples;
        rows
    }

    fn emit_packets(
        &mut self,
        packets: Vec<DecodedPacket>,
        device_sequence: u8,
        sequence_increment_before_first: u8,
    ) -> Vec<StreamPacket> {
        let mut rows = Vec::with_capacity(packets.len());
        for (index, mut packet) in packets.into_iter().enumerate() {
            if index > 0 || sequence_increment_before_first > 0 {
                self.output_sequence = self.output_sequence.wrapping_add(1);
            }
            packet.sequence = Some(self.output_sequence);
            rows.push(StreamPacket {
                packet: packet.clone(),
                valid: true,
                device_sequence: Some(device_sequence),
            });
            self.previous_packet = Some(packet);
        }
        self.previous_device_sequence = Some(device_sequence);
        rows
    }

    fn clear_stream(&mut self) {
        self.previous_packet = None;
        self.previous_device_sequence = None;
        self.previous_notification_samples = 0;
        self.nominal_sequence_delta = None;
    }
}

#[allow(dead_code)]
pub fn parse_packet(raw: &[u8]) -> Option<DecodedPacket> {
    parse_notification(raw)?.packets.into_iter().next()
}

fn parse_notification(raw: &[u8]) -> Option<ParsedNotification> {
    if let Some(packets) = parse_td_packets(raw) {
        return Some(ParsedNotification {
            device_sequence: raw[2],
            packets,
            kind: PacketKind::Td10,
        });
    }
    // TD 帧长度字段不包含帧头与长度字节。已识别为 TD 尺寸但内容不完整时，
    // 不能退回旧版 V8 的“长度 + 1”规则，否则截断的多数据包会被误当作有效包。
    if raw
        .get(1)
        .is_some_and(|size| *size >= 0x29 && (*size as usize - 0x29) % TD_EEG_SAMPLE_BYTES == 0)
    {
        return None;
    }
    let packet = parse_v8(raw)?;
    let device_sequence = packet.sequence?;
    Some(ParsedNotification {
        packets: vec![packet],
        kind: PacketKind::V8,
        device_sequence,
    })
}

fn parse_td_packets(raw: &[u8]) -> Option<Vec<DecodedPacket>> {
    if raw.first().copied()? != 0x01
        || raw.len() < TD_FIXED_BYTES + TD_EEG_SAMPLE_BYTES + TD_RTC_BYTES
        || raw[1] as usize + 2 != raw.len()
    {
        return None;
    }
    let eeg_bytes = raw.len().checked_sub(TD_FIXED_BYTES + TD_RTC_BYTES)?;
    if eeg_bytes == 0 || eeg_bytes % TD_EEG_SAMPLE_BYTES != 0 {
        return None;
    }

    let base = parse_fixed_layout(&raw[..TD_FIXED_BYTES])?;
    let mut packets = Vec::with_capacity(eeg_bytes / TD_EEG_SAMPLE_BYTES);
    for sample_index in 0..(eeg_bytes / TD_EEG_SAMPLE_BYTES) {
        let offset = TD_FIXED_BYTES + sample_index * TD_EEG_SAMPLE_BYTES;
        packets.push(DecodedPacket {
            sequence: base.sequence,
            ppg: base.ppg.clone(),
            eeg: Some(parse_eeg(raw, offset)?),
        });
    }
    Some(packets)
}

fn parse_v8(raw: &[u8]) -> Option<DecodedPacket> {
    if raw.len() < 27 || raw.first().copied()? != 0x01 {
        return None;
    }
    let declared_len = raw[1] as usize + 1;
    if declared_len > raw.len() || declared_len < 27 {
        return None;
    }
    parse_fixed_layout(&raw[..declared_len])
}

fn parse_fixed_layout(frame: &[u8]) -> Option<DecodedPacket> {
    let sequence = Some(*frame.get(2)?);
    let mut index = 3;
    let ir1 = read_u24(frame, index)?;
    index += 3;
    let red1 = read_u24(frame, index)?;
    index += 3;
    let green1 = read_u24(frame, index)?;
    index += 3;
    let ir2 = read_u24(frame, index)?;
    index += 3;
    let red2 = read_u24(frame, index)?;
    index += 3;
    let green2 = read_u24(frame, index)?;
    index += 3;
    let acc_x = read_i16(frame, index)?;
    let acc_y = read_i16(frame, index + 2)?;
    let acc_z = read_i16(frame, index + 4)?;
    index += 6;

    let eeg = if frame.len() >= index + TD_EEG_SAMPLE_BYTES {
        Some(parse_eeg(frame, index)?)
    } else {
        None
    };
    Some(DecodedPacket {
        sequence,
        ppg: PpgSample {
            ir1,
            red1,
            green1,
            ir2,
            red2,
            green2,
            acc_x,
            acc_y,
            acc_z,
        },
        eeg,
    })
}

fn parse_eeg(raw: &[u8], index: usize) -> Option<EegSample> {
    Some(EegSample {
        eeg1: read_u24(raw, index)?,
        eeg2: read_u24(raw, index + 3)?,
        eeg3: read_u24(raw, index + 6)?,
        eeg4: read_u24(raw, index + 9)?,
        flag: None,
    })
}

fn interpolate_packet(left: &DecodedPacket, right: &DecodedPacket, fraction: f64) -> DecodedPacket {
    let ppg = PpgSample {
        ir1: interpolate_u32(left.ppg.ir1, right.ppg.ir1, fraction),
        red1: interpolate_u32(left.ppg.red1, right.ppg.red1, fraction),
        green1: interpolate_u32(left.ppg.green1, right.ppg.green1, fraction),
        ir2: interpolate_u32(left.ppg.ir2, right.ppg.ir2, fraction),
        red2: interpolate_u32(left.ppg.red2, right.ppg.red2, fraction),
        green2: interpolate_u32(left.ppg.green2, right.ppg.green2, fraction),
        acc_x: interpolate_i16(left.ppg.acc_x, right.ppg.acc_x, fraction),
        acc_y: interpolate_i16(left.ppg.acc_y, right.ppg.acc_y, fraction),
        acc_z: interpolate_i16(left.ppg.acc_z, right.ppg.acc_z, fraction),
    };
    let eeg = match (left.eeg.as_ref(), right.eeg.as_ref()) {
        (Some(left), Some(right)) => Some(EegSample {
            eeg1: interpolate_signed_u24(left.eeg1, right.eeg1, fraction),
            eeg2: interpolate_signed_u24(left.eeg2, right.eeg2, fraction),
            eeg3: interpolate_signed_u24(left.eeg3, right.eeg3, fraction),
            eeg4: interpolate_signed_u24(left.eeg4, right.eeg4, fraction),
            flag: right.flag,
        }),
        _ => right.eeg.clone(),
    };
    DecodedPacket {
        sequence: right.sequence,
        ppg,
        eeg,
    }
}

fn interpolate_u32(left: u32, right: u32, fraction: f64) -> u32 {
    (left as f64 + (right as f64 - left as f64) * fraction)
        .round()
        .clamp(0.0, u32::MAX as f64) as u32
}

fn interpolate_i16(left: i16, right: i16, fraction: f64) -> i16 {
    (left as f64 + (right as f64 - left as f64) * fraction)
        .round()
        .clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

fn interpolate_signed_u24(left: u32, right: u32, fraction: f64) -> u32 {
    let left = signed_u24(left) as f64;
    let right = signed_u24(right) as f64;
    encode_signed_u24((left + (right - left) * fraction).round() as i32)
}

fn signed_u24(value: u32) -> i32 {
    let value = value & 0x00ff_ffff;
    if value >= 0x0080_0000 {
        value as i32 - 0x0100_0000
    } else {
        value as i32
    }
}

fn encode_signed_u24(value: i32) -> u32 {
    (value.clamp(-0x0080_0000, 0x007f_ffff) as u32) & 0x00ff_ffff
}

fn read_u24(raw: &[u8], index: usize) -> Option<u32> {
    let bytes = raw.get(index..index + 3)?;
    Some(((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32)
}

fn read_i16(raw: &[u8], index: usize) -> Option<i16> {
    let bytes = raw.get(index..index + 2)?;
    Some(i16::from_be_bytes([bytes[0], bytes[1]]))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_packet, sample_interval_nanoseconds, sample_rate_command, PacketStreamDecoder,
    };

    fn push_u24(buf: &mut Vec<u8>, value: u32) {
        buf.push(((value >> 16) & 0xff) as u8);
        buf.push(((value >> 8) & 0xff) as u8);
        buf.push((value & 0xff) as u8);
    }

    fn push_i16(buf: &mut Vec<u8>, value: i16) {
        buf.extend_from_slice(&value.to_be_bytes());
    }

    fn td_frame(sequence: u8, eeg_bases: &[u32]) -> Vec<u8> {
        let frame_bytes = 27 + eeg_bases.len() * 12 + 4;
        let mut raw = vec![0x01, (frame_bytes - 2) as u8, sequence];
        for value in [1, 2, 3, 4, 5, 6] {
            push_u24(&mut raw, value * 100);
        }
        push_i16(&mut raw, -12);
        push_i16(&mut raw, 345);
        push_i16(&mut raw, -678);
        for eeg_base in eeg_bases {
            for offset in 0..4 {
                push_u24(&mut raw, (eeg_base + offset) & 0x00ff_ffff);
            }
        }
        raw.extend_from_slice(&[0, 0, 0, sequence]);
        raw
    }

    #[test]
    fn parses_legacy_27_byte_ppg_packet() {
        let mut raw = vec![0x01, 26, 7];
        for value in [0x010203, 0x040506, 0x070809, 0x0a0b0c, 0x0d0e0f, 0x101112] {
            push_u24(&mut raw, value);
        }
        push_i16(&mut raw, -12);
        push_i16(&mut raw, 345);
        push_i16(&mut raw, -678);
        let packet = parse_packet(&raw).expect("packet should parse");
        assert_eq!(packet.sequence, Some(7));
        assert_eq!(packet.ppg.ir1, 0x010203);
        assert_eq!(packet.ppg.acc_y, 345);
        assert!(packet.eeg.is_none());
    }

    #[test]
    fn parses_v8_39_byte_packet_without_blue_gaps_and_unsigned_eeg() {
        let mut raw = vec![0x01, 38, 9];
        for value in [0xfec82c, 0xec2c24, 0xfe1dc6, 0x010203, 0xfe6e39, 0x3e12fe] {
            push_u24(&mut raw, value);
        }
        push_i16(&mut raw, -675);
        push_i16(&mut raw, -15_362);
        push_i16(&mut raw, 23_996);
        for value in [0xf00102, 0x800001, 0x7fffff, 0xffffff] {
            push_u24(&mut raw, value);
        }
        let packet = parse_packet(&raw).expect("packet should parse");
        let eeg = packet.eeg.expect("eeg should be present");
        assert_eq!(packet.sequence, Some(9));
        assert_eq!(eeg.eeg1, 0xf00102);
        assert_eq!(eeg.eeg4, 0xffffff);
        let decoded = PacketStreamDecoder::default().push(&raw);
        assert_eq!(decoded[0].packet.sequence, Some(9));
    }

    #[test]
    fn parses_strict_td10_43_byte_notification_and_ignores_device_clock_tail() {
        let packet = parse_packet(&td_frame(20, &[0x00ff_ff00])).expect("TD10 packet");
        let eeg = packet.eeg.expect("TD10 EEG");
        assert_eq!(packet.sequence, Some(20));
        assert_eq!(packet.ppg.acc_x, -12);
        assert_eq!(eeg.eeg1, 0x00ff_ff00);
        assert_eq!(eeg.eeg4, 0x00ff_ff03);
        assert!(parse_packet(&td_frame(20, &[0])[..42]).is_none());
    }

    #[test]
    fn expands_multi_sample_notifications_for_all_supported_rates() {
        for (sample_rate, samples_per_packet) in [(125, 1), (250, 2), (500, 4), (1_000, 8)] {
            let mut decoder = PacketStreamDecoder::new(sample_rate);
            let eeg_bases = (0..samples_per_packet)
                .map(|index| index as u32 * 100)
                .collect::<Vec<_>>();
            let rows = decoder.push(&td_frame(10, &eeg_bases));
            assert_eq!(rows.len(), samples_per_packet);
            assert!(rows.iter().all(|row| row.valid));
            for (index, row) in rows.iter().enumerate() {
                assert_eq!(row.packet.eeg.as_ref().unwrap().eeg1, index as u32 * 100);
            }
            let next_bases = (0..samples_per_packet)
                .map(|index| 1_000 + index as u32 * 100)
                .collect::<Vec<_>>();
            let next_rows = decoder.push(&td_frame(11, &next_bases));
            assert_eq!(next_rows.len(), samples_per_packet);
            assert!(next_rows.iter().all(|row| row.valid));
        }
    }

    #[test]
    fn marks_each_sample_from_a_missing_multi_sample_notification_invalid() {
        let mut decoder = PacketStreamDecoder::new(500);
        assert_eq!(decoder.push(&td_frame(0, &[0, 100, 200, 300])).len(), 4);
        assert_eq!(decoder.push(&td_frame(1, &[400, 500, 600, 700])).len(), 4);
        let rows = decoder.push(&td_frame(3, &[800, 900, 1_000, 1_100]));
        assert_eq!(rows.len(), 8);
        assert!(rows[..4].iter().all(|row| !row.valid));
        assert!(rows[4..].iter().all(|row| row.valid));
    }

    #[test]
    fn preserves_legacy_sparse_td_clock_normalization_at_125_hz() {
        let mut decoder = PacketStreamDecoder::new(125);
        let mut rows = Vec::new();
        for index in 0..32_u8 {
            rows.extend(decoder.push(&td_frame(index.wrapping_mul(4), &[index as u32 * 100])));
        }
        assert_eq!(rows.len(), 125);
        assert!(rows.iter().all(|row| row.valid));
    }

    #[test]
    fn uses_exact_intervals_for_supported_sample_rates() {
        assert_eq!(sample_interval_nanoseconds(125), 8_000_000);
        assert_eq!(sample_interval_nanoseconds(250), 4_000_000);
        assert_eq!(sample_interval_nanoseconds(500), 2_000_000);
        assert_eq!(sample_interval_nanoseconds(1_000), 1_000_000);
        assert_eq!(sample_rate_command(125), Some([0x72, 0x01]));
        assert_eq!(sample_rate_command(250), Some([0x72, 0x02]));
        assert_eq!(sample_rate_command(500), Some([0x72, 0x03]));
        assert_eq!(sample_rate_command(1_000), Some([0x72, 0x04]));
        assert_eq!(sample_rate_command(100), None);
    }

    #[test]
    fn ignores_trailing_notification_bytes_beyond_declared_v8_frame() {
        let mut raw = vec![0x01, 38, 10];
        for value in [1, 2, 3, 4, 5, 6] {
            push_u24(&mut raw, value);
        }
        push_i16(&mut raw, 0);
        push_i16(&mut raw, 0);
        push_i16(&mut raw, 0);
        for value in [11, 12, 13, 14] {
            push_u24(&mut raw, value);
        }
        raw.push(0xa5);
        assert_eq!(parse_packet(&raw).unwrap().eeg.unwrap().flag, None);
    }

    #[test]
    fn rejects_short_or_wrong_header_packets() {
        assert!(parse_packet(&[0x01, 26, 7]).is_none());
        assert!(parse_packet(&[0x02, 26, 7]).is_none());
    }
}
