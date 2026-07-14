use std::f32::consts::PI;

use realfft::RealFftPlanner;

use crate::{ConvolveCoreError, SAMPLE_RATE, StereoAudio};

const FRAME: usize = 2_048;
const HOP: usize = 512;
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 200.0;
const MIN_CONFIDENCE: f32 = 0.15;
const MEDIAN_RADIUS: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BeatGrid {
    pub anchor_sample: usize,
    pub period_samples: usize,
    pub bpm: f32,
    pub confidence: f32,
}

impl BeatGrid {
    #[must_use]
    pub fn samples_until(&self, output_frames: usize) -> Vec<usize> {
        if self.period_samples == 0 || self.anchor_sample >= output_frames {
            return Vec::new();
        }

        let mut samples = Vec::with_capacity(
            output_frames
                .saturating_sub(self.anchor_sample)
                .div_ceil(self.period_samples),
        );
        let mut cursor = self.anchor_sample;
        while cursor < output_frames {
            samples.push(cursor);
            let Some(next) = cursor.checked_add(self.period_samples) else {
                break;
            };
            cursor = next;
        }
        samples
    }
}

pub fn detect_beat_grid(source: &StereoAudio) -> Result<BeatGrid, ConvolveCoreError> {
    let mono: Vec<f32> = source
        .left
        .iter()
        .zip(&source.right)
        .map(|(left, right)| 0.5 * (left + right))
        .collect();
    let onset = onset_envelope(&mono)?;
    select_grid(&onset)
}

fn onset_envelope(mono: &[f32]) -> Result<Vec<f32>, ConvolveCoreError> {
    if mono.len() < FRAME {
        return Err(beat_error("audio is too short for beat analysis"));
    }

    let frame_count = 1 + (mono.len() - FRAME) / HOP;
    let window: Vec<f32> = (0..FRAME)
        .map(|index| {
            let phase = index as f32 / (FRAME - 1) as f32;
            0.5 - 0.5 * (2.0 * PI * phase).cos()
        })
        .collect();

    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(FRAME);
    let mut input = forward.make_input_vec();
    let mut spectrum = forward.make_output_vec();
    let mut previous_magnitudes = vec![0.0_f32; spectrum.len()];
    let mut flux = Vec::with_capacity(frame_count);

    for frame_index in 0..frame_count {
        let start = frame_index * HOP;
        for ((destination, sample), window_sample) in input
            .iter_mut()
            .zip(&mono[start..start + FRAME])
            .zip(&window)
        {
            *destination = sample * window_sample;
        }

        forward
            .process(&mut input, &mut spectrum)
            .map_err(ConvolveCoreError::fft)?;

        let mut value = 0.0_f32;
        for (bin, previous) in spectrum.iter().zip(&mut previous_magnitudes) {
            let magnitude = bin.norm();
            value += (magnitude - *previous).max(0.0);
            *previous = magnitude;
        }
        flux.push(value);
    }

    let mut onset = Vec::with_capacity(flux.len());
    for index in 0..flux.len() {
        let start = index.saturating_sub(MEDIAN_RADIUS);
        let end = (index + MEDIAN_RADIUS + 1).min(flux.len());
        let mut neighborhood = flux[start..end].to_vec();
        neighborhood.sort_by(f32::total_cmp);
        let median = if neighborhood.len() % 2 == 0 {
            let upper = neighborhood.len() / 2;
            0.5 * (neighborhood[upper - 1] + neighborhood[upper])
        } else {
            neighborhood[neighborhood.len() / 2]
        };
        onset.push((flux[index] - median).max(0.0));
    }

    let maximum = onset.iter().copied().fold(0.0_f32, f32::max);
    if maximum <= f32::EPSILON || !maximum.is_finite() {
        return Err(beat_error("audio has no stable onset energy"));
    }
    for value in &mut onset {
        *value /= maximum;
    }
    Ok(onset)
}

fn select_grid(onset: &[f32]) -> Result<BeatGrid, ConvolveCoreError> {
    let frames_per_minute = 60.0 * SAMPLE_RATE as f32 / HOP as f32;
    let minimum_lag = (frames_per_minute / MAX_BPM).ceil() as usize;
    let maximum_lag = (frames_per_minute / MIN_BPM).floor() as usize;
    if onset.len() <= maximum_lag {
        return Err(beat_error("audio is too short for tempo estimation"));
    }

    let zero_lag = onset.iter().map(|value| value * value).sum::<f32>();
    if zero_lag <= f32::EPSILON {
        return Err(beat_error("audio has no onset autocorrelation"));
    }

    let mut best_lag = 0_usize;
    let mut best_correlation = f32::NEG_INFINITY;
    for lag in minimum_lag..=maximum_lag {
        let correlation = onset[lag..]
            .iter()
            .zip(&onset[..onset.len() - lag])
            .map(|(current, previous)| current * previous)
            .sum::<f32>();
        if correlation > best_correlation {
            best_correlation = correlation;
            best_lag = lag;
        }
    }

    let confidence = best_correlation / zero_lag;
    if best_lag == 0 || !confidence.is_finite() || confidence < MIN_CONFIDENCE {
        return Err(beat_error(format!(
            "tempo confidence {confidence:.3} is below {MIN_CONFIDENCE:.2}"
        )));
    }

    let mut best_phase = 0_usize;
    let mut best_phase_score = f32::NEG_INFINITY;
    for phase in 0..best_lag {
        let score = (phase..onset.len())
            .step_by(best_lag)
            .map(|index| onset[index])
            .sum::<f32>();
        if score > best_phase_score {
            best_phase_score = score;
            best_phase = phase;
        }
    }

    let stft_lookahead_frames = FRAME.div_ceil(HOP);
    let phase_is_at_zero = best_phase <= stft_lookahead_frames
        || best_lag.saturating_sub(best_phase) <= stft_lookahead_frames;
    let anchor_sample = if phase_is_at_zero {
        0
    } else {
        best_phase * HOP
    };
    let period_samples = best_lag
        .checked_mul(HOP)
        .ok_or_else(|| beat_error("detected beat period overflowed"))?;
    let bpm = 60.0 * SAMPLE_RATE as f32 / period_samples as f32;

    Ok(BeatGrid {
        anchor_sample,
        period_samples,
        bpm,
        confidence,
    })
}

fn beat_error(message: impl Into<String>) -> ConvolveCoreError {
    ConvolveCoreError::BeatDetectionFailed {
        message: message.into(),
    }
}
