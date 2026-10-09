//! Audio-frame timeline. No wall-clock timers, allocation, I/O or locks in render().
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeKind { Cue, On, Off, BlockEnd, Complete, Aborted }

impl EdgeKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cue => "刺激提示", Self::On => "声音刺激开始", Self::Off => "声音刺激结束",
            Self::BlockEnd => "刺激组结束", Self::Complete => "刺激实验完成", Self::Aborted => "刺激实验中止",
        }
    }
    pub fn key(self) -> &'static str {
        match self { Self::Cue => "cue", Self::On => "sound_on", Self::Off => "sound_off", Self::BlockEnd => "block_end", Self::Complete => "complete", Self::Aborted => "aborted" }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Edge {
    pub kind: EdgeKind,
    pub block: u32,
    pub trial: u32,
    pub output_frame: u64,
    pub interrupted: bool,
}

pub struct Timeline {
    pub block: u32,
    blocks: u32,
    trials: u32,
    cue_frames: u64,
    wave_frames: u64,
    rest_frames: u64,
    frame_in_block: u64,
    total_frames: u64,
    waiting: bool,
    finished: bool,
    sounding: bool,
    pause_blocks: bool,
}

impl Timeline {
    pub fn new(blocks: u32, trials: u32, cue: u64, wave: u64, rest: u64, pause_blocks: bool) -> Self {
        assert!(blocks > 0 && trials > 0 && wave > 0 && rest > 0);
        Self { block: 1, blocks, trials, cue_frames: cue, wave_frames: wave, rest_frames: rest,
            frame_in_block: 0, total_frames: 0, waiting: false, finished: false, sounding: false, pause_blocks }
    }

    /// Returns the source audio frame or silence, and emits edges BEFORE that sample.
    pub fn next(&mut self, cancel: &AtomicBool, resume: &AtomicBool, mut emit: impl FnMut(Edge)) -> Option<usize> {
        let period = self.cue_frames + self.wave_frames + self.rest_frames;
        let trial = (self.frame_in_block / period).min(self.trials as u64 - 1) as u32 + 1;
        let block = self.block;
        let output_frame = self.total_frames;
        let edge = |kind, interrupted| Edge { kind, block, trial, output_frame, interrupted };
        if self.finished { self.total_frames += 1; return None; }
        if cancel.load(Ordering::Relaxed) {
            if self.sounding { emit(edge(EdgeKind::Off, true)); }
            emit(edge(EdgeKind::Aborted, true));
            self.sounding = false;
            self.finished = true;
            self.total_frames += 1;
            return None;
        }
        if self.waiting {
            if !resume.swap(false, Ordering::Relaxed) { self.total_frames += 1; return None; }
            self.waiting = false;
            self.block += 1;
            self.frame_in_block = 0;
        }
        if self.frame_in_block == period * self.trials as u64 {
            emit(edge(EdgeKind::BlockEnd, false));
            if self.block == self.blocks {
                emit(edge(EdgeKind::Complete, false));
                self.finished = true;
            } else if self.pause_blocks {
                self.waiting = true;
            } else {
                self.block += 1;
                self.frame_in_block = 0;
            }
            // One silent frame separates blocks. No extra frame inside a trial.
            self.total_frames += 1;
            return None;
        }
        let trial = (self.frame_in_block / period) as u32 + 1;
        let position = self.frame_in_block % period;
        let edge = |kind| Edge { kind, block: self.block, trial, output_frame: self.total_frames, interrupted: false };
        if position == 0 { emit(edge(EdgeKind::Cue)); }
        if position == self.cue_frames { self.sounding = true; emit(edge(EdgeKind::On)); }
        if position == self.cue_frames + self.wave_frames { self.sounding = false; emit(edge(EdgeKind::Off)); }
        let sample = (position >= self.cue_frames && position < self.cue_frames + self.wave_frames)
            .then(|| (position - self.cue_frames) as usize);
        self.frame_in_block += 1;
        self.total_frames += 1;
        sample
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn onset_offset_follow_audio_samples_not_callback_size() {
        for sample_rate in [44100, 48000, 96000] {
            let cancel = AtomicBool::new(false); let resume = AtomicBool::new(false);
            let wave = sample_rate / 10;
            let mut t = Timeline::new(1, 3, sample_rate, wave, sample_rate / 2, true);
            let mut edges = Vec::new(); let mut non_silent = 0;
            for _ in 0..((sample_rate + wave + sample_rate / 2) * 3 + 1) {
                if t.next(&cancel, &resume, |e| edges.push(e)).is_some() { non_silent += 1; }
            }
            assert_eq!(non_silent, wave * 3);
            let on: Vec<_> = edges.iter().filter(|e| e.kind == EdgeKind::On).collect();
            let off: Vec<_> = edges.iter().filter(|e| e.kind == EdgeKind::Off).collect();
            assert_eq!(on.len(), 3); assert_eq!(off.len(), 3);
            for (a, b) in on.iter().zip(off.iter()) { assert_eq!(b.output_frame - a.output_frame, wave); }
            assert_eq!(edges.last().unwrap().kind, EdgeKind::Complete);
        }
    }
    #[test]
    fn stop_mid_sound_emits_exactly_one_interrupted_offset() {
        let cancel = AtomicBool::new(false); let resume = AtomicBool::new(false);
        let mut t = Timeline::new(1, 1, 10, 100, 10, true); let mut edges = Vec::new();
        for _ in 0..25 { t.next(&cancel, &resume, |e| edges.push(e)); }
        cancel.store(true, Ordering::Relaxed);
        for _ in 0..20 { t.next(&cancel, &resume, |e| edges.push(e)); }
        let off: Vec<_> = edges.iter().filter(|e| e.kind == EdgeKind::Off).collect();
        assert_eq!(off.len(), 1); assert_eq!(off[0].output_frame, 25); assert!(off[0].interrupted);
        assert_eq!(edges.last().unwrap().kind, EdgeKind::Aborted);
    }
    #[test]
    fn waiting_blocks_are_silent_until_explicit_continue() {
        let cancel = AtomicBool::new(false); let resume = AtomicBool::new(false);
        let mut t = Timeline::new(2, 1, 2, 4, 2, true); let mut edges = Vec::new();
        for _ in 0..100 { t.next(&cancel, &resume, |e| edges.push(e)); }
        assert_eq!(edges.iter().filter(|e| e.kind == EdgeKind::On).count(), 1);
        resume.store(true, Ordering::Relaxed);
        for _ in 0..10 { t.next(&cancel, &resume, |e| edges.push(e)); }
        assert_eq!(edges.iter().filter(|e| e.kind == EdgeKind::On).count(), 2);
        assert_eq!(edges.last().unwrap().kind, EdgeKind::Complete);
    }
}
