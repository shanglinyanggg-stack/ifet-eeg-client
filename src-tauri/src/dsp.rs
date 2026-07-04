#![allow(dead_code)]

use std::f64::consts::PI;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EegBand {
    Delta,
    Theta,
    Alpha,
    Beta,
}

impl EegBand {
    pub fn default_range(self) -> (f64, f64) {
        match self {
            EegBand::Delta => (0.5, 4.0),
            EegBand::Theta => (4.0, 8.0),
            EegBand::Alpha => (8.0, 13.0),
            EegBand::Beta => (13.0, 30.0),
        }
    }
}

#[derive(Debug, Clone)]
pub struct BiquadFilter {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BiquadFilter {
    pub fn bandpass(low_cut: f64, high_cut: f64, sample_rate: f64) -> Self {
        let center = (low_cut * high_cut).sqrt();
        let bandwidth = (high_cut - low_cut).max(1e-6);
        let q = (center / bandwidth).max(0.01);
        let omega = 2.0 * PI * center / sample_rate;
        let sin_omega = omega.sin();
        let cos_omega = omega.cos();
        let alpha = sin_omega / (2.0 * q);
        let a0 = 1.0 + alpha;

        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * cos_omega / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    pub fn notch(frequency: f64, sample_rate: f64, q: f64) -> Self {
        let omega = 2.0 * PI * frequency / sample_rate;
        let sin_omega = omega.sin();
        let cos_omega = omega.cos();
        let alpha = sin_omega / (2.0 * q.max(0.01));
        let a0 = 1.0 + alpha;

        Self {
            b0: 1.0 / a0,
            b1: -2.0 * cos_omega / a0,
            b2: 1.0 / a0,
            a1: -2.0 * cos_omega / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    pub fn process(&mut self, input: f64) -> f64 {
        let output =
            self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

#[derive(Debug, Clone)]
pub struct BandPowerAnalyzer {
    sample_rate: f64,
}

impl BandPowerAnalyzer {
    pub fn new(sample_rate: f64) -> Self {
        Self { sample_rate }
    }

    pub fn filters(&self) -> Vec<(EegBand, BiquadFilter)> {
        [EegBand::Delta, EegBand::Theta, EegBand::Alpha, EegBand::Beta]
            .into_iter()
            .map(|band| {
                let (low, high) = band.default_range();
                (band, BiquadFilter::bandpass(low, high, self.sample_rate))
            })
            .collect()
    }

    pub fn normalize_shares(&self, powers: &[(EegBand, f64)]) -> Vec<(EegBand, f64)> {
        let total: f64 = powers.iter().map(|(_, power)| power.max(0.0)).sum();
        if total <= f64::EPSILON {
            return powers.iter().map(|(band, _)| (*band, 0.0)).collect();
        }
        powers
            .iter()
            .map(|(band, power)| (*band, power.max(0.0) / total))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{BandPowerAnalyzer, BiquadFilter, EegBand};

    #[test]
    fn bandpass_attenuates_constant_input_after_warmup() {
        let mut filter = BiquadFilter::bandpass(8.0, 13.0, 100.0);
        let mut output = 0.0;

        for _ in 0..600 {
            output = filter.process(1000.0);
        }

        assert!(output.abs() < 1.0, "constant leakage was {output}");
    }

    #[test]
    fn band_power_share_normalizes_non_zero_powers() {
        let analyzer = BandPowerAnalyzer::new(100.0);
        let shares = analyzer.normalize_shares(&[
            (EegBand::Delta, 1.0),
            (EegBand::Theta, 2.0),
            (EegBand::Alpha, 3.0),
            (EegBand::Beta, 4.0),
        ]);

        let total: f64 = shares.iter().map(|(_, share)| share).sum();

        assert!((total - 1.0).abs() < 1e-9);
        assert_eq!(shares[0].0, EegBand::Delta);
        assert!((shares[3].1 - 0.4).abs() < 1e-9);
    }
}
