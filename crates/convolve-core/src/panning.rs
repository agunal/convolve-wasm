use std::f32::consts::PI;

use crate::{BeatGrid, ConvolveCoreError, StereoAudio};

pub fn apply_beat_pan(
    audio: &mut StereoAudio,
    grid: &BeatGrid,
    transition_samples: usize,
) -> Result<usize, ConvolveCoreError> {
    if grid.period_samples == 0 {
        return Err(ConvolveCoreError::invalid(
            "beat period must be greater than zero",
        ));
    }

    let beats = grid.samples_until(audio.frames());
    let transition_samples = transition_samples.min(grid.period_samples / 2);
    let half_before = transition_samples / 2;
    let half_after = transition_samples.saturating_sub(half_before);

    let mut pan = vec![-1.0_f32; audio.frames()];
    let mut current_side = -1.0_f32;
    let mut cursor = 0_usize;

    for (beat_index, beat) in beats.iter().copied().enumerate() {
        let target_side = if beat_index % 2 == 0 { -1.0 } else { 1.0 };
        if target_side == current_side {
            continue;
        }

        if transition_samples == 0 {
            pan[cursor..beat].fill(current_side);
            cursor = beat;
            current_side = target_side;
            continue;
        }

        let start = beat.saturating_sub(half_before).max(cursor);
        let end = beat.saturating_add(half_after).min(audio.frames());
        pan[cursor..start].fill(current_side);

        for (offset, value) in pan[start..end].iter_mut().enumerate() {
            let progress = offset as f32 / transition_samples as f32;
            let blend = 0.5 - 0.5 * (PI * progress).cos();
            *value = current_side + (target_side - current_side) * blend;
        }
        cursor = end;
        current_side = target_side;
    }
    pan[cursor..].fill(current_side);

    for ((left, right), pan) in audio.left.iter_mut().zip(&mut audio.right).zip(pan) {
        let mono = 0.5 * (*left + *right);
        let theta = (pan + 1.0) * (PI / 4.0);
        *left = mono * theta.cos();
        *right = mono * theta.sin();
    }

    Ok(beats.len())
}
