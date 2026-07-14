use crate::{
    BeatPanSource, ConvolveCoreError, ProcessMetadata, ProcessOptions, SAMPLE_RATE, StereoAudio,
    append_reverse, apply_beat_pan, convolve_stereo, detect_beat_grid, encode_pcm24_wav,
    estimate_peak_bytes, normalize_true_peak,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessStage {
    Validate,
    Convolve,
    BeatDetect,
    BeatPan,
    AppendReverse,
    Normalize,
    Encode,
    Done,
}

#[derive(Debug)]
pub struct ProcessResult {
    pub wav_bytes: Vec<u8>,
    pub metadata: ProcessMetadata,
}

pub fn process(
    a: &StereoAudio,
    b: &StereoAudio,
    append_reverse_output: bool,
    options: ProcessOptions,
) -> Result<ProcessResult, ConvolveCoreError> {
    process_with_progress(a, b, append_reverse_output, options, |_| {})
}

pub fn process_with_progress<F>(
    a: &StereoAudio,
    b: &StereoAudio,
    append_reverse_output: bool,
    options: ProcessOptions,
    mut on_progress: F,
) -> Result<ProcessResult, ConvolveCoreError>
where
    F: FnMut(ProcessStage),
{
    options.validate()?;
    let pan_transition_samples = options.pan_transition_samples()?;
    let requested_crossfade_samples = options.reverse_crossfade_samples()?;
    let forward_frames = crate::convolution_frames(a.frames(), b.frames())?;
    let effective_crossfade_samples = if append_reverse_output {
        requested_crossfade_samples.min(forward_frames.saturating_sub(1))
    } else {
        0
    };

    estimate_peak_bytes(
        a.frames(),
        b.frames(),
        append_reverse_output,
        effective_crossfade_samples,
    )?;
    on_progress(ProcessStage::Validate);

    let mut output = convolve_stereo(a, b)?;
    on_progress(ProcessStage::Convolve);

    let (detected_beats, detected_bpm, beat_confidence) = match options.beat_pan {
        Some(source) => {
            let beat_source = match source {
                BeatPanSource::A => a,
                BeatPanSource::B => b,
            };
            let grid = detect_beat_grid(beat_source)?;
            on_progress(ProcessStage::BeatDetect);
            let count = apply_beat_pan(&mut output, &grid, pan_transition_samples)?;
            on_progress(ProcessStage::BeatPan);
            (count, Some(grid.bpm), Some(grid.confidence))
        }
        None => (0, None, None),
    };

    if append_reverse_output {
        output = append_reverse(&output, effective_crossfade_samples);
        on_progress(ProcessStage::AppendReverse);
    }

    let normalization = normalize_true_peak(&mut output, options.target_dbtp)?;
    on_progress(ProcessStage::Normalize);
    let output_frames = output.frames();
    let wav_bytes = encode_pcm24_wav(&output)?;
    on_progress(ProcessStage::Encode);
    let metadata = ProcessMetadata {
        sample_rate: SAMPLE_RATE,
        channels: 2,
        duration_seconds: output_frames as f64 / f64::from(SAMPLE_RATE),
        output_frames,
        detected_beats,
        detected_bpm,
        beat_confidence,
        applied_gain_db: normalization.applied_gain_db,
        estimated_true_peak_dbtp: normalization.estimated_true_peak_dbtp,
    };

    let result = ProcessResult {
        wav_bytes,
        metadata,
    };
    on_progress(ProcessStage::Done);
    Ok(result)
}
