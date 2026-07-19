use crate::models::{DecodedPacket, EegSample, PpgSample};

const TD10_NOTIFICATION_BYTES: usize = 43;
const TD10_CLOCK_HZ: f64 = 125.0;
const OUTPUT_SAMPLE_RATE_HZ: f64 = 100.0;
const TD10_NOMINAL_TICKS_PER_NOTIFICATION: f64 = 4.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PacketKind {
    V8,
    Td10,
}

struct ParsedPacket {
    packet: DecodedPacket,
    kind: PacketKind,
    device_sequence: u8,
}

#[derive(Debug, Clone)]
pub struct StreamPacket {
    pub packet: DecodedPacket,
    pub valid: bool,
    pub device_sequence: Option<u8>,
}

#[derive(Default)]
pub struct PacketStreamDecoder {
    td10_previous: Option<DecodedPacket>,
    td10_previous_sequence: Option<u8>,
    td10_resample_accumulator: f64,
    output_sequence: u8,
}

impl PacketStreamDecoder {
    pub fn push(&mut self, raw: &[u8]) -> Vec<StreamPacket> {
        let Some(parsed) = parse_with_kind(raw) else {
            return Vec::new();
        };
        match parsed.kind {
            PacketKind::V8 => {
                self.clear_td10();
                vec![StreamPacket {
                    device_sequence: Some(parsed.device_sequence),
                    packet: parsed.packet,
                    valid: true,
                }]
            }
            PacketKind::Td10 => self.push_td10(parsed.packet, parsed.device_sequence),
        }
    }

    fn push_td10(&mut self, packet: DecodedPacket, device_sequence: u8) -> Vec<StreamPacket> {
        let (Some(previous), Some(previous_sequence)) =
            (self.td10_previous.as_ref(), self.td10_previous_sequence)
        else {
            self.output_sequence = device_sequence;
            let mut first = packet.clone();
            first.sequence = Some(self.output_sequence);
            self.td10_previous = Some(packet);
            self.td10_previous_sequence = Some(device_sequence);
            return vec![StreamPacket {
                packet: first,
                valid: true,
                device_sequence: Some(device_sequence),
            }];
        };

        let delta = device_sequence.wrapping_sub(previous_sequence) as usize;
        if delta == 0 || delta > 128 {
            return Vec::new();
        }
        if delta > 64 {
            self.clear_td10();
            return self.push_td10(packet, device_sequence);
        }

        let estimated_notifications =
            ((delta as f64 / TD10_NOMINAL_TICKS_PER_NOTIFICATION).round() as usize).max(1);
        let missing_notifications = estimated_notifications.saturating_sub(1);
        self.td10_resample_accumulator += delta as f64 * OUTPUT_SAMPLE_RATE_HZ / TD10_CLOCK_HZ;
        let output_count = self.td10_resample_accumulator.floor() as usize;
        self.td10_resample_accumulator -= output_count as f64;

        let mut rows = Vec::with_capacity(output_count);
        for output_index in 1..=output_count {
            let fraction = output_index as f64 / output_count.max(1) as f64;
            self.output_sequence = self.output_sequence.wrapping_add(1);
            let mut output = if output_index == output_count {
                packet.clone()
            } else {
                interpolate_packet(previous, &packet, fraction)
            };
            output.sequence = Some(self.output_sequence);
            let interpolated_device_sequence =
                previous_sequence.wrapping_add((delta as f64 * fraction).round() as u8);
            rows.push(StreamPacket {
                packet: output,
                valid: missing_notifications == 0 || output_index == output_count,
                device_sequence: Some(interpolated_device_sequence),
            });
        }

        self.td10_previous = Some(packet);
        self.td10_previous_sequence = Some(device_sequence);
        rows
    }

    fn clear_td10(&mut self) {
        self.td10_previous = None;
        self.td10_previous_sequence = None;
        self.td10_resample_accumulator = 0.0;
    }
}

