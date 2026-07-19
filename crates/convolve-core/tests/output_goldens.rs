#![cfg(all(
    not(target_arch = "wasm32"),
    any(target_os = "windows", target_os = "linux")
))]

mod golden_fixtures;

use convolve_core::{ProcessMetadata, process};
use sha2::{Digest, Sha256};

use golden_fixtures::{GOLDEN_MODES, assert_extensible_pcm24_header, expected, golden_inputs};

fn metadata_matches(
    metadata: &ProcessMetadata,
    expected: &golden_fixtures::ExpectedGolden,
) -> bool {
    metadata.sample_rate == 48_000
        && metadata.channels == 2
        && metadata.output_frames == expected.output_frames
        && metadata.detected_beats == expected.detected_beats
        && metadata.duration_seconds.to_bits() == expected.duration_seconds_bits
        && metadata.detected_bpm.map(f32::to_bits) == expected.detected_bpm_bits
        && metadata.beat_confidence.map(f32::to_bits) == expected.beat_confidence_bits
        && metadata.applied_gain_db.to_bits() == expected.applied_gain_db_bits
        && metadata.estimated_true_peak_dbtp.to_bits() == expected.estimated_true_peak_dbtp_bits
}

#[test]
fn full_engine_wav_and_metadata_match_frozen_goldens() {
    let (a, b) = golden_inputs();
    let mut mismatches = Vec::new();
    for mode in GOLDEN_MODES {
        let result = process(&a, &b, mode.append_reverse(), mode.options()).unwrap();
        let expected = expected(mode);
        assert_extensible_pcm24_header(&result.wav_bytes);
        let wav_sha256 = format!("{:x}", Sha256::digest(&result.wav_bytes));
        if wav_sha256 != expected.wav_sha256 || !metadata_matches(&result.metadata, &expected) {
            mismatches.push(format!(
                "{}: hash={} frames={} beats={} duration_bits={} bpm_bits={:?} confidence_bits={:?} gain_bits={} peak_bits={}",
                mode.name(),
                wav_sha256,
                result.metadata.output_frames,
                result.metadata.detected_beats,
                result.metadata.duration_seconds.to_bits(),
                result.metadata.detected_bpm.map(f32::to_bits),
                result.metadata.beat_confidence.map(f32::to_bits),
                result.metadata.applied_gain_db.to_bits(),
                result.metadata.estimated_true_peak_dbtp.to_bits(),
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "native golden mismatches:\n{}",
        mismatches.join("\n")
    );
}
