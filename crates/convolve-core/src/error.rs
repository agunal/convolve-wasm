use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConvolveCoreError {
    #[error("{message}")]
    InvalidInput { message: String },

    #[error("Estimated peak allocation {estimated} bytes exceeds limit {limit} bytes")]
    InputTooLarge { estimated: usize, limit: usize },

    #[error("Beat detection failed: {message}")]
    BeatDetectionFailed { message: String },

    #[error("Processing failed: {message}")]
    ProcessingFailed { message: String },

    #[error("WAV encoding failed: {message}")]
    EncodeFailed { message: String },
}

impl ConvolveCoreError {
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidInput { .. } => "INVALID_INPUT",
            Self::InputTooLarge { .. } => "INPUT_TOO_LARGE",
            Self::BeatDetectionFailed { .. } => "BEAT_DETECTION_FAILED",
            Self::ProcessingFailed { .. } => "PROCESSING_FAILED",
            Self::EncodeFailed { .. } => "ENCODE_FAILED",
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }

    pub(crate) fn processing(message: impl Into<String>) -> Self {
        Self::ProcessingFailed {
            message: message.into(),
        }
    }

    pub(crate) fn fft(error: impl std::fmt::Display) -> Self {
        Self::processing(format!("FFT operation failed: {error}"))
    }
}
