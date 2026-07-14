use std::f64::consts::PI;

use crate::{ConvolveCoreError, StereoAudio};

const OVERSAMPLE: usize = 4;
const TAPS: usize = 32;
const CENTER_TAP: isize = (TAPS / 2 - 1) as isize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NormalizationResult {
    pub applied_gain_db: f32,
    pub estimated_true_peak_dbtp: f32,
}

pub fn estimate_true_peak(audio: &StereoAudio) -> Result<f32, ConvolveCoreError> {
    let kernels = phase_kernels()?;
    let left = estimate_channel(&audio.left, &kernels);
    let right = estimate_channel(&audio.right, &kernels);
    let peak = left.max(right);
    if !peak.is_finite() || peak > f64::from(f32::MAX) {
        return Err(ConvolveCoreError::processing(
            "true-peak estimation produced a non-finite value",
        ));
    }
    Ok(peak as f32)
}

pub fn normalize_true_peak(
    audio: &mut StereoAudio,
    target_dbtp: f32,
) -> Result<NormalizationResult, ConvolveCoreError> {
    if !target_dbtp.is_finite() || !(-24.0..=0.0).contains(&target_dbtp) {
        return Err(ConvolveCoreError::invalid(
            "target dBTP must be finite and between -24 and 0",
        ));
    }

    let peak = estimate_true_peak(audio)?;
    if peak <= f32::EPSILON {
        return Ok(NormalizationResult {
            applied_gain_db: 0.0,
            estimated_true_peak_dbtp: f32::NEG_INFINITY,
        });
    }

    let target_linear = 10.0_f32.powf(target_dbtp / 20.0);
    let gain = if peak > target_linear {
        target_linear / peak
    } else {
        1.0
    };
    if !gain.is_finite() {
        return Err(ConvolveCoreError::processing(
            "normalization gain was non-finite",
        ));
    }

    for sample in audio.left.iter_mut().chain(&mut audio.right) {
        *sample *= gain;
    }

    let post_peak = estimate_true_peak(audio)?;

    Ok(NormalizationResult {
        applied_gain_db: 20.0 * gain.log10(),
        estimated_true_peak_dbtp: 20.0 * post_peak.log10(),
    })
}

fn phase_kernels() -> Result<[[f64; TAPS]; OVERSAMPLE], ConvolveCoreError> {
    let mut kernels = [[0.0_f64; TAPS]; OVERSAMPLE];
    for (phase, kernel) in kernels.iter_mut().enumerate() {
        let fractional = phase as f64 / OVERSAMPLE as f64;
        let mut sum = 0.0_f64;
        for (tap, coefficient) in kernel.iter_mut().enumerate() {
            let sample_offset = tap as isize - CENTER_TAP;
            let distance = fractional - sample_offset as f64;
            let sinc = if distance.abs() <= f64::EPSILON {
                1.0
            } else {
                (PI * distance).sin() / (PI * distance)
            };
            let tap_phase = 2.0 * PI * tap as f64 / (TAPS - 1) as f64;
            let blackman = 0.42 - 0.5 * tap_phase.cos() + 0.08 * (2.0 * tap_phase).cos();
            *coefficient = sinc * blackman;
            sum += *coefficient;
        }
        if sum.abs() <= f64::EPSILON || !sum.is_finite() {
            return Err(ConvolveCoreError::processing(
                "could not normalize the true-peak interpolation kernel",
            ));
        }
        for coefficient in kernel {
            *coefficient /= sum;
        }
    }
    Ok(kernels)
}

fn estimate_channel(samples: &[f32], kernels: &[[f64; TAPS]; OVERSAMPLE]) -> f64 {
    let mut peak = samples
        .iter()
        .copied()
        .map(f32::abs)
        .map(f64::from)
        .fold(0.0_f64, f64::max);

    for base in 0..samples.len() {
        for kernel in &kernels[1..] {
            let mut interpolated = 0.0_f64;
            for (tap, coefficient) in kernel.iter().enumerate() {
                let sample_index = base as isize + tap as isize - CENTER_TAP;
                if let Ok(sample_index) = usize::try_from(sample_index)
                    && let Some(sample) = samples.get(sample_index)
                {
                    interpolated += f64::from(*sample) * coefficient;
                }
            }
            peak = peak.max(interpolated.abs());
        }
    }
    peak
}
