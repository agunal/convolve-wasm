use convolve_core::{BeatPanSource, ProcessOptions, SAMPLE_RATE, StereoAudio};

pub const GOLDEN_MODES: [GoldenMode; 4] = [
    GoldenMode::Plain,
    GoldenMode::Reverse,
    GoldenMode::BeatPan,
    GoldenMode::BeatPanReverse,
];

#[derive(Clone, Copy, Debug)]
pub enum GoldenMode {
    Plain,
    Reverse,
    BeatPan,
    BeatPanReverse,
}

impl GoldenMode {
    pub const fn name(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Reverse => "reverse",
            Self::BeatPan => "beat-pan",
            Self::BeatPanReverse => "beat-pan-plus-reverse",
        }
    }

    pub const fn append_reverse(self) -> bool {
        matches!(self, Self::Reverse | Self::BeatPanReverse)
    }

    pub fn options(self) -> ProcessOptions {
        ProcessOptions {
            beat_pan: match self {
                Self::BeatPan | Self::BeatPanReverse => Some(BeatPanSource::A),
                Self::Plain | Self::Reverse => None,
            },
            pan_transition_ms: 17.0,
            reverse_crossfade_ms: 7.0,
            target_dbtp: -1.5,
        }
    }
}

pub fn golden_inputs() -> (StereoAudio, StereoAudio) {
    let input_frames = SAMPLE_RATE as usize * 2;
    let beat_period = SAMPLE_RATE as usize / 2;
    let click_frames = 240_usize;
    let mut a_left = vec![0.0_f32; input_frames];
    let mut a_right = vec![0.0_f32; input_frames];

    for beat in (0..input_frames).step_by(beat_period) {
        for offset in 0..click_frames {
            let sample = beat + offset;
            if sample >= input_frames {
                break;
            }
            let envelope = 0.5
                - 0.5 * (std::f32::consts::TAU * offset as f32 / (click_frames - 1) as f32).cos();
            a_left[sample] = envelope * (0.72 + 0.05 * (beat / beat_period) as f32);
            a_right[sample] = envelope * (0.48 + 0.03 * (beat / beat_period) as f32);
        }
    }
    for sample in 0..input_frames {
        let phase = sample as f32 / SAMPLE_RATE as f32;
        a_left[sample] += 0.013 * (std::f32::consts::TAU * 137.0 * phase).sin();
        a_right[sample] += 0.011 * (std::f32::consts::TAU * 211.0 * phase).cos();
    }

    let impulse_frames = 513_usize;
    let mut b_left = Vec::with_capacity(impulse_frames);
    let mut b_right = Vec::with_capacity(impulse_frames);
    for sample in 0..impulse_frames {
        let position = sample as f32 / (impulse_frames - 1) as f32;
        let decay = (-5.0 * position).exp();
        b_left.push(decay * (0.46 * (std::f32::consts::TAU * 31.0 * position).sin() + 0.18));
        b_right.push(decay * (0.39 * (std::f32::consts::TAU * 19.0 * position).cos() - 0.12));
    }

    (
        StereoAudio::new(SAMPLE_RATE, a_left, a_right).unwrap(),
        StereoAudio::new(SAMPLE_RATE, b_left, b_right).unwrap(),
    )
}

#[derive(Clone, Copy, Debug)]
pub struct ExpectedGolden {
    pub wav_sha256: &'static str,
    pub output_frames: usize,
    pub detected_beats: usize,
    pub duration_seconds_bits: u64,
    pub detected_bpm_bits: Option<u32>,
    pub beat_confidence_bits: Option<u32>,
    pub applied_gain_db_bits: u32,
    pub estimated_true_peak_dbtp_bits: u32,
}

#[cfg(all(not(target_arch = "wasm32"), target_os = "windows"))]
pub const fn expected(mode: GoldenMode) -> ExpectedGolden {
    match mode {
        GoldenMode::Plain => ExpectedGolden {
            wav_sha256: "d2f84dba8182190b049a71147261318ca40e426b3d10928bbbf7fe603f9a8f9b",
            output_frames: 96_512,
            detected_beats: 0,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::Reverse => ExpectedGolden {
            wav_sha256: "7c10802259ba505d003e8ba971c6d008da40d7f2d6085e5b57f5d4a3fbf1ffbc",
            output_frames: 192_688,
            detected_beats: 0,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::BeatPan => ExpectedGolden {
            wav_sha256: "64d150201e1593b6147b4cf3923bf51f2bdb6e91619e795d260c924973771c85",
            output_frames: 96_512,
            detected_beats: 5,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_588),
            applied_gain_db_bits: 3_239_862_916,
            estimated_true_peak_dbtp_bits: 3_217_031_174,
        },
        GoldenMode::BeatPanReverse => ExpectedGolden {
            wav_sha256: "c64e6c6a4b5db445f3ba86945551c03134d11bb893e461608753af21b416860a",
            output_frames: 192_688,
            detected_beats: 5,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_588),
            applied_gain_db_bits: 3_239_862_916,
            estimated_true_peak_dbtp_bits: 3_217_031_174,
        },
    }
}

