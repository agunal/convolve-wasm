use crate::StereoAudio;

#[must_use]
pub fn append_reverse(audio: &StereoAudio, crossfade_samples: usize) -> StereoAudio {
    let frames = audio.frames();
    let fade = crossfade_samples.min(frames.saturating_sub(1));

    StereoAudio {
        sample_rate: audio.sample_rate,
        left: append_channel(&audio.left, fade),
        right: append_channel(&audio.right, fade),
    }
}

fn append_channel(original: &[f32], fade: usize) -> Vec<f32> {
    let frames = original.len();
    let reversed: Vec<f32> = original.iter().copied().rev().collect();
    let mut output = Vec::with_capacity(2 * frames - fade);
    output.extend_from_slice(&original[..frames - fade]);

    let mut overlap = vec![0.0_f32; fade];
    for index in 0..fade.div_ceil(2) {
        let mirrored = fade - 1 - index;
        let t = (index + 1) as f32 / (fade + 1) as f32;
        let forward = original[frames - fade + index];
        let backward = reversed[index];
        let sample = forward * (1.0 - t) + backward * t;
        overlap[index] = sample;
        overlap[mirrored] = sample;
    }
    output.extend_from_slice(&overlap);
    output.extend_from_slice(&reversed[fade..]);
    output
}
