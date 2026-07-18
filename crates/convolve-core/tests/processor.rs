use convolve_core::{
    BeatPanSource, MAX_BYTES, ProcessOptions, ProcessStage, SAMPLE_RATE, StereoAudio,
    convolution_frames, estimate_peak_bytes, process, process_with_progress,
};

#[test]
fn output_length_is_full_linear_convolution() {
    assert_eq!(convolution_frames(3, 4).unwrap(), 6);
}

#[test]
fn rejects_empty_inputs() {
    let error = StereoAudio::new(SAMPLE_RATE, vec![], vec![]).unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
}

#[test]
fn rejects_mismatched_channel_lengths() {
    let error = StereoAudio::new(SAMPLE_RATE, vec![0.0], vec![0.0, 1.0]).unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
}

#[test]
fn rejects_non_finite_samples() {
    let error = StereoAudio::new(SAMPLE_RATE, vec![f32::NAN], vec![0.0]).unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
}

#[test]
fn rejects_wrong_sample_rate() {
    let error = StereoAudio::new(44_100, vec![0.0], vec![0.0]).unwrap_err();
    assert_eq!(error.code(), "INVALID_INPUT");
}

#[test]
fn rust_defaults_match_the_public_contract() {
    let options = ProcessOptions::default();
    assert_eq!(options.beat_pan, None);
    assert_eq!(options.pan_transition_ms, 20.0);
    assert_eq!(options.reverse_crossfade_ms, 5.0);
    assert_eq!(options.target_dbtp, -1.0);
    assert_eq!(options.pan_transition_samples().unwrap(), 960);
    assert_eq!(options.reverse_crossfade_samples().unwrap(), 240);
}

#[test]
fn validates_option_ranges() {
    let invalid = ProcessOptions {
        beat_pan: Some(BeatPanSource::A),
        target_dbtp: 0.1,
        ..ProcessOptions::default()
    };
    assert_eq!(invalid.validate().unwrap_err().code(), "INVALID_INPUT");
}

#[test]
fn estimates_small_request_below_limit() {
    let estimate = estimate_peak_bytes(48_000, 24_000, false, 240).unwrap();
    assert!(estimate < MAX_BYTES);
}

#[test]
fn rust_guard_uses_the_reduced_option_independent_workspace_model() {
    let plain = estimate_peak_bytes(48_000, 24_000, false, 0).unwrap();
    let reverse = estimate_peak_bytes(48_000, 24_000, true, 240).unwrap();
    assert_eq!(plain, 21_861_368);
    assert_eq!(reverse, plain);
}
#[test]
fn rejects_estimates_over_256_mib() {
    let error = estimate_peak_bytes(20_000_000, 20_000_000, true, 240).unwrap_err();
    assert_eq!(error.code(), "INPUT_TOO_LARGE");
}

#[test]
fn checked_arithmetic_rejects_overflow() {
    let error = estimate_peak_bytes(usize::MAX, 2, false, 0).unwrap_err();
    assert_eq!(error.code(), "INPUT_TOO_LARGE");
}

fn impulse() -> StereoAudio {
    StereoAudio::new(SAMPLE_RATE, vec![1.0], vec![1.0]).unwrap()
}

fn silence(frames: usize) -> StereoAudio {
    StereoAudio::new(SAMPLE_RATE, vec![0.0; frames], vec![0.0; frames]).unwrap()
}

fn click_track(frames: usize, period: usize) -> StereoAudio {
    let mut samples = vec![0.0_f32; frames];
    let click_frames = 240_usize;
    for beat in (0..frames).step_by(period) {
        for index in 0..click_frames {
            if beat + index >= frames {
                break;
            }
            let phase = index as f32 / (click_frames - 1) as f32;
            samples[beat + index] = 0.5 - 0.5 * (std::f32::consts::TAU * phase).cos();
        }
    }
    StereoAudio::new(SAMPLE_RATE, samples.clone(), samples).unwrap()
}

fn decode_result_wav(bytes: Vec<u8>) -> StereoAudio {
    let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
    let samples = reader
        .samples::<i32>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let mut left = Vec::with_capacity(samples.len() / 2);
    let mut right = Vec::with_capacity(samples.len() / 2);
    let to_float = |sample: i32| {
        if sample < 0 {
            sample as f32 / 8_388_608.0
        } else {
            sample as f32 / 8_388_607.0
        }
    };
    for frame in samples.chunks_exact(2) {
        left.push(to_float(frame[0]));
        right.push(to_float(frame[1]));
    }
    StereoAudio::new(SAMPLE_RATE, left, right).unwrap()
}

