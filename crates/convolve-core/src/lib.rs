mod audio;
mod beats;
mod convolution;
mod error;
mod limits;
mod options;
mod panning;
mod processor;
mod reverse;
mod true_peak;
mod views;
#[cfg(target_arch = "wasm32")]
mod wasm;
mod wav;

pub use audio::StereoAudio;
pub use beats::{BeatGrid, detect_beat_grid};
pub use convolution::convolve_stereo;
pub use error::ConvolveCoreError;
pub use limits::{MAX_BYTES, convolution_frames, estimate_peak_bytes};
pub use options::{BeatPanSource, ProcessMetadata, ProcessOptions};
pub use panning::apply_beat_pan;
pub use processor::{ProcessResult, ProcessStage, process, process_with_progress};
pub use reverse::append_reverse;
pub use true_peak::{NormalizationResult, estimate_true_peak, normalize_true_peak};
#[cfg(target_arch = "wasm32")]
pub use wasm::{WasmProcessResult, process_audio_wasm};
pub use wav::{
    PCM24_CHUNK_BYTES, PCM24_CHUNK_FRAMES, WAV_HEADER_BYTES, encode_pcm24_chunk, encode_pcm24_wav,
    encode_pcm24_wav_to_sink, wav_pcm24_header,
};

pub const SAMPLE_RATE: u32 = 48_000;

#[cfg(test)]
mod tests {
    use super::SAMPLE_RATE;

    #[test]
    fn processing_sample_rate_is_fixed() {
        assert_eq!(SAMPLE_RATE, 48_000);
    }
}
