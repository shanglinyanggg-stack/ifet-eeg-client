"""Hardware-free regression tests for old recording repair."""
import csv
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from align_matlab_stimulus import align, epoch


class MarkerAlignmentTests(unittest.TestCase):
    def test_utc_event_aligns_to_local_eeg_and_repairs_a_copy(self):
        for rate in (125, 250, 500, 1000):
            with self.subTest(rate=rate), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                eeg, events, markers = root / "eeg.csv", root / "events.jsonl", root / "markers.csv"
                origin = datetime(2026, 10, 13, 10, 0, tzinfo=timezone(timedelta(hours=8)))
                instant = origin.timestamp() + 10.4 / rate
                with eeg.open("w", newline="") as target:
                    writer = csv.writer(target); writer.writerow(["time", "sampleRateHz", "valid"])
                    for index in range(30):
                        writer.writerow([(origin + timedelta(seconds=index/rate)).isoformat(), rate, "true"])
                source = {"event_id": "event-1", "stimulus_id": "s", "modality": "audio", "edge": "start", "metadata": {}}
                event = {"record_type": "event", "event": source, "event_time_unix_s": instant,
                         "event_time_utc": datetime.fromtimestamp(instant, timezone.utc).isoformat(), "receive_delay_ms": 250}
                events.write_text(json.dumps(event) + "\n", encoding="utf-8")
                with markers.open("w", newline="") as target:
                    writer = csv.writer(target)
                    writer.writerow(["time", "participantId", "note", "sampleCount"])
                    writer.writerow([event["event_time_utc"], "MATLAB", json.dumps(source), "42"])
                    writer.writerow([origin.isoformat(), "subject", "保留,逗号\n换行", "17"])
                original = markers.read_bytes()
                summary = align(eeg, events, root / "aligned.csv", markers)
                with Path(summary["corrected_markers"]).open(encoding="utf-8-sig", newline="") as source_file:
                    rows = list(csv.DictReader(source_file))
                self.assertEqual(rows[0]["sampleCount"], "11")
                self.assertTrue(rows[0]["time"].endswith("+08:00"))
                self.assertAlmostEqual(epoch(rows[0]["time"]), instant, places=6)
                self.assertEqual(rows[0]["matlabAlignmentStatus"], "within_sample_interval")
                self.assertEqual(rows[1]["note"], "保留,逗号\n换行")
                self.assertEqual(markers.read_bytes(), original)

    def test_rejects_ambiguous_timezone(self):
        with self.assertRaisesRegex(ValueError, "缺少时区"):
            epoch("2026-10-13T10:00:00")

    def test_rejects_backward_eeg_clock_without_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            eeg, events, output = root / "eeg.csv", root / "events.jsonl", root / "aligned.csv"
            eeg.write_text("time,sampleRateHz,valid\n2026-10-13T10:00:01+08:00,125,true\n2026-10-13T10:00:00+08:00,125,true\n")
            events.write_text("")
            with self.assertRaisesRegex(ValueError, "倒退"):
                align(eeg, events, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
