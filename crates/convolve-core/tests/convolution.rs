use convolve_core::{SAMPLE_RATE, StereoAudio, convolve_stereo};

fn stereo(left: &[f32], right: &[f32]) -> StereoAudio {
    StereoAudio::new(SAMPLE_RATE, left.to_vec(), right.to_vec()).unwrap()
}

fn assert_approx_eq(actual: &[f32], expected: &[f32], tolerance: f32) {
    assert_eq!(actual.len(), expected.len());
    for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
        assert!(
            (actual - expected).abs() <= tolerance,
            "sample {index}: expected {expected}, got {actual}"
        );
    }
}

#[test]
fn mono_impulse_is_identity() {
    let input = stereo(&[0.25, -0.5, 0.75], &[0.1, 0.2, 0.3]);
    let impulse = stereo(&[1.0], &[1.0]);
    let output = convolve_stereo(&input, &impulse).unwrap();
    assert_approx_eq(&output.left, &input.left, 1e-5);
    assert_approx_eq(&output.right, &input.right, 1e-5);
}

#[test]
fn computes_full_known_convolution() {
    let a = stereo(&[1.0, 2.0], &[3.0, 4.0]);
    let b = stereo(&[5.0, 6.0], &[7.0, 8.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_approx_eq(&output.left, &[5.0, 16.0, 12.0], 1e-4);
    assert_approx_eq(&output.right, &[21.0, 52.0, 32.0], 1e-4);
}

#[test]
fn output_length_is_exact_full_convolution_length() {
    let a = stereo(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]);
    let b = stereo(&[1.0, 2.0, 3.0, 4.0], &[1.0, 2.0, 3.0, 4.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_eq!(output.frames(), 6);
}

#[test]
fn channels_do_not_leak_into_each_other() {
    let a = stereo(&[1.0, 0.0], &[0.0, 0.0]);
    let b = stereo(&[1.0, 0.5], &[0.0, 0.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_approx_eq(&output.left, &[1.0, 0.5, 0.0], 1e-5);
    assert_approx_eq(&output.right, &[0.0, 0.0, 0.0], 1e-5);
}

#[test]
fn inverse_fft_is_scaled_by_transform_length() {
    let a = stereo(&[1.0, 1.0], &[1.0, 1.0]);
    let b = stereo(&[1.0, 1.0], &[1.0, 1.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_approx_eq(&output.left, &[1.0, 2.0, 1.0], 1e-5);
    assert_approx_eq(&output.right, &[1.0, 2.0, 1.0], 1e-5);
}

#[test]
fn channel_buffers_release_the_fft_tail_capacity() {
    let a = stereo(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]);
    let b = stereo(&[1.0, 2.0, 3.0, 4.0], &[4.0, 3.0, 2.0, 1.0]);
    let output = convolve_stereo(&a, &b).unwrap();
    assert_eq!(output.left.capacity(), output.frames());
    assert_eq!(output.right.capacity(), output.frames());
}
