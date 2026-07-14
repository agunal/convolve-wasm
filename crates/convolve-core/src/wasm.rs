use js_sys::{Function, Object, Reflect, Uint8Array};
use wasm_bindgen::{JsValue, prelude::wasm_bindgen};

use crate::{
    ConvolveCoreError, ProcessMetadata, ProcessOptions, ProcessResult, ProcessStage, SAMPLE_RATE,
    StereoAudio, process_with_progress,
};

#[wasm_bindgen]
pub struct WasmProcessResult {
    wav_bytes: Vec<u8>,
    metadata: ProcessMetadata,
}

impl From<ProcessResult> for WasmProcessResult {
    fn from(result: ProcessResult) -> Self {
        Self {
            wav_bytes: result.wav_bytes,
            metadata: result.metadata,
        }
    }
}

#[wasm_bindgen]
impl WasmProcessResult {
    #[must_use]
    pub fn wav_bytes(&self) -> Uint8Array {
        Uint8Array::from(self.wav_bytes.as_slice())
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = sampleRate)]
    pub fn sample_rate(&self) -> u32 {
        self.metadata.sample_rate
    }

    #[must_use]
    #[wasm_bindgen(getter)]
    pub fn channels(&self) -> u32 {
        self.metadata.channels
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = durationSeconds)]
    pub fn duration_seconds(&self) -> f64 {
        self.metadata.duration_seconds
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = outputFrames)]
    pub fn output_frames(&self) -> usize {
        self.metadata.output_frames
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = detectedBeats)]
    pub fn detected_beats(&self) -> usize {
        self.metadata.detected_beats
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = detectedBpm)]
    pub fn detected_bpm(&self) -> Option<f32> {
        self.metadata.detected_bpm
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = beatConfidence)]
    pub fn beat_confidence(&self) -> Option<f32> {
        self.metadata.beat_confidence
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = appliedGainDb)]
    pub fn applied_gain_db(&self) -> f32 {
        self.metadata.applied_gain_db
    }

    #[must_use]
    #[wasm_bindgen(getter, js_name = estimatedTruePeakDbtp)]
    pub fn estimated_true_peak_dbtp(&self) -> f32 {
        self.metadata.estimated_true_peak_dbtp
    }
}

#[wasm_bindgen]
pub fn process_audio_wasm(
    a_left: Box<[f32]>,
    a_right: Box<[f32]>,
    b_left: Box<[f32]>,
    b_right: Box<[f32]>,
    append_reverse: bool,
    options: JsValue,
    progress_callback: Option<Function>,
) -> Result<WasmProcessResult, JsValue> {
    let options = deserialize_options(options).map_err(error_to_js)?;
    let a = StereoAudio::new(SAMPLE_RATE, a_left.into_vec(), a_right.into_vec())
        .map_err(error_to_js)?;
    let b = StereoAudio::new(SAMPLE_RATE, b_left.into_vec(), b_right.into_vec())
        .map_err(error_to_js)?;

    let mut callback_error: Option<String> = None;
    let processed = process_with_progress(&a, &b, append_reverse, options, |stage| {
        if callback_error.is_some() {
            return;
        }
        if let Some(callback) = &progress_callback {
            let (name, fraction) = stage_progress(stage);
            if let Err(error) = callback.call2(
                &JsValue::UNDEFINED,
                &JsValue::from_str(name),
                &JsValue::from_f64(fraction),
            ) {
                callback_error = Some(error.as_string().unwrap_or_else(|| format!("{error:?}")));
            }
        }
    })
    .map_err(error_to_js)?;

    if let Some(message) = callback_error {
        return Err(error_to_js(ConvolveCoreError::ProcessingFailed {
            message: format!("progress callback failed: {message}"),
        }));
    }

    Ok(processed.into())
}

fn deserialize_options(value: JsValue) -> Result<ProcessOptions, ConvolveCoreError> {
    if value.is_null() || value.is_undefined() {
        return Ok(ProcessOptions::default());
    }
    serde_wasm_bindgen::from_value(value).map_err(|error| ConvolveCoreError::InvalidInput {
        message: format!("could not deserialize processing options: {error}"),
    })
}

fn stage_progress(stage: ProcessStage) -> (&'static str, f64) {
    match stage {
        ProcessStage::Validate => ("validate", 0.3),
        ProcessStage::Convolve => ("convolve", 0.55),
        ProcessStage::BeatDetect => ("beat-detect", 0.67),
        ProcessStage::BeatPan => ("beat-pan", 0.74),
        ProcessStage::AppendReverse => ("append-reverse", 0.82),
        ProcessStage::Normalize => ("normalize", 0.9),
        ProcessStage::Encode => ("encode", 0.97),
        ProcessStage::Done => ("done", 1.0),
    }
}

fn error_to_js(error: ConvolveCoreError) -> JsValue {
    let object = Object::new();
    let details = Object::new();

    let _ = Reflect::set(
        &object,
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code()),
    );
    let _ = Reflect::set(
        &object,
        &JsValue::from_str("message"),
        &JsValue::from_str(&error.to_string()),
    );

    if let ConvolveCoreError::InputTooLarge { estimated, limit } = error {
        let _ = Reflect::set(
            &details,
            &JsValue::from_str("estimatedBytes"),
            &JsValue::from_f64(estimated as f64),
        );
        let _ = Reflect::set(
            &details,
            &JsValue::from_str("limitBytes"),
            &JsValue::from_f64(limit as f64),
        );
    }

    let _ = Reflect::set(&object, &JsValue::from_str("details"), details.as_ref());
    object.into()
}
