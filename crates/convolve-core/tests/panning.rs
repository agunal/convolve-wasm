use std::f32::consts::FRAC_1_SQRT_2;

use convolve_core::{BeatGrid, SAMPLE_RATE, StereoAudio, apply_beat_pan};

fn constant_audio(frames: usize, left: f32, right: f32) -> StereoAudio {
    StereoAudio::new(SAMPLE_RATE, vec![left; frames], vec![right; frames]).unwrap()
}

fn grid(period_samples: usize) -> BeatGrid {
    BeatGrid {
        anchor_sample: 0,
        period_samples,
        bpm: 60.0 * SAMPLE_RATE as f32 / period_samples as f32,
        confidence: 1.0,
    }
}

#[test]
fn starts_hard_left_then_alternates_at_each_later_beat() {
    let mut audio = constant_audio(260, 1.0, 3.0);
    let beats = apply_beat_pan(&mut audio, &grid(100), 20).unwrap();

    assert_eq!(beats, 3);
    assert!((audio.left[10] - 2.0).abs() < 1e-6);
    assert!(audio.right[10].abs() < 1e-6);

    let expected_center = 2.0 * FRAC_1_SQRT_2;
    assert!((audio.left[100] - expected_center).abs() < 1e-5);
    assert!((audio.right[100] - expected_center).abs() < 1e-5);

    assert!(audio.left[120].abs() < 1e-6);
    assert!((audio.right[120] - 2.0).abs() < 1e-6);

    assert!((audio.left[220] - 2.0).abs() < 1e-6);
    assert!(audio.right[220].abs() < 1e-6);
}

#[test]
fn collapses_the_output_object_to_mono_before_panning() {
    let mut audio =
        StereoAudio::new(SAMPLE_RATE, vec![1.0, -1.0, 0.5], vec![3.0, 1.0, -0.5]).unwrap();
    apply_beat_pan(&mut audio, &grid(10), 0).unwrap();

    assert_eq!(audio.left, vec![2.0, 0.0, 0.0]);
    assert_eq!(audio.right, vec![0.0, 0.0, 0.0]);
}

#[test]
fn cosine_transition_is_continuous_and_centered() {
    let mut audio = constant_audio(140, 1.0, 1.0);
    apply_beat_pan(&mut audio, &grid(100), 20).unwrap();

    let maximum_step = (90..=110)
        .map(|index| {
            let left_step = (audio.left[index] - audio.left[index - 1]).abs();
            let right_step = (audio.right[index] - audio.right[index - 1]).abs();
            left_step.max(right_step)
        })
        .fold(0.0_f32, f32::max);
    assert!(maximum_step < 0.2, "maximum gain step was {maximum_step}");
    assert!((audio.left[100] - audio.right[100]).abs() < 1e-6);
}

#[test]
fn transition_length_is_capped_to_half_the_beat_period() {
    let mut audio = constant_audio(50, 1.0, 1.0);
    apply_beat_pan(&mut audio, &grid(20), 100).unwrap();

    assert!((audio.left[14] - 1.0).abs() < 1e-6);
    assert!(audio.right[14].abs() < 1e-6);
    assert!(audio.left[25].abs() < 1e-6);
    assert!((audio.right[25] - 1.0).abs() < 1e-6);
}

#[test]
fn extended_grid_keeps_alternating_through_the_full_output() {
    let mut audio = constant_audio(85, 1.0, 1.0);
    let beats = apply_beat_pan(&mut audio, &grid(20), 0).unwrap();
    assert_eq!(beats, 5);
    assert!((audio.left[45] - 1.0).abs() < 1e-6);
    assert!(audio.right[45].abs() < 1e-6);
    assert!(audio.left[65].abs() < 1e-6);
    assert!((audio.right[65] - 1.0).abs() < 1e-6);
}
