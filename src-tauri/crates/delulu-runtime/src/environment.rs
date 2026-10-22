//! Child environment for runtime commands and workers (`environment.ts`).
//! Package/import and generated-code ownership is independent of version
//! pins. Model weights stay shared to preserve existing downloads.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::Path;

use crate::inventory::RuntimeKind;

/// A complete child environment (the inherited one is not merged in again).
pub type ChildEnv = BTreeMap<OsString, OsString>;

fn removed(key: &OsStr) -> bool {
    let key = key.to_string_lossy().to_ascii_uppercase();
    key.starts_with("PYTHON")
        || key.starts_with("PIP_")
        || matches!(key.as_str(), "VIRTUAL_ENV" | "__PYVENV_LAUNCHER__" | "CONDA_PREFIX")
}

fn is_path_key(key: &OsStr) -> bool {
    if cfg!(windows) {
        key.to_string_lossy().eq_ignore_ascii_case("PATH")
    } else {
        key == "PATH"
    }
}

/// `inherited` is normally `std::env::vars_os()`. `bin` is prepended to PATH.
pub fn runtime_environment(
    kind: RuntimeKind,
    data_directory: &Path,
    model_cache: &Path,
    bin: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> ChildEnv {
    let mut env = ChildEnv::new();
    let mut inherited_path = OsString::new();
    for (key, value) in inherited {
        if is_path_key(&key) {
            inherited_path = value;
        } else if !removed(&key) {
            env.insert(key, value);
        }
    }
    let generated = data_directory.join("runtime-cache").join(kind.as_str());
    let mut set = |key: &str, value: OsString| {
        env.insert(OsString::from(key), value);
    };
    set("DELULU_RUNTIME_KIND", kind.as_str().into());
    set("PYTHONNOUSERSITE", "1".into());
    set("PYTHONUNBUFFERED", "1".into());
    set("PYTHONIOENCODING", "utf-8".into());
    set("PYTHONPYCACHEPREFIX", generated.join("python").into());
    // Ignore pip's user/global configuration as well as inherited target/prefix.
    set("PIP_CONFIG_FILE", if cfg!(windows) { "NUL" } else { "/dev/null" }.into());
    set("HF_HOME", model_cache.into());
    set("HF_HUB_CACHE", model_cache.join("hub").into());
    set("HUGGINGFACE_HUB_CACHE", model_cache.join("hub").into());
    set("HF_MODULES_CACHE", generated.join("hf-modules").into());
    set("TORCH_HOME", generated.join("torch").into());
    set("TORCH_EXTENSIONS_DIR", generated.join("torch-extensions").into());
    set("TRITON_CACHE_DIR", generated.join("triton").into());
    let mut path = OsString::from(bin);
    path.push(if cfg!(windows) { ";" } else { ":" });
    path.push(inherited_path);
    set("PATH", path);
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_and_pip_overrides_are_removed_and_caches_are_role_scoped() {
        let inherited = [("PYTHONPATH", "/evil"), ("pip_target", "/x"), ("VIRTUAL_ENV", "/v"), ("HOME", "/h"), ("PATH", "/usr/bin")]
            .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let env = runtime_environment(RuntimeKind::Magic, Path::new("/d"), Path::new("/d/models"), Path::new("/venv/bin"), inherited);
        let get = |key: &str| env.get(OsStr::new(key)).map(|v| v.to_string_lossy().into_owned());
        assert_eq!(get("PYTHONPATH"), None);
        assert_eq!(get("pip_target"), None);
        assert_eq!(get("VIRTUAL_ENV"), None);
        assert_eq!(get("HOME").as_deref(), Some("/h"));
        assert_eq!(get("TORCH_HOME").as_deref(), Some("/d/runtime-cache/magic/torch"));
        assert_eq!(get("HF_HUB_CACHE").as_deref(), Some("/d/models/hub"));
        #[cfg(unix)]
        assert_eq!(get("PATH").as_deref(), Some("/venv/bin:/usr/bin"));
    }
}
