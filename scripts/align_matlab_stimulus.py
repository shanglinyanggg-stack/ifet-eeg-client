#!/usr/bin/env python3
"""Align telemetry to SAVED host-logical EEG timestamps, never ADC hardware time."""
import argparse
import csv
import json
from datetime import datetime
from pathlib import Path


def epoch(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def align(eeg_path, journal_path, output):
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
        event_index = 0
        for index, row in enumerate(reader, 1):
            current = (epoch(row["time"]), index, row)
            while event_index < len(events) and events[event_index]["event_time_unix_s"] <= current[0]:
                event = events[event_index]
                target = event["event_time_unix_s"]
                nearest = min([x for x in (previous, current) if x], key=lambda x: abs(x[0]-target))
                rate = float(nearest[2]["sampleRateHz"])
                error_ms = (nearest[0]-target)*1000
                status = "within_sample_interval"
                if previous is None and target < current[0]: status = "before_recording"
                elif abs(error_ms) > max(2/rate, 0.020)*1000: status = "gap_or_host_clock_reanchor"
                results.append(result_row(event, commits, nearest, error_ms, status))
                event_index += 1
            previous = current
        while event_index < len(events):
            event = events[event_index]
            results.append(result_row(event, commits, previous,
                (previous[0]-event["event_time_unix_s"])*1000 if previous else None,
                "after_recording" if previous else "no_eeg_samples"))
            event_index += 1
    fields = ["event_id", "stimulus_id", "modality", "edge", "event_time_utc", "event_time_unix_s",
        "eeg_data_row_1based", "eeg_csv_line_1based", "eeg_time", "eeg_valid", "alignment_error_ms",
        "alignment_status", "receive_delay_ms", "event_to_primary_durable_ms", "frequency_hz",
        "intensity", "intensity_unit", "block", "trial", "duration_s", "location_json", "metadata_json"]
    with output.open("x", encoding="utf-8-sig", newline="") as target:
        writer = csv.DictWriter(target, fieldnames=fields)
        writer.writeheader(); writer.writerows(results)
    return {"events": len(events), "output": str(output),
        "in_range_events": sum(row["alignment_status"] == "within_sample_interval" for row in results),
        "time_basis": "saved_host_logical_EEG_not_ADC_hardware"}


def result_row(event, commits, nearest, error_ms, status):
    source = event["event"]; meta = source["metadata"]
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
        "metadata_json": json.dumps(meta, ensure_ascii=False)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--eeg", required=True, type=Path)
    parser.add_argument("--events", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or args.events.with_name(args.events.stem + "_aligned.csv")
    print(json.dumps(align(args.eeg, args.events, output), ensure_ascii=False))
