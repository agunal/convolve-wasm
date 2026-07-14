use serde::{Deserialize, Serialize};

use crate::{ConvolveCoreError, SAMPLE_RATE};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BeatPanSource {
    A,
    B,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProcessOptions {
    pub beat_pan: Option<BeatPanSource>,
    pub pan_transition_ms: f64,
    pub reverse_crossfade_ms: f64,
    pub target_dbtp: f32,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            beat_pan: None,
            pan_transition_ms: 20.0,
            reverse_crossfade_ms: 5.0,
            target_dbtp: -1.0,
        }
    }
}

impl ProcessOptions {
    pub fn validate(&self) -> Result<(), ConvolveCoreError> {
        validate_milliseconds("panTransitionMs", self.pan_transition_ms)?;
        validate_milliseconds("reverseCrossfadeMs", self.reverse_crossfade_ms)?;
        if !self.target_dbtp.is_finite() || !(-24.0..=0.0).contains(&self.target_dbtp) {
            return Err(ConvolveCoreError::invalid(
                "targetDbtp must be finite and between -24 and 0",
            ));
        }
        Ok(())
    }

    pub fn pan_transition_samples(&self) -> Result<usize, ConvolveCoreError> {
        milliseconds_to_samples("panTransitionMs", self.pan_transition_ms)
    }

    pub fn reverse_crossfade_samples(&self) -> Result<usize, ConvolveCoreError> {
        milliseconds_to_samples("reverseCrossfadeMs", self.reverse_crossfade_ms)
    }
}

fn validate_milliseconds(name: &str, value: f64) -> Result<(), ConvolveCoreError> {
    if !value.is_finite() || value < 0.0 {
        return Err(ConvolveCoreError::invalid(format!(
            "{name} must be a finite non-negative number"
        )));
    }
    Ok(())
}

fn milliseconds_to_samples(name: &str, value: f64) -> Result<usize, ConvolveCoreError> {
    validate_milliseconds(name, value)?;
    let samples = (value * f64::from(SAMPLE_RATE) / 1_000.0).round();
    if samples > usize::MAX as f64 {
        return Err(ConvolveCoreError::invalid(format!(
            "{name} is too large to convert to samples"
        )));
    }
    Ok(samples as usize)
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMetadata {
    pub sample_rate: u32,
    pub channels: u32,
    pub duration_seconds: f64,
    pub output_frames: usize,
    pub detected_beats: usize,
    pub detected_bpm: Option<f32>,
    pub beat_confidence: Option<f32>,
    pub applied_gain_db: f32,
    pub estimated_true_peak_dbtp: f32,
}
