#!/usr/bin/env python3
"""Production native TCP receiver timing with a simulated PTB clock, no physical stimuli."""
import argparse
import csv
import json
import socket
import subprocess
import time
from pathlib import Path
from align_matlab_stimulus import align


def percentiles(values):
    ordered = sorted(values)
    return {"n": len(values), "median_ms": ordered[len(ordered)//2],
        "p95_ms": ordered[min(len(ordered)-1, int(len(ordered)*0.95))], "maximum_ms": max(ordered)}


def run(binary, output, port):
    output.mkdir(parents=True, exist_ok=True)
    host = subprocess.Popen([str(binary), str(output), str(port), "30"], stdout=subprocess.PIPE, text=True, encoding="utf-8")
    initial = json.loads(host.stdout.readline())
    cfg = json.loads((output/"connection.json").read_text(encoding="utf-8"))
    connection = socket.create_connection(("127.0.0.1", port), timeout=3)
    connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    reader = connection.makefile("rb")
    def exchange(message, split=False):
        message["token"] = cfg["token"]
        data = (json.dumps(message, ensure_ascii=False)+"\n").encode()
        if split:
            cut = len(data)//2
            connection.sendall(data[:cut]); time.sleep(0.002); connection.sendall(data[cut:])
        else: connection.sendall(data)
        return json.loads(reader.readline())
    session = "software-probe-"+str(time.time_ns())
    assert exchange({"type":"hello", "session_id":session})["type"] == "hello_ack"
    best = None
    for k in range(40):
        before = time.perf_counter()
        pong = exchange({"type":"ping", "request_id":str(k)})
        after = time.perf_counter()
        rtt = (after-before)-(pong["server_send_unix_s"]-pong["server_receive_unix_s"])
        offset = ((pong["server_receive_unix_s"]-before)+(pong["server_send_unix_s"]-after))/2
        if best is None or rtt < best[0]: best = (rtt, offset)
    sequence = 0; rows=[]; dedup=0
    for trial in range(300):
        modality = "audio" if trial%2 == 0 else "light"
        for edge in ("start", "stop"):
            sequence += 1
            source_time = time.perf_counter()
            injected = trial%30 == 0 and edge == "start"
            split = trial%30 == 1 and edge == "start"
            if injected: time.sleep(0.025)
            event = {"event_id":f"probe-{sequence}", "session_id":session, "sequence":sequence,
                "stimulus_id":f"trial-{trial}", "modality":modality, "edge":edge,
                "source_time":source_time,"clock_offset_s":best[1],"sync_uncertainty_s":max(0.0001,best[0]/2),
                "clock_id":cfg["clock_id"],"timestamp_source":"simulated_GetSecs_not_MATLAB_or_physical",
                "metadata":{"frequency_hz":80 if modality=="audio" else 40,"intensity":0.5,
                    "intensity_unit":"synthetic_uncalibrated","block":1,"trial":trial,
                    "location":{"screen_index":0,"rect_px":[0,0,10,10]} if modality=="light" else {"channels":["left","right"]}}}
            send_start = time.perf_counter()
            ack = exchange({"type":"event","event":event}, split)
            ack_received = time.perf_counter()
            assert ack.get("type") == "event_ack", ack
            rows.append({"event_id":event["event_id"],"edge":edge,"modality":modality,
                "injected_25ms_delay":injected,"fragmented_2ms":split,
                "receive_ms":ack["receive_delay_ms"],"durable_ms":ack["event_to_durable_ms"],
                "source_to_client_ack_ms":(ack_received-source_time)*1000,
                "send_to_client_ack_ms":(ack_received-send_start)*1000})
            if trial%10==0:
                duplicate = exchange({"type":"event","event":event})
                assert duplicate["duplicate"] is True; dedup += 1
    # Unpaired stop, wrong clock, wrong credentials: reject without a new marker.
    sequence += 1
    invalid = dict(event, event_id="unpaired",stimulus_id="absent",sequence=sequence)
    assert exchange({"type":"event","event":invalid})["type"] == "error"
    assert exchange({"type":"event","event":dict(invalid,clock_id="old")})["type"] == "error"
    connection.sendall(b'{"type":"ping","token":"wrong"}\n')
    assert json.loads(reader.readline())["type"] == "error"
    assert exchange({"type":"finish","session_id":session})["type"] == "finish_ack"
    connection.close(); reader.close()
    final = json.loads(host.stdout.readline()); assert host.wait(timeout=40)==0
    assert final["event_count"] == 600 and final["active_stimuli"] == 0
    primary = [row for row in rows if not row["injected_25ms_delay"] and not row["fragmented_2ms"]]
    alignment = align(output/"probe_eeg.csv", Path(initial["event_path"]), output/"probe_stimulus_aligned.csv")
    native_path = Path(initial["event_path"]).with_name(Path(initial["event_path"]).stem+"_aligned.csv")
    with native_path.open(encoding="utf-8-sig", newline="") as source:
        native_positions = {row["event_id"]:row["eeg_data_row_1based"] for row in csv.DictReader(source)}
    with (output/"probe_stimulus_aligned.csv").open(encoding="utf-8-sig", newline="") as source:
        reference_positions = {row["event_id"]:row["eeg_data_row_1based"] for row in csv.DictReader(source)}
    assert len(native_positions) == 600 and native_positions == reference_positions, "Native and independent reference EEG positions differ"
    report = {"test_kind":"native_production_receiver_software_loopback_with_synthetic_1kHz_CSV_writer",
        "physical_stimulus_measured":False, "MATLAB_executed":False,"BLE_device_connected":False,
        "event_count":final["event_count"],"duplicate_retries_verified":dedup,"closed_pairs":300,
        "sync_uncertainty_ms":max(0.1,best[0]*500),
        "ordinary_receive":percentiles([r["receive_ms"] for r in primary]),
        "ordinary_durable":percentiles([r["durable_ms"] for r in primary]),
        "ordinary_client_ack":percentiles([r["source_to_client_ack_ms"] for r in primary]),
        "receive_to_durable":percentiles([r["durable_ms"]-r["receive_ms"] for r in primary]),
        "injected_25ms_receive":percentiles([r["receive_ms"] for r in rows if r["injected_25ms_delay"]]),
        "fragmented_2ms_receive":percentiles([r["receive_ms"] for r in rows if r["fragmented_2ms"]]),
        "alignment":alignment, "native_alignment_matches_reference_events":len(native_positions),
        "limitations":["Not MATLAB/Psychtoolbox timing", "No microphone or photodiode",
            "No physical BLE/ADC timing", "Synthetic CSV writer is not production BLE notification ingest"],"events":rows}
    (output/"latency_report.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k!="events"},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--binary",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True);parser.add_argument("--port",type=int,default=45322)
    args=parser.parse_args();run(args.binary,args.output,args.port)
