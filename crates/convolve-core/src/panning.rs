use std::f32::consts::PI;

use crate::{BeatGrid, ConvolveCoreError, StereoAudio};

pub fn apply_beat_pan(
    audio: &mut StereoAudio,
    grid: &BeatGrid,
    transition_samples: usize,
) -> Result<usize, ConvolveCoreError> {
    pan_for_each_frame(grid, audio.frames(), transition_samples, |index, pan| {
        let mono = 0.5 * (audio.left[index] + audio.right[index]);
        let theta = (pan + 1.0) * (PI / 4.0);
        audio.left[index] = mono * theta.cos();
        audio.right[index] = mono * theta.sin();
    })
}

fn pan_for_each_frame<F>(
    grid: &BeatGrid,
    frames: usize,
    requested_transition_samples: usize,
    mut apply: F,
) -> Result<usize, ConvolveCoreError>
where
    F: FnMut(usize, f32),
{
    if grid.period_samples == 0 {
        return Err(ConvolveCoreError::invalid(
            "beat period must be greater than zero",
        ));
    }

    let transition_samples = requested_transition_samples.min(grid.period_samples / 2);
    let half_before = transition_samples / 2;
    let half_after = transition_samples.saturating_sub(half_before);
    let mut current_side = -1.0_f32;
    let mut cursor = 0_usize;
    let mut beats = 0_usize;
    let mut beat = grid.anchor_sample;

    while beat < frames {
        let target_side = if beats.is_multiple_of(2) { -1.0 } else { 1.0 };
        if target_side != current_side {
            if transition_samples == 0 {
                apply_constant(cursor, beat, current_side, &mut apply);
                cursor = beat;
                current_side = target_side;
            } else {
                let start = beat.saturating_sub(half_before).max(cursor);
                let end = beat.saturating_add(half_after).min(frames);
                apply_constant(cursor, start, current_side, &mut apply);
                for (offset, index) in (start..end).enumerate() {
                    let progress = offset as f32 / transition_samples as f32;
                    let blend = 0.5 - 0.5 * (PI * progress).cos();
                    apply(index, current_side + (target_side - current_side) * blend);
                }
                cursor = end;
                current_side = target_side;
            }
        }

        beats += 1;
        let Some(next) = beat.checked_add(grid.period_samples) else {
            break;
        };
        beat = next;
    }

    apply_constant(cursor, frames, current_side, &mut apply);
    Ok(beats)
}

fn apply_constant<F>(start: usize, end: usize, value: f32, apply: &mut F)
where
    F: FnMut(usize, f32),
{
    for index in start..end {
        apply(index, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(anchor_sample: usize, period_samples: usize) -> BeatGrid {
        BeatGrid {
            anchor_sample,
            period_samples,
            bpm: 120.0,
            confidence: 1.0,
        }
    }

    fn reference(grid: &BeatGrid, frames: usize, requested_transition: usize) -> Vec<f32> {
        let beats = grid.samples_until(frames);
        let transition = requested_transition.min(grid.period_samples / 2);
        let half_before = transition / 2;
        let half_after = transition.saturating_sub(half_before);
        let mut pan = vec![-1.0_f32; frames];
        let mut current = -1.0_f32;
        let mut cursor = 0;
        for (beat_index, beat) in beats.into_iter().enumerate() {
            let target = if beat_index % 2 == 0 { -1.0 } else { 1.0 };
            if target == current {
                continue;
            }
            if transition == 0 {
                pan[cursor..beat].fill(current);
                cursor = beat;
                current = target;
                continue;
            }
            let start = beat.saturating_sub(half_before).max(cursor);
            let end = beat.saturating_add(half_after).min(frames);
            pan[cursor..start].fill(current);
            for (offset, value) in pan[start..end].iter_mut().enumerate() {
                let progress = offset as f32 / transition as f32;
                let blend = 0.5 - 0.5 * (PI * progress).cos();
                *value = current + (target - current) * blend;
            }
            cursor = end;
            current = target;
        }
        pan[cursor..].fill(current);
        pan
    }

    #[test]
    fn incremental_ranges_match_the_legacy_pan_bits_at_all_boundaries() {
        for (grid, frames, transition) in [
            (grid(0, 10), 1, 0),
            (grid(0, 10), 37, 1),
            (grid(3, 10), 37, 2),
            (grid(3, 10), 37, 3),
            (grid(0, 10), 37, 99),
            (grid(8, 10), 27, 5),
            (grid(0, 9), 32, 4),
        ] {
            let mut actual = vec![0.0_f32; frames];
            pan_for_each_frame(&grid, frames, transition, |index, pan| actual[index] = pan)
                .unwrap();
            assert_eq!(
                actual
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                reference(&grid, frames, transition)
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                "anchor={} period={}",
                grid.anchor_sample,
                grid.period_samples,
            );
        }
    }
}
