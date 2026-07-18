use std::f64::consts::PI;

use crate::{
    ConvolveCoreError, StereoAudio,
    views::{ForwardView, GainView, StereoSampleView},
};

const OVERSAMPLE: usize = 4;
const TAPS: usize = 32;
const CENTER_TAP: isize = (TAPS / 2 - 1) as isize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NormalizationResult {
    pub applied_gain_db: f32,
    pub estimated_true_peak_dbtp: f32,
}

pub fn estimate_true_peak(audio: &StereoAudio) -> Result<f32, ConvolveCoreError> {
    estimate_true_peak_view(&ForwardView::new(audio))
}

pub(crate) fn estimate_true_peak_view<V: StereoSampleView>(
    view: &V,
) -> Result<f32, ConvolveCoreError> {
    let kernels = phase_kernels()?;
    let left = estimate_channel_view(view.frames(), |index| view.left(index), &kernels);
    let right = estimate_channel_view(view.frames(), |index| view.right(index), &kernels);
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
    let forward = ForwardView::new(audio);
    let (result, gain) = normalization_for_view(&forward, target_dbtp)?;
    for sample in audio.left.iter_mut().chain(&mut audio.right) {
        *sample *= gain;
    }
    Ok(result)
}

pub(crate) fn normalization_for_view<V: StereoSampleView>(
    view: &V,
    target_dbtp: f32,
) -> Result<(NormalizationResult, f32), ConvolveCoreError> {
    if !target_dbtp.is_finite() || !(-24.0..=0.0).contains(&target_dbtp) {
        return Err(ConvolveCoreError::invalid(
            "target dBTP must be finite and between -24 and 0",
        ));
    }

    let peak = estimate_true_peak_view(view)?;
    if peak <= f32::EPSILON {
        return Ok((
            NormalizationResult {
                applied_gain_db: 0.0,
                estimated_true_peak_dbtp: f32::NEG_INFINITY,
            },
            1.0,
        ));
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

    let gained = GainView::new(view, gain);
    let post_peak = estimate_true_peak_view(&gained)?;
    Ok((
        NormalizationResult {
            applied_gain_db: 20.0 * gain.log10(),
            estimated_true_peak_dbtp: 20.0 * post_peak.log10(),
        },
        gain,
    ))
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

fn estimate_channel_view<F>(frames: usize, sample_at: F, kernels: &[[f64; TAPS]; OVERSAMPLE]) -> f64
where
    F: Fn(usize) -> f32,
{
    let mut peak = (0..frames)
        .map(&sample_at)
        .map(f32::abs)
        .map(f64::from)
        .fold(0.0_f64, f64::max);

    for base in 0..frames {
        for kernel in &kernels[1..] {
            let mut interpolated = 0.0_f64;
            for (tap, coefficient) in kernel.iter().enumerate() {
                let sample_index = base as isize + tap as isize - CENTER_TAP;
                if let Ok(sample_index) = usize::try_from(sample_index)
                    && sample_index < frames
                {
                    interpolated += f64::from(sample_at(sample_index)) * coefficient;
                }
            }
            peak = peak.max(interpolated.abs());
        }
    }
    peak
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SAMPLE_RATE,
        views::{ForwardView, GainView},
    };

    #[test]
    fn normalization_for_a_view_uses_pre_gain_and_post_gain_traversals() {
        let audio =
            StereoAudio::new(SAMPLE_RATE, vec![1.0, -0.8, 0.6], vec![0.4, -0.3, 0.2]).unwrap();
        let forward = ForwardView::new(&audio);
        let (result, gain) = normalization_for_view(&forward, -1.0).unwrap();
        let gained = GainView::new(forward, gain);
        assert_eq!(
            result.estimated_true_peak_dbtp.to_bits(),
            (20.0_f32 * estimate_true_peak_view(&gained).unwrap().log10()).to_bits()
        );
        assert!(gain < 1.0);
    }
}
