use realfft::{RealFftPlanner, num_complex::Complex, num_traits::Zero};

use crate::{ConvolveCoreError, SAMPLE_RATE, StereoAudio, convolution_frames, estimate_peak_bytes};

pub fn convolve_stereo(a: &StereoAudio, b: &StereoAudio) -> Result<StereoAudio, ConvolveCoreError> {
    estimate_peak_bytes(a.frames(), b.frames(), false, 0)?;

    let left = convolve_channel(&a.left, &b.left)?;
    let right = convolve_channel(&a.right, &b.right)?;
    StereoAudio::new(SAMPLE_RATE, left, right)
}

fn convolve_channel(a: &[f32], b: &[f32]) -> Result<Vec<f32>, ConvolveCoreError> {
    let output_len = convolution_frames(a.len(), b.len())?;
    let fft_len =
        output_len
            .checked_next_power_of_two()
            .ok_or(ConvolveCoreError::InputTooLarge {
                estimated: usize::MAX,
                limit: crate::MAX_BYTES,
            })?;

    let mut planner = RealFftPlanner::<f32>::new();
    let forward = planner.plan_fft_forward(fft_len);
    let inverse = planner.plan_fft_inverse(fft_len);

    let mut time_a = forward.make_input_vec();
    let mut time_b = forward.make_input_vec();
    time_a[..a.len()].copy_from_slice(a);
    time_b[..b.len()].copy_from_slice(b);

    let mut spectrum_a = forward.make_output_vec();
    let mut spectrum_b = forward.make_output_vec();
    let mut fft_scratch =
        vec![Complex::<f32>::zero(); forward.get_scratch_len().max(inverse.get_scratch_len())];
    forward
        .process_with_scratch(&mut time_a, &mut spectrum_a, &mut fft_scratch)
        .map_err(ConvolveCoreError::fft)?;
    forward
        .process_with_scratch(&mut time_b, &mut spectrum_b, &mut fft_scratch)
        .map_err(ConvolveCoreError::fft)?;

    for (left, right) in spectrum_a.iter_mut().zip(spectrum_b) {
        *left *= right;
    }

    let mut inverse_output = inverse.make_output_vec();
    inverse
        .process_with_scratch(&mut spectrum_a, &mut inverse_output, &mut fft_scratch)
        .map_err(ConvolveCoreError::fft)?;

    let mut output = inverse_output[..output_len].to_vec();
    let scale = 1.0 / fft_len as f32;
    for sample in &mut output {
        *sample *= scale;
    }
    if !output.iter().all(|sample| sample.is_finite()) {
        return Err(ConvolveCoreError::processing(
            "convolution produced a non-finite sample",
        ));
    }
    Ok(output)
}
