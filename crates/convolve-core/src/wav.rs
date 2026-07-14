use std::io::Cursor;

use hound::{SampleFormat, WavSpec, WavWriter};

use crate::{ConvolveCoreError, StereoAudio};

const PCM24_MIN: i32 = -8_388_608;
const PCM24_MAX: i32 = 8_388_607;
const PCM24_UPPER_FLOAT: f32 = 1.0 - 1.0 / 8_388_608.0;

pub fn encode_pcm24_wav(audio: &StereoAudio) -> Result<Vec<u8>, ConvolveCoreError> {
    let spec = WavSpec {
        channels: 2,
        sample_rate: audio.sample_rate,
        bits_per_sample: 24,
        sample_format: SampleFormat::Int,
    };
    let estimated_bytes = audio
        .frames()
        .checked_mul(6)
        .and_then(|bytes| bytes.checked_add(64))
        .unwrap_or(0);
    let mut cursor = Cursor::new(Vec::with_capacity(estimated_bytes));

    {
        let mut writer = WavWriter::new(&mut cursor, spec).map_err(encode_error)?;
        for (&left, &right) in audio.left.iter().zip(&audio.right) {
            writer
                .write_sample(sample_to_pcm24(left))
                .map_err(encode_error)?;
            writer
                .write_sample(sample_to_pcm24(right))
                .map_err(encode_error)?;
        }
        writer.finalize().map_err(encode_error)?;
    }

    Ok(cursor.into_inner())
}

fn sample_to_pcm24(sample: f32) -> i32 {
    if sample <= -1.0 {
        PCM24_MIN
    } else {
        (sample.clamp(-1.0, PCM24_UPPER_FLOAT) * PCM24_MAX as f32).round() as i32
    }
}

fn encode_error(error: hound::Error) -> ConvolveCoreError {
    ConvolveCoreError::EncodeFailed {
        message: error.to_string(),
    }
}
