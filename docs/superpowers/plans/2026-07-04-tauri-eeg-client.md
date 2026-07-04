# Tauri EEG Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Tauri v2 desktop client that scans and connects BLE devices, parses the app protocol including EEG1-4, and displays real-time waveform views with persistent settings.

**Architecture:** Use a Rust backend for BLE access, packet parsing, and signal-processing primitives that require deterministic tests. Use a React/Vite frontend for state, settings, and waveform rendering. Keep BLE transport, protocol decoding, DSP, settings, and UI components separated so later protocol corrections can be isolated.

**Tech Stack:** Tauri v2, Rust 2021, btleplug, React 19, TypeScript, Vite, Vitest, Canvas 2D.

## Global Constraints

- Always answer and document user-facing text in Simplified Chinese.
- Do not create git branches, commits, pushes, or resets unless explicitly requested.
- Keep implementation scoped to the requested desktop client; avoid unrelated refactors.
- Treat APK evidence as authoritative for EEG support: `eeg1`, `eeg2`, `eeg3`, `eeg4`, `flag`, `eeg_bp_enabled`, `eeg_bp_low`, `eeg_bp_high`, `eeg_notch`, `eeg_scale`, `eeg_speed`.
- Protocol parser must preserve original PPG/ACC behavior and add EEG1-4 when present.
- EEG defaults: selected channel `eeg1`, scale `auto`, time window `auto`, bandpass disabled by default, notch disabled by default.

---

## File Structure

- `package.json`: npm scripts and frontend dependencies.
- `index.html`: Vite entry point.
- `vite.config.ts`: React/Vitest config.
- `tsconfig.json`, `tsconfig.node.json`: TypeScript config.
- `src/main.tsx`: React app bootstrap.
- `src/App.tsx`: main layout, app state, Tauri command integration.
- `src/styles.css`: dashboard styling and responsive layout.
- `src/domain/protocol.ts`: TypeScript protocol helpers for UI/tests.
- `src/domain/dsp.ts`: TypeScript EEG band splitting and chart scaling.
- `src/domain/settings.ts`: persistent settings schema and defaults.
- `src/components/WaveformCanvas.tsx`: reusable canvas waveform renderer.
- `src/components/SettingsPanel.tsx`: settings panel.
- `src/components/BandShareChart.tsx`: circular EEG band share chart.
- `src/components/DevicePanel.tsx`: scan/connect/record controls.
- `src/components/EegModeView.tsx`: brainwave-specific layout.
- `src-tauri/Cargo.toml`: Rust dependencies.
- `src-tauri/build.rs`: Tauri build hook.
- `src-tauri/tauri.conf.json`: Tauri v2 app config.
- `src-tauri/capabilities/default.json`: main window capability.
- `src-tauri/src/main.rs`: binary entry point.
- `src-tauri/src/lib.rs`: command registration and app state.
- `src-tauri/src/protocol.rs`: packet parser with unit tests.
- `src-tauri/src/dsp.rs`: Biquad, bandpass, notch, band-power helpers with unit tests.
- `src-tauri/src/ble.rs`: btleplug scanner/connection manager.
- `src-tauri/src/models.rs`: serializable DTOs shared by commands/events.

## Task 1: Project Skeleton

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `npm run dev`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml`

- [ ] Create minimal Vite + React + Tauri v2 structure.
- [ ] Register placeholder commands: `scan_devices`, `connect_device`, `disconnect_device`, `send_command`, `start_recording`, `stop_recording`.
- [ ] Verify frontend install/build can resolve files after dependencies are installed.

## Task 2: Protocol Parser TDD

**Files:**
- Create: `src-tauri/src/protocol.rs`
- Create: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `parse_packet(raw: &[u8]) -> Option<DecodedPacket>`
- Produces DTOs: `PpgSample`, `EegSample`, `DecodedPacket`

- [ ] Write Rust tests for legacy 27-byte packet: header, size, seq, 6 PPG values, 3 ACC values.
- [ ] Write Rust tests for 45-byte packet: same legacy fields plus `eeg1-4`; parse `flag` only when an additional byte is present.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml protocol -- --nocapture` and verify tests fail because parser is missing.
- [ ] Implement parser with bounded length checks and signed 16-bit ACC decoding.
- [ ] Run parser tests and verify they pass.

