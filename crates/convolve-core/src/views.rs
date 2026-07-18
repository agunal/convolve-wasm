use crate::StereoAudio;

pub(crate) trait StereoSampleView {
    fn frames(&self) -> usize;
    fn left(&self, index: usize) -> f32;
    fn right(&self, index: usize) -> f32;
}

impl<T: StereoSampleView + ?Sized> StereoSampleView for &T {
    fn frames(&self) -> usize {
        (**self).frames()
    }
    fn left(&self, index: usize) -> f32 {
        (**self).left(index)
    }
    fn right(&self, index: usize) -> f32 {
        (**self).right(index)
    }
}
pub(crate) struct ForwardView<'a> {
    audio: &'a StereoAudio,
}

impl<'a> ForwardView<'a> {
    pub(crate) const fn new(audio: &'a StereoAudio) -> Self {
        Self { audio }
    }
}

impl StereoSampleView for ForwardView<'_> {
    fn frames(&self) -> usize {
        self.audio.frames()
    }

    fn left(&self, index: usize) -> f32 {
        self.audio.left[index]
    }

    fn right(&self, index: usize) -> f32 {
        self.audio.right[index]
    }
}

pub(crate) struct PalindromeView<V> {
    forward: V,
    fade: usize,
    frames: usize,
}

impl<V: StereoSampleView> PalindromeView<V> {
    pub(crate) fn new(forward: V, requested_fade: usize) -> Self {
        let forward_frames = forward.frames();
        let fade = requested_fade.min(forward_frames.saturating_sub(1));
        Self {
            forward,
            fade,
            frames: 2 * forward_frames - fade,
        }
    }

    fn sample(&self, index: usize, channel: impl Fn(&V, usize) -> f32) -> f32 {
        let forward_frames = self.forward.frames();
        if index < forward_frames - self.fade {
            return channel(&self.forward, index);
        }
        if index < forward_frames {
            let overlap_index = index - (forward_frames - self.fade);
            let mirror = overlap_index.min(self.fade - 1 - overlap_index);
            let t = (mirror + 1) as f32 / (self.fade + 1) as f32;
            let forward = channel(&self.forward, forward_frames - self.fade + mirror);
            let backward = channel(&self.forward, forward_frames - 1 - mirror);
            return forward * (1.0 - t) + backward * t;
        }
        channel(&self.forward, self.frames - 1 - index)
    }
}

impl<V: StereoSampleView> StereoSampleView for PalindromeView<V> {
    fn frames(&self) -> usize {
        self.frames
    }

    fn left(&self, index: usize) -> f32 {
        self.sample(index, StereoSampleView::left)
    }

    fn right(&self, index: usize) -> f32 {
        self.sample(index, StereoSampleView::right)
    }
}

pub(crate) struct GainView<V> {
    source: V,
    gain: f32,
}

impl<V> GainView<V> {
    pub(crate) const fn new(source: V, gain: f32) -> Self {
        Self { source, gain }
    }
}

impl<V: StereoSampleView> StereoSampleView for GainView<V> {
    fn frames(&self) -> usize {
        self.source.frames()
    }

    fn left(&self, index: usize) -> f32 {
        self.source.left(index) * self.gain
    }

    fn right(&self, index: usize) -> f32 {
        self.source.right(index) * self.gain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SAMPLE_RATE, append_reverse};

    fn collect<V: StereoSampleView>(view: &V) -> (Vec<f32>, Vec<f32>) {
        (
            (0..view.frames()).map(|index| view.left(index)).collect(),
            (0..view.frames()).map(|index| view.right(index)).collect(),
        )
    }

    #[test]
    fn palindrome_view_matches_materialized_reverse_bits_for_edge_fades() {
        for frames in 1..=8 {
            let audio = StereoAudio::new(
                SAMPLE_RATE,
                (0..frames).map(|index| index as f32 * 0.13 - 0.4).collect(),
                (0..frames)
                    .map(|index| index as f32 * -0.17 + 0.3)
                    .collect(),
            )
            .unwrap();
            for fade in [0, 1, 2, 3, frames + 7] {
                let expected = append_reverse(&audio, fade);
                let actual = PalindromeView::new(ForwardView::new(&audio), fade);
                let (left, right) = collect(&actual);
                assert_eq!(
                    left.iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                    expected
                        .left
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    right
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                    expected
                        .right
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>()
                );
            }
        }
    }
}