#[test]
fn processor_returns_wav_and_complete_plain_metadata() {
    let a = StereoAudio::new(SAMPLE_RATE, vec![1.0, 2.0], vec![1.0, 2.0]).unwrap();
    let b = StereoAudio::new(SAMPLE_RATE, vec![1.0, 1.0], vec![1.0, 1.0]).unwrap();
    let result = process(&a, &b, false, ProcessOptions::default()).unwrap();
    let decoded = decode_result_wav(result.wav_bytes);

    assert_eq!(decoded.frames(), 3);
    assert_eq!(result.metadata.sample_rate, 48_000);
    assert_eq!(result.metadata.channels, 2);
    assert_eq!(result.metadata.output_frames, 3);
    assert_eq!(result.metadata.detected_beats, 0);
    assert_eq!(result.metadata.detected_bpm, None);
    assert_eq!(result.metadata.beat_confidence, None);
    assert!((result.metadata.estimated_true_peak_dbtp - -1.0).abs() <= 0.05);
}

#[test]
fn processor_writes_signed_pcm24_wav() {
    let result = process(&impulse(), &impulse(), false, ProcessOptions::default()).unwrap();
    let reader = hound::WavReader::new(std::io::Cursor::new(result.wav_bytes)).unwrap();
    let spec = reader.spec();

    assert_eq!(spec.channels, 2);
    assert_eq!(spec.sample_rate, 48_000);
    assert_eq!(spec.bits_per_sample, 24);
    assert_eq!(spec.sample_format, hound::SampleFormat::Int);
}

#[test]
fn beat_detection_uses_only_the_requested_original_input() {
    let frames = SAMPLE_RATE as usize * 2;
    let clicks = click_track(frames, 24_000);
    let short_impulse = impulse();

    let from_a = process(
        &clicks,
        &short_impulse,
        false,
        ProcessOptions {
            beat_pan: Some(BeatPanSource::A),
            ..ProcessOptions::default()
        },
    )
    .unwrap();
    assert!(from_a.metadata.detected_beats >= 3);
    assert!((from_a.metadata.detected_bpm.unwrap() - 120.0).abs() <= 4.0);

    let from_b = process(
        &short_impulse,
        &clicks,
        false,
        ProcessOptions {
            beat_pan: Some(BeatPanSource::B),
            ..ProcessOptions::default()
        },
    )
    .unwrap();
    assert!(from_b.metadata.detected_beats >= 3);

    let error = process(
        &clicks,
        &short_impulse,
        false,
        ProcessOptions {
            beat_pan: Some(BeatPanSource::B),
            ..ProcessOptions::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code(), "BEAT_DETECTION_FAILED");
}

#[test]
fn pan_happens_before_reverse_and_peak_normalization_is_last() {
    let frames = SAMPLE_RATE as usize * 2;
    let clicks = click_track(frames, 24_000);
    let options = ProcessOptions {
        beat_pan: Some(BeatPanSource::A),
        reverse_crossfade_ms: 5.0,
        target_dbtp: -1.0,
        ..ProcessOptions::default()
    };
    let result = process(&clicks, &impulse(), true, options).unwrap();
    let decoded = decode_result_wav(result.wav_bytes);
    let crossfade = options.reverse_crossfade_samples().unwrap();

    assert_eq!(decoded.frames(), 2 * frames - crossfade);
    for channel in [&decoded.left, &decoded.right] {
        for (forward, reverse) in channel.iter().zip(channel.iter().rev()) {
            assert!((forward - reverse).abs() <= 1e-6);
        }
    }
    assert!((result.metadata.estimated_true_peak_dbtp - -1.0).abs() <= 0.05);
    assert_eq!(result.metadata.output_frames, decoded.frames());
}

#[test]
fn silence_succeeds_when_beat_pan_is_not_requested() {
    let result = process(
        &silence(2_048),
        &impulse(),
        false,
        ProcessOptions::default(),
    )
    .unwrap();
    assert_eq!(result.metadata.detected_beats, 0);
    assert_eq!(result.metadata.applied_gain_db, 0.0);
    assert_eq!(result.metadata.estimated_true_peak_dbtp, f32::NEG_INFINITY);
}

#[test]
fn processor_reports_only_the_stages_it_executes_in_order() {
    let mut stages = Vec::new();
    process_with_progress(
        &StereoAudio::new(SAMPLE_RATE, vec![1.0], vec![1.0]).unwrap(),
        &impulse(),
        false,
        ProcessOptions::default(),
        |stage| stages.push(stage),
    )
    .unwrap();
    assert_eq!(
        stages,
        vec![
            ProcessStage::Validate,
            ProcessStage::Convolve,
            ProcessStage::Normalize,
            ProcessStage::Encode,
            ProcessStage::Done,
        ]
    );
}
