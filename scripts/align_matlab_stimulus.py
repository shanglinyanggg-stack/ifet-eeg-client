#!/usr/bin/env python3
"""Align telemetry to SAVED host-logical EEG timestamps, never ADC hardware time."""
import argparse
import csv
import json
from datetime import datetime
from pathlib import Path


def epoch(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("时间戳缺少时区，不能静默按本机时区对齐")
    return parsed.timestamp()


def align(eeg_path, journal_path, output, markers=None, markers_output=None):
    events, commits = [], {}
    with journal_path.open(encoding="utf-8") as source:
        for line in source:
            row = json.loads(line)
            if row.get("record_type") == "event": events.append(row)
            elif row.get("record_type") == "commit": commits[row["event_id"]] = row
    events.sort(key=lambda row: row["event_time_unix_s"])
    results = []
    with eeg_path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        previous = None
        first_time = None
        event_index = 0
        for index, row in enumerate(reader, 1):
            current = (epoch(row["time"]), index, row)
            if first_time is None: first_time = current[0]
            if previous and current[0] < previous[0]:
                raise ValueError("EEG时间发生倒退；未生成修正文件，请先检查主机时钟/采样时间重锚")
            while event_index < len(events) and events[event_index]["event_time_unix_s"] <= current[0]:
                event = events[event_index]
                target = event["event_time_unix_s"]
                nearest = min([x for x in (previous, current) if x], key=lambda x: abs(x[0]-target))
                rate = float(nearest[2]["sampleRateHz"])
                error_ms = (nearest[0]-target)*1000
                status = "within_sample_interval"
                if previous is None and target < current[0]: status = "before_recording"
                elif abs(error_ms) > max(2/rate, 0.020)*1000: status = "gap_or_host_clock_reanchor"
                elif nearest[2].get("valid", "").lower() == "false": status = "invalid_eeg_sample"
                elif nearest[2].get("valid", "").lower() != "true": status = "unknown_eeg_validity"
                results.append(result_row(event, commits, nearest, error_ms, status, first_time))
                event_index += 1
            previous = current
        while event_index < len(events):
            event = events[event_index]
            results.append(result_row(event, commits, previous,
                (previous[0]-event["event_time_unix_s"])*1000 if previous else None,
                "after_recording" if previous else "no_eeg_samples", first_time))
            event_index += 1
    fields = ["event_id", "stimulus_id", "modality", "edge", "event_time_utc", "event_time_unix_s",
        "eeg_data_row_1based", "eeg_csv_line_1based", "eeg_time", "eeg_valid", "alignment_error_ms",
        "alignment_status", "receive_delay_ms", "event_to_primary_durable_ms", "frequency_hz",
        "intensity", "intensity_unit", "block", "trial", "duration_s", "location_json", "metadata_json",
        "event_time", "event_time_relative_s", "eeg_time_relative_s"]
    with output.open("x", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader(); writer.writerows(results)
    fixed_markers = None
    if markers:
        fixed_markers = markers_output or markers.with_name(markers.stem + "_time_fixed.csv")
        repair_markers(markers, results, fixed_markers)
    return {"events": len(events), "output": str(output),
        "corrected_markers": str(fixed_markers) if fixed_markers else None,
        "in_range_events": sum(row["alignment_status"] == "within_sample_interval" for row in results),
        "time_basis": "saved_host_logical_EEG_not_ADC_hardware"}


def result_row(event, commits, nearest, error_ms, status, first_time=None):
    source = event["event"]; meta = source["metadata"]
    reference = datetime.fromisoformat(nearest[2]["time"].replace("Z", "+00:00")) if nearest else None
    local_time = datetime.fromtimestamp(event["event_time_unix_s"], reference.tzinfo).isoformat(timespec="microseconds") if reference else None
    return {"event_id": source["event_id"], "stimulus_id": source["stimulus_id"],
        "modality": source["modality"], "edge": source["edge"],
        "event_time_utc": event["event_time_utc"], "event_time_unix_s": event["event_time_unix_s"],
        "eeg_data_row_1based": nearest[1] if nearest else None,
        "eeg_csv_line_1based": nearest[1]+1 if nearest else None,
        "eeg_time": nearest[2]["time"] if nearest else None,
        "eeg_valid": nearest[2]["valid"] if nearest else None,
        "alignment_error_ms": error_ms, "alignment_status": status,
        "receive_delay_ms": event["receive_delay_ms"],
        "event_to_primary_durable_ms": commits.get(source["event_id"], {}).get("event_to_primary_durable_ms"),
        "frequency_hz": meta.get("frequency_hz"), "intensity": meta.get("intensity"),
        "intensity_unit": meta.get("intensity_unit"), "block": meta.get("block"), "trial": meta.get("trial"),
        "duration_s": event.get("duration_s"), "location_json": json.dumps(meta.get("location"), ensure_ascii=False),
        "metadata_json": json.dumps(meta, ensure_ascii=False), "event_time": local_time,
        "event_time_relative_s": event["event_time_unix_s"]-first_time if first_time is not None else None,
        "eeg_time_relative_s": nearest[0]-first_time if nearest and first_time is not None else None}


def repair_markers(marker_path, results, output):
    """Never overwrite old records: create a corrected copy alongside them."""
    index = {row["event_id"]: row for row in results}
    with marker_path.open(encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        fields = list(reader.fieldnames or [])
        if not {"time", "participantId", "note", "sampleCount"}.issubset(fields):
            raise ValueError("marker文件缺少必要列")
        for name in ["matlabEventId", "matlabAlignmentStatus", "matlabAlignmentErrorMs", "eventTimeRelativeS"]:
            if name not in fields: fields.append(name)
        with output.open("x", encoding="utf-8-sig", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields); writer.writeheader()
            for row in reader:
                if row["participantId"] == "MATLAB":
                    try: event_id = json.loads(row["note"]).get("event_id")
                    except (json.JSONDecodeError, AttributeError): event_id = None
                    item = index.get(event_id)
                    if item:
                        if item["event_time"]: row["time"] = item["event_time"]
                        row["sampleCount"] = "" if item["alignment_status"] in {
                            "before_recording", "after_recording", "no_eeg_samples"
                        } else item["eeg_data_row_1based"]
                        row["matlabEventId"] = event_id
                        row["matlabAlignmentStatus"] = item["alignment_status"]
                        row["matlabAlignmentErrorMs"] = item["alignment_error_ms"]
                        row["eventTimeRelativeS"] = item["event_time_relative_s"]
                writer.writerow(row)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--eeg", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--markers", type=Path, help="旧版marker文件，生成新副本，不覆盖原文件")
    parser.add_argument("--markers-output", type=Path)
    args = parser.parse_args()
    output = args.output or args.events.with_name(args.events.stem + "_aligned.csv")
    print(json.dumps(align(args.eeg, args.events, output, args.markers, args.markers_output), ensure_ascii=False))
