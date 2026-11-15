//! Keeps `ui/src/generated/proto.ts` in step with the Rust types. CI runs this
//! as its own step so a stale file fails with a clear name.

use std::path::Path;

#[test]
fn generated_typescript_is_current() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let path = root.join(delulu_proto::ts::OUTPUT);
    let expected = delulu_proto::ts::typescript();
    if std::env::var_os("UPDATE_GENERATED").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &expected).unwrap();
        return;
    }
    let actual = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        actual == expected,
        "{} is stale; run `UPDATE_GENERATED=1 cargo test -p delulu-proto --test generated` and commit it",
        delulu_proto::ts::OUTPUT
    );
}