#[allow(dead_code)]
pub fn parse_packet(raw: &[u8]) -> Option<DecodedPacket> {
    parse_with_kind(raw).map(|parsed| parsed.packet)
}

fn parse_with_kind(raw: &[u8]) -> Option<ParsedPacket> {
    if raw.get(..2) == Some(&[0x01, 0x29]) {
        if raw.len() != TD10_NOTIFICATION_BYTES {
            return None;
        }
        let packet = parse_fixed_layout(&raw[..39])?;
        return Some(ParsedPacket {
            device_sequence: raw[2],
            packet,
            kind: PacketKind::Td10,
        });
    }
    let packet = parse_v8(raw)?;
    let device_sequence = packet.sequence?;
    Some(ParsedPacket {
        packet,
        kind: PacketKind::V8,
        device_sequence,
    })
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

    let eeg = if frame.len() >= index + 12 {
        Some(EegSample {
            eeg1: read_u24(frame, index)?,
            eeg2: read_u24(frame, index + 3)?,
            eeg3: read_u24(frame, index + 6)?,
            eeg4: read_u24(frame, index + 9)?,
            flag: None,
        })
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
    use super::{parse_packet, PacketStreamDecoder};

    fn push_u24(buf: &mut Vec<u8>, value: u32) {
        buf.push(((value >> 16) & 0xff) as u8);
        buf.push(((value >> 8) & 0xff) as u8);
        buf.push((value & 0xff) as u8);
    }

    fn push_i16(buf: &mut Vec<u8>, value: i16) {
        buf.extend_from_slice(&value.to_be_bytes());
    }

    fn td10_frame(sequence: u8, eeg_base: u32) -> Vec<u8> {
        let mut raw = vec![0x01, 0x29, sequence];
        for value in [1, 2, 3, 4, 5, 6] {
            push_u24(&mut raw, value * 100);
        }
        push_i16(&mut raw, -12);
        push_i16(&mut raw, 345);
        push_i16(&mut raw, -678);
        for offset in 0..4 {
            push_u24(&mut raw, (eeg_base + offset) & 0x00ff_ffff);
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
    }

    #[test]
    fn parses_strict_td10_43_byte_notification_and_ignores_device_clock_tail() {
        let packet = parse_packet(&td10_frame(20, 0x00ff_ff00)).expect("TD10 packet");
        let eeg = packet.eeg.expect("TD10 EEG");
        assert_eq!(packet.sequence, Some(20));
        assert_eq!(packet.ppg.acc_x, -12);
        assert_eq!(eeg.eeg1, 0x00ff_ff00);
        assert_eq!(eeg.eeg4, 0x00ff_ff03);
        assert!(parse_packet(&td10_frame(20, 0)[..42]).is_none());
    }

    #[test]
    fn restores_td10_device_clock_to_one_hundred_hz_stream() {
        let mut decoder = PacketStreamDecoder::default();
        let mut rows = Vec::new();
        for index in 0..32_u8 {
            rows.extend(decoder.push(&td10_frame(index.wrapping_mul(4), index as u32 * 100)));
        }
        assert_eq!(rows.len(), 100);
        assert!(rows.iter().all(|row| row.valid));
        for pair in rows.windows(2) {
            assert_eq!(
                pair[1].packet.sequence.unwrap(),
                pair[0].packet.sequence.unwrap().wrapping_add(1)
            );
        }
    }

    #[test]
    fn marks_interpolated_rows_invalid_when_td10_notification_is_missing() {
        let mut decoder = PacketStreamDecoder::default();
        assert_eq!(decoder.push(&td10_frame(0, 0)).len(), 1);
        let rows = decoder.push(&td10_frame(8, 100));
        assert!(rows.len() >= 6);
        assert!(rows.iter().any(|row| !row.valid));
        assert!(rows.last().expect("endpoint").valid);
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
