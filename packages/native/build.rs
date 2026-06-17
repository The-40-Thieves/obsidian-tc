// Emits platform-specific napi link configuration. On macOS this adds
// `-undefined dynamic_lookup` so the `napi_*` symbols (provided by the Node
// host at load time) resolve; without it, macOS linking fails. napi-build is
// declared in [build-dependencies] but only runs when this build script exists.
fn main() {
    napi_build::setup();
}