// Native libm and FFT execution are platform-specific. The published browser contract uses the
// target-independent generated-WASM goldens below; these values freeze the Linux CI baseline.
#[cfg(all(not(target_arch = "wasm32"), target_os = "linux"))]
pub const fn expected(mode: GoldenMode) -> ExpectedGolden {
    match mode {
        GoldenMode::Plain => ExpectedGolden {
            wav_sha256: "8170684b5df2c306c0ada3e0664f70fe3c6e3cc551c2c999332f46802eb79e80",
            output_frames: 96_512,
            detected_beats: 0,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::Reverse => ExpectedGolden {
            wav_sha256: "fdda1356618f9e1366f0fac46bd71a95abad9ab4e91cc2d3ad15def70fbf15b7",
            output_frames: 192_688,
            detected_beats: 0,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::BeatPan => ExpectedGolden {
            wav_sha256: "7008f550d3cdc99c9130effc5c9ba6429ce38d31bf375567cd6242d8aa64c66f",
            output_frames: 96_512,
            detected_beats: 5,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_589),
            applied_gain_db_bits: 3_239_862_915,
            estimated_true_peak_dbtp_bits: 3_217_031_174,
        },
        GoldenMode::BeatPanReverse => ExpectedGolden {
            wav_sha256: "9bb7cc6bba2083a6757deebc0aa236765f88031eb154a82e0feb7987dd252e98",
            output_frames: 192_688,
            detected_beats: 5,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_589),
            applied_gain_db_bits: 3_239_862_915,
            estimated_true_peak_dbtp_bits: 3_217_031_174,
        },
    }
}

#[cfg(target_arch = "wasm32")]
pub const fn expected_wasm(mode: GoldenMode) -> ExpectedGolden {
    match mode {
        GoldenMode::Plain => ExpectedGolden {
            wav_sha256: "372218d9919a982647be205ddbb517856dfdd1edf29a5d7bcefc4fdd86d8328d",
            output_frames: 96_512,
            detected_beats: 0,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::Reverse => ExpectedGolden {
            wav_sha256: "9881a2bfcc35ff8be19502dbc9866eb0c3eb9581d9e69ef6d3ffa765792bc820",
            output_frames: 192_688,
            detected_beats: 0,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: None,
            beat_confidence_bits: None,
            applied_gain_db_bits: 3_249_300_948,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::BeatPan => ExpectedGolden {
            wav_sha256: "7230c86e9aa9bfde68905233e786078f3a9164c65ffcc9b3a22d41b8bbacc375",
            output_frames: 96_512,
            detected_beats: 5,
            duration_seconds_bits: 4_611_710_037_625_400_547,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_588),
            applied_gain_db_bits: 3_239_862_917,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
        GoldenMode::BeatPanReverse => ExpectedGolden {
            wav_sha256: "34478ca4da0dd6760ae1a61698f381a22706889e62f4d360a8dff7bc54c290d4",
            output_frames: 192_688,
            detected_beats: 5,
            duration_seconds_bits: 4_616_205_755_953_423_144,
            detected_bpm_bits: Some(1_122_983_065),
            beat_confidence_bits: Some(1_059_500_588),
            applied_gain_db_bits: 3_239_862_917,
            estimated_true_peak_dbtp_bits: 3_217_031_168,
        },
    }
}
pub fn assert_extensible_pcm24_header(wav: &[u8]) {
    assert!(
        wav.len() >= 68,
        "WAV must include the 68-byte extensible header"
    );
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(
        u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize + 8,
        wav.len()
    );
    assert_eq!(&wav[8..12], b"WAVE");
    assert_eq!(&wav[12..16], b"fmt ");
    assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 40);
    assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 0xfffe);
    assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 2);
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 48_000);
    assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 288_000);
    assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 6);
    assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 24);
    assert_eq!(u16::from_le_bytes(wav[36..38].try_into().unwrap()), 22);
    assert_eq!(u16::from_le_bytes(wav[38..40].try_into().unwrap()), 24);
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 3);
    assert_eq!(
        &wav[44..60],
        &[1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113],
    );
    assert_eq!(&wav[60..64], b"data");
    assert_eq!(
        u32::from_le_bytes(wav[64..68].try_into().unwrap()) as usize + 68,
        wav.len()
    );
}
