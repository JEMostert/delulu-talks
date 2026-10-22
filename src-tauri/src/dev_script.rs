//! Development-only startup driver. `DELULU_DEV_SCRIPT` holds a JSON list of
//! steps that run through the same router the renderer uses, so setup and
//! dictation can be exercised without clicking:
//!
//! ```text
//! DELULU_DEV_SCRIPT='[["settings:update",[{"autoPaste":false}]],{"sleep":2000},["dictation:toggle",[]]]'
//! ```
//!
//! A step is `[channel, args]`, `{"sleep": ms}`, `{"until": [channel, args], "path": "/phase", "equals": "idle", "timeoutMs": 600000}`
//! (polls every second), or `"quit"`. Each result is printed as `DEV <channel> <envelope>`.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::state::AppState;

pub fn spawn(state: Arc<AppState>) {
    let Ok(script) = std::env::var("DELULU_DEV_SCRIPT") else { return };
    let steps: Vec<Value> = match serde_json::from_str(&script) {
        Ok(steps) => steps,
        Err(error) => {
            eprintln!("DEV invalid DELULU_DEV_SCRIPT: {error}");
            return;
        }
    };
    tauri::async_runtime::spawn(async move {
        for step in steps {
            match &step {
                Value::String(word) if word == "quit" => {
                    println!("DEV quit");
                    state.app.exit(0);
                    return;
                }
                Value::Object(object) if object.contains_key("sleep") => {
                    let ms = object["sleep"].as_u64().unwrap_or(0);
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                Value::Object(object) if object.contains_key("until") => {
                    let call = &object["until"];
                    let path = object.get("path").and_then(Value::as_str).unwrap_or("");
                    let expected = object.get("equals").cloned().unwrap_or(Value::Null);
                    let timeout = Duration::from_millis(object.get("timeoutMs").and_then(Value::as_u64).unwrap_or(600_000));
                    let started = Instant::now();
                    loop {
                        let result = invoke(&state, call).await;
                        let actual = result.pointer(&format!("/value{path}")).cloned().unwrap_or(Value::Null);
                        if actual == expected {
                            println!("DEV until {path} == {expected} after {}s", started.elapsed().as_secs());
                            break;
                        }
                        if started.elapsed() > timeout {
                            println!("DEV until timed out; last {}", result);
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                }
                call @ Value::Array(_) => {
                    let result = invoke(&state, call).await;
                    println!("DEV {} {}", call[0].as_str().unwrap_or("?"), result);
                }
                other => eprintln!("DEV unknown step {other}"),
            }
        }
    });
}

async fn invoke(state: &Arc<AppState>, call: &Value) -> Value {
    let channel = call[0].as_str().unwrap_or_default().to_owned();
    let args = call.get(1).and_then(Value::as_array).cloned().unwrap_or_default();
    let router = Arc::clone(&state.router);
    let envelope = router.invoke(Arc::clone(state), true, &channel, args).await;
    serde_json::to_value(envelope).unwrap_or(Value::Null)
}
