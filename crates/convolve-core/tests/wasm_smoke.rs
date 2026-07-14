#![cfg(target_arch = "wasm32")]

use std::{cell::RefCell, rc::Rc};

use convolve_core::{ProcessOptions, process_audio_wasm};
use js_sys::{Function, Reflect};
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn generated_wasm_processes_an_impulse_and_reports_progress() {
    let stages = Rc::new(RefCell::new(Vec::<String>::new()));
    let captured = Rc::clone(&stages);
    let callback = Closure::<dyn FnMut(String, f64)>::new(move |stage, fraction| {
        assert!((0.0..=1.0).contains(&fraction));
        captured.borrow_mut().push(stage);
    });

    let options = serde_wasm_bindgen::to_value(&ProcessOptions::default()).unwrap();
    let result = process_audio_wasm(
        vec![1.0_f32].into_boxed_slice(),
        vec![1.0_f32].into_boxed_slice(),
        vec![1.0_f32].into_boxed_slice(),
        vec![1.0_f32].into_boxed_slice(),
        false,
        options,
        Some(callback.as_ref().unchecked_ref::<Function>().clone()),
    )
    .unwrap();

    assert!(result.wav_bytes().to_vec().starts_with(b"RIFF"));
    assert_eq!(result.sample_rate(), 48_000);
    assert_eq!(result.output_frames(), 1);
    assert_eq!(
        stages.borrow().as_slice(),
        ["validate", "convolve", "normalize", "encode", "done"]
    );
}

#[wasm_bindgen_test]
fn generated_wasm_returns_structured_errors() {
    let error = match process_audio_wasm(
        vec![1.0_f32].into_boxed_slice(),
        vec![1.0_f32, 2.0].into_boxed_slice(),
        vec![1.0_f32].into_boxed_slice(),
        vec![1.0_f32].into_boxed_slice(),
        false,
        JsValue::UNDEFINED,
        None,
    ) {
        Ok(_) => panic!("mismatched channel lengths should fail"),
        Err(error) => error,
    };
    assert_eq!(
        Reflect::get(&error, &JsValue::from_str("code"))
            .unwrap()
            .as_string()
            .as_deref(),
        Some("INVALID_INPUT"),
    );
    assert!(Reflect::has(&error, &JsValue::from_str("details")).unwrap());
}
