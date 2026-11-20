// Disposable signed bundle, version 9.1.0. The fixture private key was discarded.
use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri_plugin_updater::UpdaterExt;

#[test]
fn a_signed_update_is_bound_to_its_contents_and_announced_version() {
    let bytes = include_bytes!("fixtures/update/fixture.app.tar.gz");
    let signature = include_str!("fixtures/update/fixture.app.tar.gz.sig").trim();
    let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let mut plugin = config["plugins"]["updater"].clone();
    assert_eq!(plugin["requireSignedVersion"], true);
    plugin["pubkey"] = json!(include_str!("fixtures/update/test.pub").trim());
    let mut context = mock_context(noop_assets());
    context
        .config_mut()
        .plugins
        .0
        .insert("updater".into(), plugin);
    let app = mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let temp = tempfile::tempdir().unwrap();
    let exe = temp.path().join("Fixture.app/Contents/MacOS/fixture");
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    std::fs::write(&exe, "old").unwrap();
    let updater = app.updater_builder().executable_path(&exe).build().unwrap();
    let release = |version| json!({"version":version, "url":"https://example.org/fixture.app.tar.gz", "signature":signature});
    let update = updater.restore_update(release("9.1.0")).unwrap().unwrap();
    assert!(update.verify(bytes).is_ok());
    assert!(update.install(b"tampered").is_err());
    let forged = updater.restore_update(release("9.2.0")).unwrap().unwrap();
    assert!(forged.install(bytes).is_err());
    assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old");
    #[cfg(target_os = "macos")]
    {
        update.install(bytes).unwrap();
        assert_eq!(std::fs::read_to_string(exe).unwrap().trim(), "updated");
    }
}
