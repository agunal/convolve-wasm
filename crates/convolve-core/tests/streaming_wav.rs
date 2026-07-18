use std::io::Cursor;

use convolve_core::{
    PCM24_CHUNK_FRAMES, SAMPLE_RATE, StereoAudio, encode_pcm24_chunk, encode_pcm24_wav,
    encode_pcm24_wav_to_sink, wav_pcm24_header,
};

fn audio(frames: usize) -> StereoAudio {
    let left = (0..frames)
        .map(|index| (index as f32 * 0.001_953_125).sin())
        .collect();
    let right = (0..frames)
        .map(|index| -(index as f32 * 0.003_906_25).cos())
        .collect();
    StereoAudio::new(SAMPLE_RATE, left, right).unwrap()
}

#[test]
fn streaming_chunks_reassemble_to_the_byte_compatible_wav() {
    for frames in [1, 65_535, 65_536, 65_537, 131_072] {
        let audio = audio(frames);
        let expected = encode_pcm24_wav(&audio).unwrap();
        let mut actual = wav_pcm24_header(frames).unwrap().to_vec();
        for offset in (0..frames).step_by(PCM24_CHUNK_FRAMES) {
            let chunk_frames = (frames - offset).min(PCM24_CHUNK_FRAMES);
            actual.extend(encode_pcm24_chunk(&audio, offset, chunk_frames).unwrap());
        }
        assert_eq!(actual, expected, "frame count {frames}");
    }
}

#[test]
fn header_is_extensible_pcm24_and_data_size_is_checked() {
    let header = wav_pcm24_header(1).unwrap();
    assert_eq!(header.len(), 68);
    assert_eq!(&header[..4], b"RIFF");
    assert_eq!(&header[8..12], b"WAVE");
    assert_eq!(&header[12..16], b"fmt ");
    assert_eq!(u32::from_le_bytes(header[16..20].try_into().unwrap()), 40);
    assert_eq!(
        u16::from_le_bytes(header[20..22].try_into().unwrap()),
        0xfffe
    );
    assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 2);
    assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 24);
    assert_eq!(&header[60..64], b"data");
    assert!(wav_pcm24_header(usize::try_from(u32::MAX).unwrap() / 6 + 1).is_err());
}

#[test]
fn streaming_encoder_stops_when_its_sink_fails() {
    let audio = audio(PCM24_CHUNK_FRAMES + 1);
    let mut calls = 0;
    let error = encode_pcm24_wav_to_sink(&audio, |_| {
        calls += 1;
        if calls == 2 {
            return Err(convolve_core::ConvolveCoreError::ProcessingFailed {
                message: "sink failed".to_owned(),
            });
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error.code(), "PROCESSING_FAILED");
    assert_eq!(calls, 2);
}

#[test]
fn generated_wav_still_decodes_as_pcm24() {
    let bytes = encode_pcm24_wav(&audio(1)).unwrap();
    let reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
    assert_eq!(reader.spec().bits_per_sample, 24);
}
