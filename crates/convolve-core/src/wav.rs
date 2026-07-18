use crate::{
    ConvolveCoreError, StereoAudio,
    views::{ForwardView, StereoSampleView},
};

pub const WAV_HEADER_BYTES: usize = 68;
pub const PCM24_CHUNK_FRAMES: usize = 65_536;
pub const PCM24_CHUNK_BYTES: usize = PCM24_CHUNK_FRAMES * 6;

const PCM24_MIN: i32 = -8_388_608;
const PCM24_MAX: i32 = 8_388_607;
const PCM24_UPPER_FLOAT: f32 = 1.0 - 1.0 / 8_388_608.0;

pub fn encode_pcm24_wav(audio: &StereoAudio) -> Result<Vec<u8>, ConvolveCoreError> {
    let bytes = wav_bytes(audio.frames())?;
    let mut output = Vec::with_capacity(bytes);
    encode_pcm24_wav_to_sink(audio, |chunk| {
        output.extend_from_slice(chunk);
        Ok(())
    })?;
    Ok(output)
}

pub(crate) fn encode_pcm24_wav_view<V: StereoSampleView>(
    view: &V,
) -> Result<Vec<u8>, ConvolveCoreError> {
    let bytes = wav_bytes(view.frames())?;
    let mut output = Vec::with_capacity(bytes);
    output.extend_from_slice(&wav_pcm24_header(view.frames())?);
    for offset in (0..view.frames()).step_by(PCM24_CHUNK_FRAMES) {
        let frames = (view.frames() - offset).min(PCM24_CHUNK_FRAMES);
        encode_pcm24_view_chunk_into(view, offset, frames, &mut output)?;
    }
    Ok(output)
}

fn encode_pcm24_view_chunk_into<V: StereoSampleView>(
    view: &V,
    offset: usize,
    frames: usize,
    output: &mut Vec<u8>,
) -> Result<(), ConvolveCoreError> {
    if frames > PCM24_CHUNK_FRAMES || offset > view.frames() || frames > view.frames() - offset {
        return Err(ConvolveCoreError::invalid(
            "PCM24 chunk range is outside the audio",
        ));
    }
    output.reserve(frames * 6);
    for index in offset..offset + frames {
        write_pcm24(output, sample_to_pcm24(view.left(index)));
        write_pcm24(output, sample_to_pcm24(view.right(index)));
    }
    Ok(())
}
pub fn encode_pcm24_wav_to_sink<F>(
    audio: &StereoAudio,
    mut sink: F,
) -> Result<(), ConvolveCoreError>
where
    F: FnMut(&[u8]) -> Result<(), ConvolveCoreError>,
{
    let view = ForwardView::new(audio);
    sink(&wav_pcm24_header(view.frames())?)?;
    for offset in (0..audio.frames()).step_by(PCM24_CHUNK_FRAMES) {
        let frames = (audio.frames() - offset).min(PCM24_CHUNK_FRAMES);
        let chunk = encode_pcm24_chunk(audio, offset, frames)?;
        sink(&chunk)?;
    }
    Ok(())
}

pub fn wav_pcm24_header(frames: usize) -> Result<[u8; WAV_HEADER_BYTES], ConvolveCoreError> {
    let data_bytes = frames.checked_mul(6).ok_or_else(overflow)?;
    let riff_bytes = data_bytes
        .checked_add(WAV_HEADER_BYTES - 8)
        .ok_or_else(overflow)?;
    let data_bytes = u32::try_from(data_bytes).map_err(|_| overflow())?;
    let riff_bytes = u32::try_from(riff_bytes).map_err(|_| overflow())?;

    let mut header = [0_u8; WAV_HEADER_BYTES];
    header[0..4].copy_from_slice(b"RIFF");
    header[4..8].copy_from_slice(&riff_bytes.to_le_bytes());
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&40_u32.to_le_bytes());
    header[20..22].copy_from_slice(&0xfffe_u16.to_le_bytes());
    header[22..24].copy_from_slice(&2_u16.to_le_bytes());
    header[24..28].copy_from_slice(&crate::SAMPLE_RATE.to_le_bytes());
    header[28..32].copy_from_slice(&(crate::SAMPLE_RATE * 6).to_le_bytes());
    header[32..34].copy_from_slice(&6_u16.to_le_bytes());
    header[34..36].copy_from_slice(&24_u16.to_le_bytes());
    header[36..38].copy_from_slice(&22_u16.to_le_bytes());
    header[38..40].copy_from_slice(&24_u16.to_le_bytes());
    header[40..44].copy_from_slice(&3_u32.to_le_bytes());
    header[44..60].copy_from_slice(&[1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
    header[60..64].copy_from_slice(b"data");
    header[64..68].copy_from_slice(&data_bytes.to_le_bytes());
    Ok(header)
}

pub fn encode_pcm24_chunk(
    audio: &StereoAudio,
    offset: usize,
    frames: usize,
) -> Result<Vec<u8>, ConvolveCoreError> {
    if frames > PCM24_CHUNK_FRAMES || offset > audio.frames() || frames > audio.frames() - offset {
        return Err(ConvolveCoreError::invalid(
            "PCM24 chunk range is outside the audio",
        ));
    }
    let mut chunk = Vec::with_capacity(frames * 6);
    for (&left, &right) in audio.left[offset..offset + frames]
        .iter()
        .zip(&audio.right[offset..offset + frames])
    {
        write_pcm24(&mut chunk, sample_to_pcm24(left));
        write_pcm24(&mut chunk, sample_to_pcm24(right));
    }
    Ok(chunk)
}

fn wav_bytes(frames: usize) -> Result<usize, ConvolveCoreError> {
    frames
        .checked_mul(6)
        .and_then(|bytes| bytes.checked_add(WAV_HEADER_BYTES))
        .ok_or_else(overflow)
}

fn write_pcm24(output: &mut Vec<u8>, sample: i32) {
    let bytes = sample.to_le_bytes();
    output.extend_from_slice(&bytes[..3]);
}

fn sample_to_pcm24(sample: f32) -> i32 {
    if sample <= -1.0 {
        PCM24_MIN
    } else {
        (sample.clamp(-1.0, PCM24_UPPER_FLOAT) * PCM24_MAX as f32).round() as i32
    }
}

fn overflow() -> ConvolveCoreError {
    ConvolveCoreError::EncodeFailed {
        message: "PCM24 WAV size exceeds RIFF's 32-bit limit".to_owned(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SAMPLE_RATE,
        views::{ForwardView, GainView},
    };

    #[test]
    fn layered_views_encode_with_the_same_pcm_rounding_as_materialized_audio() {
        let audio = StereoAudio::new(
            SAMPLE_RATE,
            vec![-1.0, -0.2, 0.3, 1.0],
            vec![1.0, 0.2, -0.3, -1.0],
        )
        .unwrap();
        let mut expected = audio.clone();
        for sample in expected.left.iter_mut().chain(&mut expected.right) {
            *sample *= 0.75;
        }
        let view = GainView::new(ForwardView::new(&audio), 0.75);
        assert_eq!(
            encode_pcm24_wav_view(&view).unwrap(),
            encode_pcm24_wav(&expected).unwrap()
        );
    }
}
