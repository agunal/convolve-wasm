use convolve_core::{SAMPLE_RATE, StereoAudio, append_reverse};

fn stereo(left: &[f32], right: &[f32]) -> StereoAudio {
    StereoAudio::new(SAMPLE_RATE, left.to_vec(), right.to_vec()).unwrap()
}

fn assert_palindrome(samples: &[f32]) {
    for (index, (forward, reverse)) in samples.iter().zip(samples.iter().rev()).enumerate() {
        assert!(
            (forward - reverse).abs() <= 1e-7,
            "sample {index}: {forward} != {reverse}"
        );
    }
}

#[test]
fn output_length_is_two_n_minus_crossfade() {
    let audio = stereo(&[1.0, 2.0, 3.0, 4.0], &[5.0, 6.0, 7.0, 8.0]);
    let output = append_reverse(&audio, 2);
    assert_eq!(output.frames(), 6);
}

#[test]
fn overlap_add_is_palindromic_in_both_channels() {
    let audio = stereo(&[0.1, 0.2, 0.3, 0.4, 0.5], &[-0.5, -0.4, -0.3, -0.2, -0.1]);
    let output = append_reverse(&audio, 3);
    assert_palindrome(&output.left);
    assert_palindrome(&output.right);
}

#[test]
fn reverse_is_sample_time_only_without_channel_swap() {
    let audio = stereo(&[1.0, 2.0, 3.0], &[10.0, 20.0, 30.0]);
    let output = append_reverse(&audio, 0);
    assert_eq!(output.left, vec![1.0, 2.0, 3.0, 3.0, 2.0, 1.0]);
    assert_eq!(output.right, vec![10.0, 20.0, 30.0, 30.0, 20.0, 10.0]);
}

#[test]
fn short_inputs_clamp_crossfade_to_n_minus_one() {
    let audio = stereo(&[1.0, 2.0, 3.0], &[4.0, 5.0, 6.0]);
    let output = append_reverse(&audio, 240);
    assert_eq!(output.frames(), 4);
    assert_palindrome(&output.left);
    assert_palindrome(&output.right);
}

#[test]
fn single_frame_audio_remains_valid() {
    let audio = stereo(&[0.25], &[-0.5]);
    let output = append_reverse(&audio, 240);
    assert_eq!(output.left, vec![0.25, 0.25]);
    assert_eq!(output.right, vec![-0.5, -0.5]);
}