## Task 3: DSP TDD

**Files:**
- Create: `src-tauri/src/dsp.rs`
- Create: `src/domain/dsp.ts`

**Interfaces:**
- Produces Rust: `BiquadFilter`, `BandPowerAnalyzer`, `EegBand`
- Produces TypeScript: `createEegBands`, `computeShare`, `resolveScale`

- [ ] Write Rust tests proving constant input is attenuated by bandpass after warmup.
- [ ] Write Rust tests proving band share normalizes to 1.0 for non-zero powers.
- [ ] Write Vitest tests for TypeScript scale resolution and percentage share.
- [ ] Run Rust and Vitest tests and verify they fail.
- [ ] Implement minimal DSP utilities.
- [ ] Run Rust and Vitest tests and verify they pass.

## Task 4: BLE Backend

**Files:**
- Create: `src-tauri/src/ble.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/models.rs`

**Interfaces:**
- Consumes: `parse_packet(raw: &[u8])`
- Produces Tauri commands: `scan_devices`, `connect_device`, `disconnect_device`, `send_command`, `start_recording`, `stop_recording`
- Emits events: `ble://sample`, `ble://status`

- [ ] Implement a `BleManagerState` guarded by `tokio::sync::Mutex`.
- [ ] Implement scan with a short timeout and map discovered devices to `{ id, name, rssi }`.
- [ ] Implement connect/discover/subscribe to service `0000fff0-0000-1000-8000-00805f9b34fb`, write characteristic `0000fff5-0000-1000-8000-00805f9b34fb`, notify characteristic `0000fff9-0000-1000-8000-00805f9b34fb`.
- [ ] On notification, parse packets and emit decoded samples to the frontend.
- [ ] Implement CSV recording with APK-compatible header.
- [ ] Return Chinese error messages at command boundary.

## Task 5: Frontend Domain and Settings

**Files:**
- Create: `src/domain/protocol.ts`
- Create: `src/domain/settings.ts`
- Create: `src/domain/dsp.ts`

**Interfaces:**
- Produces: `defaultSettings`, `loadSettings`, `saveSettings`, `appendSample`
- Produces settings keys aligned with APK evidence.

- [ ] Write Vitest tests for settings defaults and localStorage round-trip.
- [ ] Write Vitest tests for sample buffer trimming.
- [ ] Run tests and verify failure.
- [ ] Implement settings schema and sample buffer helpers.
- [ ] Run tests and verify pass.

## Task 6: UI Implementation

**Files:**
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles.css`
- Create: `src/components/WaveformCanvas.tsx`
- Create: `src/components/SettingsPanel.tsx`
- Create: `src/components/BandShareChart.tsx`
- Create: `src/components/DevicePanel.tsx`
- Create: `src/components/EegModeView.tsx`

**Interfaces:**
- Consumes: Tauri command names and events from Task 4.
- Produces: main UI with normal mode and EEG mode.

- [ ] Implement device/recording toolbar with scan/connect/disconnect/send command.
- [ ] Implement normal mode waveform list for PPG/ACC/EEG channels.
- [ ] Implement EEG mode layout: selected EEG waveform top-left, four band waveforms bottom-left, circular share chart top-right, combined raw+4 bands bottom-right.
- [ ] Implement settings panel with original App settings plus display mode, selected EEG channel, EEG bandpass low/high, notch, per-wave scale, and x-axis time window.
- [ ] Persist settings automatically on change.
- [ ] Use canvas rendering with stable dimensions and no layout-shifting controls.

## Task 7: Verification

**Files:**
- All project files.

**Interfaces:**
- Verifies: Rust tests, TypeScript tests, frontend build, Tauri compile check.

- [ ] Run `npm install`.
- [ ] Run `npm test -- --run`.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] Run `npm run build`.
- [ ] Run `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] Start `npm run tauri dev` or `npm run dev` depending on local Tauri compile status.

## Plan Self-Review

- Spec coverage: BLE scan/connect, protocol parse, EEG1-4, persistent settings, display modes, EEG split view, filter parameters, scale/time auto defaults, recording and original settings are covered.
- Placeholder scan: no placeholder task content remains.
- Type consistency: command/event names are consistent across backend and frontend tasks.
