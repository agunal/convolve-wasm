use std::f32::consts::PI;

use convolve_core::{SAMPLE_RATE, StereoAudio, detect_beat_grid};

fn click_track(bpm: f32, duration_seconds: usize) -> StereoAudio {
    let frames = SAMPLE_RATE as usize * duration_seconds;
    let period = (60.0 * SAMPLE_RATE as f32 / bpm).round() as usize;
    let click_frames = (0.005 * SAMPLE_RATE as f32).round() as usize;
    let mut samples = vec![0.0_f32; frames];

    for beat in (0..frames).step_by(period) {
        for index in 0..click_frames {
            let sample = beat + index;
            if sample >= frames {
                break;
            }
            let phase = if click_frames > 1 {
                index as f32 / (click_frames - 1) as f32
            } else {
                0.0
            };
            samples[sample] += 0.5 - 0.5 * (2.0 * PI * phase).cos();
        }
    }

    StereoAudio::new(SAMPLE_RATE, samples.clone(), samples).unwrap()
}

fn assert_detects_bpm(target_bpm: f32) {
    let audio = click_track(target_bpm, 8);
    let grid = detect_beat_grid(&audio).unwrap();
    let relative_error = (grid.bpm - target_bpm).abs() / target_bpm;
    assert!(
        relative_error <= 0.03,
        "target {target_bpm}, detected {}, confidence {}",
        grid.bpm,
        grid.confidence
    );

    let expected_period = 60.0 * SAMPLE_RATE as f32 / target_bpm;
    assert!(
        (grid.period_samples as f32 - expected_period).abs() <= 0.020 * SAMPLE_RATE as f32,
        "target period {expected_period}, detected {}",
        grid.period_samples
    );
    assert!(grid.confidence >= 0.15);
    assert_eq!(grid.anchor_sample, 0);

    let extended_end = audio.frames() + 3 * grid.period_samples;
    let beats = grid.samples_until(extended_end);
    assert!(beats.len() >= 10);
    assert!(beats.last().copied().unwrap() > audio.frames());
    assert!(
        beats
            .windows(2)
            .all(|pair| pair[1] - pair[0] == grid.period_samples)
    );
}

#[test]
fn detects_90_bpm_click_track() {
    assert_detects_bpm(90.0);
}

#[test]
fn detects_120_bpm_click_track() {
    assert_detects_bpm(120.0);
}

#[test]
fn detects_160_bpm_click_track() {
    assert_detects_bpm(160.0);
}

#[test]
fn silence_fails_instead_of_disabling_the_requested_effect() {
    let silence = StereoAudio::new(
        SAMPLE_RATE,
        vec![0.0; SAMPLE_RATE as usize * 2],
        vec![0.0; SAMPLE_RATE as usize * 2],
    )
    .unwrap();
    let error = detect_beat_grid(&silence).unwrap_err();
    assert_eq!(error.code(), "BEAT_DETECTION_FAILED");
}
