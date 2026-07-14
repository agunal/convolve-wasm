use crate::{ConvolveCoreError, SAMPLE_RATE};

#[derive(Clone, Debug, PartialEq)]
pub struct StereoAudio {
    pub sample_rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl StereoAudio {
    pub fn new(
        sample_rate: u32,
        left: Vec<f32>,
        right: Vec<f32>,
    ) -> Result<Self, ConvolveCoreError> {
        if sample_rate != SAMPLE_RATE {
            return Err(ConvolveCoreError::invalid(format!(
                "sample rate must be exactly {SAMPLE_RATE} Hz"
            )));
        }
        if left.is_empty() || right.is_empty() {
            return Err(ConvolveCoreError::invalid(
                "audio channels must not be empty",
            ));
        }
        if left.len() != right.len() {
            return Err(ConvolveCoreError::invalid(
                "left and right channel lengths must match",
            ));
        }
        if !left
            .iter()
            .chain(right.iter())
            .all(|sample| sample.is_finite())
        {
            return Err(ConvolveCoreError::invalid(
                "audio samples must all be finite",
            ));
        }

        Ok(Self {
            sample_rate,
            left,
            right,
        })
    }

    #[must_use]
    pub fn frames(&self) -> usize {
        self.left.len()
    }
}
