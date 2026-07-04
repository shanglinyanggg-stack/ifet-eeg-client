use crate::models::{DecodedPacket, EegSample, PpgSample};

pub fn parse_packet(raw: &[u8]) -> Option<DecodedPacket> {
    if raw.len() < 27 || raw.first().copied()? != 0x01 {
        return None;
    }

    let declared_len = raw[1] as usize + 1;
    if declared_len > raw.len() || declared_len < 27 {
        return None;
    }
    let frame = &raw[..declared_len];
    let sequence = Some(frame[2]);
    let has_blue = frame.len() >= 33;

    let mut index = 3;
    let ir1 = read_u24(frame, index)?;
    index += 3;
    let red1 = read_u24(frame, index)?;
    index += 3;
    let green1 = read_u24(frame, index)?;
    index += 3;

    if has_blue {
        index += 3;
    }

    let ir2 = read_u24(frame, index)?;
    index += 3;
    let red2 = read_u24(frame, index)?;
    index += 3;
    let green2 = read_u24(frame, index)?;
    index += 3;

    if has_blue {
        index += 3;
    }

    let acc_x = read_i16(frame, index)?;
    let acc_y = read_i16(frame, index + 2)?;
    let acc_z = read_i16(frame, index + 4)?;
    index += 6;

    let eeg = if frame.len() >= index + 12 {
        let eeg1 = read_i24(frame, index)?;
        let eeg2 = read_i24(frame, index + 3)?;
        let eeg3 = read_i24(frame, index + 6)?;
        let eeg4 = read_i24(frame, index + 9)?;
        let flag = frame.get(index + 12).copied();
        Some(EegSample {
            eeg1,
            eeg2,
            eeg3,
            eeg4,
            flag,
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

fn read_u24(raw: &[u8], index: usize) -> Option<u32> {
    let bytes = raw.get(index..index + 3)?;
    Some(((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | bytes[2] as u32)
}

fn read_i24(raw: &[u8], index: usize) -> Option<i32> {
    let value = read_u24(raw, index)? as i32;
    if value & 0x80_0000 != 0 {
        Some(value - 0x100_0000)
    } else {
        Some(value)
    }
}

fn read_i16(raw: &[u8], index: usize) -> Option<i16> {
    let bytes = raw.get(index..index + 2)?;
    Some(i16::from_be_bytes([bytes[0], bytes[1]]))
}

#[cfg(test)]
mod tests {
    use super::parse_packet;

    fn push_u24(buf: &mut Vec<u8>, value: u32) {
        buf.push(((value >> 16) & 0xff) as u8);
        buf.push(((value >> 8) & 0xff) as u8);
        buf.push((value & 0xff) as u8);
    }

    fn push_i16(buf: &mut Vec<u8>, value: i16) {
        buf.extend_from_slice(&value.to_be_bytes());
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
        assert_eq!(packet.ppg.red1, 0x040506);
        assert_eq!(packet.ppg.green1, 0x070809);
        assert_eq!(packet.ppg.ir2, 0x0a0b0c);
        assert_eq!(packet.ppg.red2, 0x0d0e0f);
        assert_eq!(packet.ppg.green2, 0x101112);
        assert_eq!(packet.ppg.acc_x, -12);
        assert_eq!(packet.ppg.acc_y, 345);
        assert_eq!(packet.ppg.acc_z, -678);
        assert!(packet.eeg.is_none());
    }

    #[test]
    fn parses_45_byte_packet_with_blue_channels_and_eeg() {
        let mut raw = vec![0x01, 44, 9];
        for value in [
            0x010001, 0x020002, 0x030003, 0x040004, 0x050005, 0x060006, 0x070007, 0x080008,
        ] {
            push_u24(&mut raw, value);
        }
        push_i16(&mut raw, 100);
        push_i16(&mut raw, -200);
        push_i16(&mut raw, 300);
        for value in [0x000101, 0xffff00, 0x800001, 0x000404] {
            push_u24(&mut raw, value);
        }

        let packet = parse_packet(&raw).expect("packet should parse");
        let eeg = packet.eeg.expect("eeg should be present");

        assert_eq!(packet.sequence, Some(9));
        assert_eq!(packet.ppg.ir1, 0x010001);
        assert_eq!(packet.ppg.red1, 0x020002);
        assert_eq!(packet.ppg.green1, 0x030003);
        assert_eq!(packet.ppg.ir2, 0x050005);
        assert_eq!(packet.ppg.red2, 0x060006);
        assert_eq!(packet.ppg.green2, 0x070007);
        assert_eq!(packet.ppg.acc_x, 100);
        assert_eq!(packet.ppg.acc_y, -200);
        assert_eq!(packet.ppg.acc_z, 300);
        assert_eq!(eeg.eeg1, 0x000101);
        assert_eq!(eeg.eeg2, -256);
        assert_eq!(eeg.eeg3, -8_388_607);
        assert_eq!(eeg.eeg4, 0x000404);
        assert_eq!(eeg.flag, None);
    }

    #[test]
    fn parses_optional_flag_after_eeg_payload() {
        let mut raw = vec![0x01, 45, 10];
        for value in [1, 2, 3, 4, 5, 6, 7, 8] {
            push_u24(&mut raw, value);
        }
        push_i16(&mut raw, 0);
        push_i16(&mut raw, 0);
        push_i16(&mut raw, 0);
        for value in [11, 12, 13, 14] {
            push_u24(&mut raw, value);
        }
        raw.push(0xa5);

        let packet = parse_packet(&raw).expect("packet should parse");

        assert_eq!(packet.eeg.expect("eeg").flag, Some(0xa5));
    }

    #[test]
    fn rejects_short_or_wrong_header_packets() {
        assert!(parse_packet(&[0x01, 26, 7]).is_none());
        assert!(parse_packet(&[0x02, 26, 7]).is_none());
    }
}
