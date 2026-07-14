use std::mem::size_of;

use crate::ConvolveCoreError;

pub const MAX_BYTES: usize = 268_435_456;
const FIXED_HEADROOM_BYTES: usize = 16 * 1024 * 1024;

pub fn convolution_frames(a_frames: usize, b_frames: usize) -> Result<usize, ConvolveCoreError> {
    if a_frames == 0 || b_frames == 0 {
        return Err(ConvolveCoreError::invalid(
            "convolution inputs must not be empty",
        ));
    }
    a_frames
        .checked_add(b_frames)
        .and_then(|sum| sum.checked_sub(1))
        .ok_or_else(overflow)
}

pub fn estimate_peak_bytes(
    a_frames: usize,
    b_frames: usize,
    append_reverse: bool,
    crossfade_frames: usize,
) -> Result<usize, ConvolveCoreError> {
    let output_frames = convolution_frames(a_frames, b_frames)?;
    let fft_len = output_frames
        .checked_next_power_of_two()
        .ok_or_else(overflow)?;

    let input_frames = a_frames.checked_add(b_frames).ok_or_else(overflow)?;
    let input_bytes = bytes_for_stereo(input_frames)?;
    let forward_output_bytes = bytes_for_stereo(output_frames)?;

    let final_frames = if append_reverse {
        output_frames
            .checked_mul(2)
            .and_then(|frames| frames.checked_sub(crossfade_frames))
            .ok_or_else(overflow)?
    } else {
        output_frames
    };
    let final_output_bytes = bytes_for_stereo(final_frames)?;
    let fft_working_bytes = fft_len.checked_mul(24).ok_or_else(overflow)?;

    let estimated = input_bytes
        .checked_add(forward_output_bytes)
        .and_then(|total| total.checked_add(final_output_bytes))
        .and_then(|total| total.checked_add(fft_working_bytes))
        .and_then(|total| total.checked_add(FIXED_HEADROOM_BYTES))
        .ok_or_else(overflow)?;

    if estimated > MAX_BYTES {
        return Err(ConvolveCoreError::InputTooLarge {
            estimated,
            limit: MAX_BYTES,
        });
    }
    Ok(estimated)
}

fn bytes_for_stereo(frames: usize) -> Result<usize, ConvolveCoreError> {
    frames
        .checked_mul(2)
        .and_then(|samples| samples.checked_mul(size_of::<f32>()))
        .ok_or_else(overflow)
}

fn overflow() -> ConvolveCoreError {
    ConvolveCoreError::InputTooLarge {
        estimated: usize::MAX,
        limit: MAX_BYTES,
    }
}
