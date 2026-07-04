# UI Themes Design

## Goal

Optimize the Tauri desktop client UI into a polished clinical waveform dashboard with multiple selectable themes, while preserving all BLE, protocol, EEG mode, and settings behavior.

## Approved Direction

Use方案A: clinical dashboard plus multi-theme token system.

## Theme Set

- `neuro-dark`: default dark monitoring theme for long EEG sessions.
- `clinical-light`: bright daytime theme with clean medical surfaces.
- `graphite`: neutral low-glare dark gray theme.
- `amber-lab`: warm lab theme with amber highlights.

All themes use semantic CSS variables for background, surfaces, borders, text, muted text, accent, success, warning, danger, chart background, chart grid, and focus ring. Components must not hardcode app surface colors except data series colors.

## UX Requirements

- Keep the first screen as the working dashboard, not a landing page.
- Keep EEG mode layout: raw selected EEG top-left, band share top-right, four band waveforms bottom-left, raw plus bands bottom-right.
- Add a theme selector in the top bar and persist it in existing settings.
- Make controls at least 40px tall on desktop and visually stable.
- Use lucide icons already present in the project.
- Preserve visible labels for settings fields.
- Respect `prefers-reduced-motion`.
- Avoid decorative orbs, oversized marketing composition, and single-hue palette dominance.

## Visual Direction

The dashboard should feel quiet, professional, and elegant: layered surfaces, crisp borders, restrained shadows, clear chart panels, readable labels, and subdued motion. The waveform canvas should read as an instrument surface, with theme-aware grid, empty state, legend, and line colors.

## Non-Goals

- Do not change BLE protocol parsing or Rust backend behavior.
- Do not add new chart libraries.
- Do not redesign the whole app navigation model.
- Do not commit, branch, push, or reset git state.
