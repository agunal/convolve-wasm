use std::{f32::consts::PI, io::Cursor};

use convolve_core::{
    SAMPLE_RATE, StereoAudio, encode_pcm24_wav, estimate_true_peak, normalize_true_peak,
};
use hound::{SampleFormat, WavReader};

fn intersample_sine(frames: usize) -> StereoAudio {
    let frequency = 12_000.0_f32;
    let phase = PI / 4.0;
    let samples: Vec<f32> = (0..frames)
        .map(|index| (2.0 * PI * frequency * index as f32 / SAMPLE_RATE as f32 + phase).sin())
        .collect();
    StereoAudio::new(SAMPLE_RATE, samples.clone(), samples).unwrap()
}

#[test]
fn four_times_oversampling_detects_intersample_peak() {
    let audio = intersample_sine(4_096);
    let sample_peak = audio
        .left
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0_f32, f32::max);
    let true_peak = estimate_true_peak(&audio).unwrap();

    assert!(sample_peak < 0.72, "sample peak was {sample_peak}");
    assert!(true_peak > 0.95, "estimated true peak was {true_peak}");
}

#[test]
fn matches_the_32_tap_blackman_windowed_sinc_reference() {
    let mut samples = vec![0.0_f32; 64];
    samples[20..28].copy_from_slice(&[0.0, 0.2, -0.7, 0.3, 1.0, -0.4, 0.1, 0.0]);
    let audio = StereoAudio::new(SAMPLE_RATE, samples, vec![0.0; 64]).unwrap();

    let peak = estimate_true_peak(&audio).unwrap();

    assert!(
        (peak - 1.167_154).abs() <= 1e-5,
        "estimated peak was {peak}"
    );
}

#[test]
fn estimate_is_never_below_the_ordinary_sample_peak() {
    let audio =
        StereoAudio::new(SAMPLE_RATE, vec![0.0, -0.25, 0.95, 0.1, 0.0], vec![0.0; 5]).unwrap();

    assert!(estimate_true_peak(&audio).unwrap() >= 0.95);
}

#[test]
fn normalization_lands_within_point_zero_five_dbtp() {
    let mut audio = intersample_sine(4_096);
    let result = normalize_true_peak(&mut audio, -1.0).unwrap();
    let post_peak = estimate_true_peak(&audio).unwrap();
    let post_dbtp = 20.0 * post_peak.log10();

    assert!(
        (post_dbtp - -1.0_f32).abs() <= 0.05_f32,
        "post peak was {post_dbtp}"
    );
    assert!((result.estimated_true_peak_dbtp - post_dbtp).abs() <= 0.01);
    assert!(result.applied_gain_db < -0.5);

    let sample_peak = audio
        .left
        .iter()
        .copied()
        .map(f32::abs)
        .fold(0.0_f32, f32::max);
    assert!(20.0 * sample_peak.log10() < -2.5);
}

#[test]
fn already_safe_audio_is_not_boosted() {
    let original = vec![0.1_f32; 256];
    let mut audio = StereoAudio::new(SAMPLE_RATE, original.clone(), original.clone()).unwrap();

    let result = normalize_true_peak(&mut audio, -1.0).unwrap();

    assert_eq!(result.applied_gain_db, 0.0);
    assert_eq!(audio.left, original);
    assert_eq!(audio.right, audio.left);
    assert!(result.estimated_true_peak_dbtp < -1.0);
}

#[test]
fn silence_reports_negative_infinity_without_changing_samples() {
    let mut audio = StereoAudio::new(SAMPLE_RATE, vec![0.0; 32], vec![0.0; 32]).unwrap();
    let result = normalize_true_peak(&mut audio, -1.0).unwrap();
    assert_eq!(result.applied_gain_db, 0.0);
    assert_eq!(result.estimated_true_peak_dbtp, f32::NEG_INFINITY);
    assert!(audio.left.iter().all(|sample| *sample == 0.0));
}

#[test]
fn writes_interleaved_48khz_stereo_signed_pcm24_wav() {
    let audio =
        StereoAudio::new(SAMPLE_RATE, vec![-1.0, 0.25, 1.0], vec![0.5, -0.25, 2.0]).unwrap();
    let bytes = encode_pcm24_wav(&audio).unwrap();

    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut reader = WavReader::new(Cursor::new(bytes)).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 48_000);
    assert_eq!(spec.channels, 2);
    assert_eq!(spec.bits_per_sample, 24);
    assert_eq!(spec.sample_format, SampleFormat::Int);
    let samples = reader
        .samples::<i32>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        samples,
        vec![
            -8_388_608, 4_194_304, 2_097_152, -2_097_152, 8_388_606, 8_388_606,
        ]
    );
}
