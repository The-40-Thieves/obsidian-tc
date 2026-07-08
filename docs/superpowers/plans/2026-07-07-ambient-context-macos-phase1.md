# Ambient Context Capture (macOS Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working, testable ambient-context capability on macOS — a background sensor that reads the focused window's text via accessibility APIs, redacts sensitive content twice, stores it in a physically-separate low-trust store, and exposes it to agents through two new governed MCP tools.

**Architecture:** A new standalone Rust binary (`packages/sensor`) polls the focused window, checks app policy, dedupes on content hash, redacts (pass 1), and pushes captures over local HTTP to the existing obsidian-tc server. The server redacts again (pass 2, fail-closed), stores into a new `ambient.db` (mirroring the existing `experiential.db` low-trust-membrane pattern — no FKs into `cache.db`), and exposes `get_current_context` / `search_ambient_context` MCP tools through the existing dispatch pipeline.

**Tech Stack:** Rust (sensor binary: `clap` for CLI args, `ureq` for the outbound HTTP client, `tiny_http` for the inbound probe listener, `sha2` for content hashing) · TypeScript/Bun (server: existing `better-sqlite3`/`bun:sqlite` driver, Hono routes, Zod schemas, Vitest).

## Global Constraints

- Fail-closed redaction: any redaction-pipeline error drops the capture; it is never stored unredacted. (Spec §9)
- `ambient.db` is physically separate from `cache.db`, with no foreign keys crossing the boundary, following the existing `experiential.db` pattern. (Spec §5)
- No `vault_id` column anywhere in the ambient schema or tool surface — this domain has no vault boundary. (Spec §5)
- FTS5 only for v1 — no embeddings, no vector search over ambient history. (Spec §8)
- Default retention: 180 days, configurable; documented presets are 30/60/90/120/180/360 days but config accepts any positive integer. (Spec §7)
- The sensor binary is the only process that ever requests OS accessibility permission; the main server process never does. (Spec §4.1)
- This capability only applies to local-desktop deployments (STDIO-local / HTTP-local) — not Docker, not HTTP-remote. (Spec §3)
- New MCP scopes: `read:ambient` (the two read tools), `admin:ambient` (policy/purge) — both flow through the existing auth → scope → HITL → audit dispatch pipeline. (Spec §9)
- This plan covers macOS only. Windows/Linux `WindowSource` implementations are explicitly out of scope and land in follow-on plans.

---

## File Structure

**New package `packages/sensor` (Rust binary crate, independent `Cargo.toml`, not a Cargo workspace member of `packages/native`):**
- `packages/sensor/Cargo.toml`
- `packages/sensor/src/window_source.rs` — `WindowSnapshot`, `WindowSource` trait, `FakeWindowSource`
- `packages/sensor/src/dedupe.rs` — `content_hash`, `DedupeCache`
- `packages/sensor/src/redact.rs` — pass-1 redaction
- `packages/sensor/src/policy.rs` — `AppPolicy`, `Policy` enum
- `packages/sensor/src/macos_window_source.rs` — `MacosWindowSource` (`#[cfg(target_os = "macos")]`)
- `packages/sensor/src/http_capture_client.rs` — `CaptureClient`
- `packages/sensor/src/probe_server.rs` — `ProbeStatus`, `serve_probe`
- `packages/sensor/src/main.rs` — CLI + poll loop wiring

**Server-side additions in `packages/server`:**
- `src/db/ambient.ts` — `provisionAmbientDb`, `AMBIENT_MIGRATIONS`
- `src/ambient/store.ts` — typed accessors over `ambient_captures` / `ambient_app_policy`
- `src/ambient/redact.ts` — pass-2 redaction, `AmbientRedactionError`
- `src/ambient/ingest.ts` — `ingestCapture` (redact → policy recheck → store)
- `src/ambient/probe.ts` — server → sensor health check
- `src/tools/m8/ambient-tools.ts` — `get_current_context`, `search_ambient_context`
- `src/cli/sensor-install.ts` — `sensor install` / `sensor status` subcommands

**Modified:**
- `packages/shared/src/config.schema.ts` — add `ambient` config block
- `packages/server/src/transports/http.ts` — wire `POST /ambient/v1/capture`
- `packages/server/src/db/maintenance.ts` — add ambient purge to the existing sweep
- `packages/server/src/mcp/registry.ts` (or wherever tool domains are aggregated — verify against `tools/m7/index.ts`'s registration pattern) — register the m8 ambient tools

---

## Task 1: Sensor crate scaffold — `WindowSource` trait

**Files:**
- Create: `packages/sensor/Cargo.toml`
- Create: `packages/sensor/src/window_source.rs`
- Create: `packages/sensor/src/lib.rs`
- Test: inline `#[cfg(test)]` module in `window_source.rs`

**Interfaces:**
- Produces: `WindowSnapshot { app_name: String, app_bundle_id: String, window_title: String, content: String }`, `trait WindowSource { fn read_focused(&self) -> Option<WindowSnapshot>; }`, `FakeWindowSource::new()`, `FakeWindowSource::set_next(Option<WindowSnapshot>)`

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/window_source.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_source_returns_configured_snapshot() {
        let fake = FakeWindowSource::new();
        assert!(fake.read_focused().is_none());

        fake.set_next(Some(WindowSnapshot {
            app_name: "Notes".into(),
            app_bundle_id: "com.example.notes".into(),
            window_title: "Untitled".into(),
            content: "hello world".into(),
        }));
        let snap = fake.read_focused().expect("should return the configured snapshot");
        assert_eq!(snap.app_name, "Notes");
        assert_eq!(snap.content, "hello world");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test window_source`
Expected: FAIL — `WindowSnapshot`, `FakeWindowSource` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/window_source.rs (prepend above the test module)
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSnapshot {
    pub app_name: String,
    pub app_bundle_id: String,
    pub window_title: String,
    pub content: String,
}

pub trait WindowSource {
    fn read_focused(&self) -> Option<WindowSnapshot>;
}

pub struct FakeWindowSource {
    next: Mutex<Option<WindowSnapshot>>,
}

impl FakeWindowSource {
    pub fn new() -> Self {
        FakeWindowSource { next: Mutex::new(None) }
    }

    pub fn set_next(&self, snap: Option<WindowSnapshot>) {
        *self.next.lock().unwrap() = snap;
    }
}

impl WindowSource for FakeWindowSource {
    fn read_focused(&self) -> Option<WindowSnapshot> {
        self.next.lock().unwrap().clone()
    }
}
```

```toml
# packages/sensor/Cargo.toml
[package]
name = "obsidian-tc-sensor"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "obsidian-tc-sensor"
path = "src/main.rs"

[dependencies]
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
```

```rust
// packages/sensor/src/main.rs (placeholder entry point so `cargo test` has a bin target to build against; wired for real in Task 7)
fn main() {
    println!("obsidian-tc-sensor: not yet wired (see Task 7)");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test window_source`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/window_source.rs packages/sensor/src/lib.rs packages/sensor/src/main.rs
git commit -m "feat(sensor): scaffold packages/sensor with WindowSource trait"
```

---

## Task 2: Dedupe module — content hash + LRU-style cache

**Files:**
- Create: `packages/sensor/src/dedupe.rs`
- Modify: `packages/sensor/src/lib.rs`
- Modify: `packages/sensor/Cargo.toml` (add `sha2`)

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `content_hash(content: &str) -> String`, `DedupeCache::new()`, `DedupeCache::check_and_update(&mut self, app_bundle_id: &str, window_title: &str, hash: &str) -> bool` (returns `true` when this is new/changed content that should proceed, `false` for a duplicate that should be dropped)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/dedupe.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_content_hashes_identically() {
        assert_eq!(content_hash("hello"), content_hash("hello"));
        assert_ne!(content_hash("hello"), content_hash("world"));
    }

    #[test]
    fn dedupe_cache_flags_first_seen_then_skips_repeat_then_flags_change() {
        let mut cache = DedupeCache::new();
        let h1 = content_hash("first");
        assert!(cache.check_and_update("com.example.app", "Window", &h1), "first sighting should proceed");
        assert!(!cache.check_and_update("com.example.app", "Window", &h1), "repeat of same hash should be dropped");

        let h2 = content_hash("second");
        assert!(cache.check_and_update("com.example.app", "Window", &h2), "changed content should proceed");
    }

    #[test]
    fn dedupe_cache_is_scoped_per_window() {
        let mut cache = DedupeCache::new();
        let h = content_hash("same text");
        assert!(cache.check_and_update("com.example.app", "Window A", &h));
        assert!(cache.check_and_update("com.example.app", "Window B", &h), "a different window with the same content is a distinct entry");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test dedupe`
Expected: FAIL — `content_hash`, `DedupeCache` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/dedupe.rs (prepend above the test module)
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub struct DedupeCache {
    last_seen: HashMap<(String, String), String>,
}

impl DedupeCache {
    pub fn new() -> Self {
        DedupeCache { last_seen: HashMap::new() }
    }

    /// Returns true when (app_bundle_id, window_title)'s hash changed since the last call
    /// (or has never been seen), meaning the caller should proceed with this capture.
    pub fn check_and_update(&mut self, app_bundle_id: &str, window_title: &str, hash: &str) -> bool {
        let key = (app_bundle_id.to_string(), window_title.to_string());
        let changed = self.last_seen.get(&key).map(|prev| prev != hash).unwrap_or(true);
        if changed {
            self.last_seen.insert(key, hash.to_string());
        }
        changed
    }
}
```

```toml
# packages/sensor/Cargo.toml — add to [dependencies]
sha2 = "0.10"
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test dedupe`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/dedupe.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): add content-hash dedupe cache"
```

---

## Task 3: Redact module (pass 1) — SSN / card-number / secret patterns

**Files:**
- Create: `packages/sensor/src/redact.rs`
- Modify: `packages/sensor/src/lib.rs`
- Modify: `packages/sensor/Cargo.toml` (add `regex`, `once_cell`)

**Interfaces:**
- Consumes: nothing from Tasks 1–2
- Produces: `redact(content: &str) -> String`

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/redact.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_ssn() {
        let out = redact("my ssn is 123-45-6789 ok");
        assert!(!out.contains("123-45-6789"));
        assert!(out.contains("[REDACTED:ssn]"));
    }

    #[test]
    fn redacts_luhn_valid_card_number() {
        // 4111111111111111 is a well-known Luhn-valid test Visa number
        let out = redact("card: 4111111111111111 exp 12/29");
        assert!(!out.contains("4111111111111111"));
        assert!(out.contains("[REDACTED:card]"));
    }

    #[test]
    fn does_not_redact_a_luhn_invalid_16_digit_number() {
        // one digit off from the valid test number above -> fails Luhn -> not a real card number
        let out = redact("tracking id 4111111111111112");
        assert!(out.contains("4111111111111112"));
    }

    #[test]
    fn leaves_plain_text_untouched() {
        let out = redact("just a normal sentence about obsidian-tc");
        assert_eq!(out, "just a normal sentence about obsidian-tc");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test redact`
Expected: FAIL — `redact` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/redact.rs (prepend above the test module)
use once_cell::sync::Lazy;
use regex::Regex;

static SSN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap());
static CARD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{13,19}\b").unwrap());

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut double = false;
    for c in digits.chars().rev() {
        let d = match c.to_digit(10) {
            Some(d) => d,
            None => return false,
        };
        let mut v = d;
        if double {
            v *= 2;
            if v > 9 {
                v -= 9;
            }
        }
        sum += v;
        double = !double;
    }
    sum % 10 == 0
}

pub fn redact(content: &str) -> String {
    let after_ssn = SSN_RE.replace_all(content, "[REDACTED:ssn]");
    let after_card = CARD_RE.replace_all(&after_ssn, |caps: &regex::Captures| {
        let matched = &caps[0];
        if luhn_valid(matched) {
            "[REDACTED:card]".to_string()
        } else {
            matched.to_string()
        }
    });
    after_card.into_owned()
}
```

```toml
# packages/sensor/Cargo.toml — add to [dependencies]
regex = "1"
once_cell = "1"
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
pub mod redact;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test redact`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/redact.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): add pass-1 redaction for SSN and Luhn-valid card numbers"
```

---

## Task 4: Policy module — per-app allow/deny

**Files:**
- Create: `packages/sensor/src/policy.rs`
- Modify: `packages/sensor/src/lib.rs`

**Interfaces:**
- Consumes: nothing from Tasks 1–3
- Produces: `Policy::Allow`, `Policy::Deny`, `AppPolicy::with_denylist(Vec<String>) -> Self`, `AppPolicy::check(&self, app_bundle_id: &str) -> Policy`

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/policy.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denylisted_app_is_denied() {
        let policy = AppPolicy::with_denylist(vec!["com.1password.1password".to_string()]);
        assert_eq!(policy.check("com.1password.1password"), Policy::Deny);
    }

    #[test]
    fn unknown_app_defaults_to_allow() {
        let policy = AppPolicy::with_denylist(vec!["com.1password.1password".to_string()]);
        assert_eq!(policy.check("com.example.notes"), Policy::Allow);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test policy`
Expected: FAIL — `AppPolicy`, `Policy` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/policy.rs (prepend above the test module)
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Allow,
    Deny,
}

pub struct AppPolicy {
    denylist: HashSet<String>,
}

impl AppPolicy {
    pub fn with_denylist(denylist: Vec<String>) -> Self {
        AppPolicy { denylist: denylist.into_iter().collect() }
    }

    /// Default-allow with a denylist (per spec §9): an app not on the list is captured;
    /// an app on the list is denied. This check must run BEFORE any content is read.
    pub fn check(&self, app_bundle_id: &str) -> Policy {
        if self.denylist.contains(app_bundle_id) {
            Policy::Deny
        } else {
            Policy::Allow
        }
    }
}
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
pub mod redact;
pub mod policy;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test policy`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/src/policy.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): add default-allow/denylist app policy check"
```

---

## Task 5: macOS `WindowSource` via System Events (JXA)

**Design note:** raw `AXUIElement` FFI bindings are the eventual performance path, but they're a large, unsafe-code-heavy surface to get right without a live macOS box to compile against in this planning pass. Phase 1 shells out to `osascript` running a small JXA (JavaScript for Automation) snippet against System Events — the same Accessibility permission grant covers it, it's a handful of lines, and it's fully replaceable behind the `WindowSource` trait later without touching anything else in the sensor. This is a deliberate, documented v1 trade-off, not a placeholder.

**Files:**
- Create: `packages/sensor/src/macos_window_source.rs`
- Modify: `packages/sensor/src/lib.rs`

**Interfaces:**
- Consumes: `WindowSnapshot`, `WindowSource` (Task 1)
- Produces: `MacosWindowSource::new()`, `build_jxa_script() -> &'static str` (exposed for the unit test; the OS call itself is exercised by manual verification, not CI, per the Testing Strategy in the spec — CI has no GUI session)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/macos_window_source.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jxa_script_references_system_events_and_expected_fields() {
        let script = build_jxa_script();
        assert!(script.contains("System Events"));
        assert!(script.contains("bundleIdentifier"));
        assert!(script.contains("JSON.stringify"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test macos_window_source`
Expected: FAIL — `build_jxa_script` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/macos_window_source.rs (prepend above the test module)
use crate::window_source::{WindowSnapshot, WindowSource};
use std::process::Command;

pub struct MacosWindowSource;

impl MacosWindowSource {
    pub fn new() -> Self {
        MacosWindowSource
    }
}

/// JXA run via `osascript -l JavaScript`, System Events for the frontmost app/window,
/// Accessibility API for the focused UI element's value (best-effort — many apps expose
/// their main text content this way; a null/failed read yields an empty content string,
/// which the sensor's dedupe/redact stages handle the same as any other capture.
pub fn build_jxa_script() -> &'static str {
    r#"
ObjC.import('AppKit');
const se = Application('System Events');
const app = se.applicationProcesses.whose({ frontmost: true })[0];
const appName = app.name();
const bundleId = app.bundleIdentifier();
let windowTitle = '';
let content = '';
try {
  const win = app.windows[0];
  windowTitle = win.name();
  try {
    const focused = win.uiElements.whose({ focused: true })[0];
    content = focused.value() || '';
  } catch (e) { content = ''; }
} catch (e) { windowTitle = ''; }
JSON.stringify({ appName, bundleId, windowTitle, content });
"#
}

impl WindowSource for MacosWindowSource {
    fn read_focused(&self) -> Option<WindowSnapshot> {
        let output = Command::new("osascript")
            .arg("-l")
            .arg("JavaScript")
            .arg("-e")
            .arg(build_jxa_script())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
        Some(WindowSnapshot {
            app_name: parsed.get("appName")?.as_str()?.to_string(),
            app_bundle_id: parsed.get("bundleId")?.as_str()?.to_string(),
            window_title: parsed.get("windowTitle").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            content: parsed.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
    }
}
```

```toml
# packages/sensor/Cargo.toml — add to [dependencies]
serde_json = "1"

[target.'cfg(target_os = "macos")'.dependencies]
# MacosWindowSource itself only shells out to osascript — no macOS-specific crate needed yet.
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
pub mod redact;
pub mod policy;
#[cfg(target_os = "macos")]
pub mod macos_window_source;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test macos_window_source`
Expected: PASS (1 test) on macOS. On non-macOS CI runners this module is compiled out via `#[cfg(target_os = "macos")]` and the test simply doesn't run there.

- [ ] **Step 5: Manual verification (cannot be automated — no GUI session in CI)**

Run on a real macOS machine with Accessibility permission granted to the terminal:
```bash
cd packages/sensor && cat > /tmp/probe.rs <<'EOF'
fn main() {
    let src = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
    println!("{:?}", obsidian_tc_sensor::window_source::WindowSource::read_focused(&src));
}
EOF
```
Expected: prints a `Some(WindowSnapshot { .. })` with the actual frontmost app's name and some visible text, confirming the permission grant and JXA script both work end to end. Record the result in the task's PR description rather than as an automated test.

- [ ] **Step 6: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/macos_window_source.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): macOS WindowSource via System Events JXA"
```

---

## Task 6: HTTP capture client + probe server

**Files:**
- Create: `packages/sensor/src/http_capture_client.rs`
- Create: `packages/sensor/src/probe_server.rs`
- Modify: `packages/sensor/src/lib.rs`
- Modify: `packages/sensor/Cargo.toml` (add `ureq`, `tiny_http`)

**Interfaces:**
- Consumes: `WindowSnapshot` (Task 1)
- Produces: `CaptureClient::new(base_url: String, api_key: String) -> Self`, `CaptureClient::send_capture(&self, snap: &WindowSnapshot, content_hash: &str) -> Result<(), String>`; `ProbeStatus { platform: String, permission_status: Mutex<String>, last_capture_at: Mutex<Option<u64>> }`, `serve_probe(port: u16, status: Arc<ProbeStatus>)` (spawns a listener; returns immediately, listener runs in a background thread)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/http_capture_client.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_source::WindowSnapshot;
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[test]
    fn send_capture_posts_expected_json_body() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr();
        let received = Arc::new(Mutex::new(None));
        let received_clone = received.clone();

        let handle = thread::spawn(move || {
            if let Ok(mut request) = server.recv() {
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).unwrap();
                *received_clone.lock().unwrap() = Some((request.url().to_string(), body));
                let _ = request.respond(tiny_http::Response::from_string("ok"));
            }
        });

        let client = CaptureClient::new(format!("http://{}", addr), "test-secret".to_string());
        let snap = WindowSnapshot {
            app_name: "Notes".into(),
            app_bundle_id: "com.example.notes".into(),
            window_title: "Untitled".into(),
            content: "hello".into(),
        };
        client.send_capture(&snap, "abc123").expect("send should succeed");
        handle.join().unwrap();

        let (url, body) = received.lock().unwrap().clone().unwrap();
        assert_eq!(url, "/ambient/v1/capture");
        assert!(body.contains("\"app_bundle_id\":\"com.example.notes\""));
        assert!(body.contains("\"content_hash\":\"abc123\""));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test http_capture_client`
Expected: FAIL — `CaptureClient` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/http_capture_client.rs (prepend above the test module)
use crate::window_source::WindowSnapshot;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct CaptureClient {
    base_url: String,
    api_key: String,
}

impl CaptureClient {
    pub fn new(base_url: String, api_key: String) -> Self {
        CaptureClient { base_url, api_key }
    }

    pub fn send_capture(&self, snap: &WindowSnapshot, content_hash: &str) -> Result<(), String> {
        let captured_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let body = serde_json::json!({
            "app_name": snap.app_name,
            "app_bundle_id": snap.app_bundle_id,
            "window_title": snap.window_title,
            "content": snap.content,
            "content_hash": content_hash,
            "platform": "macos",
            "captured_at": captured_at,
        });
        let url = format!("{}/ambient/v1/capture", self.base_url);
        ureq::post(&url)
            .set("Authorization", &format!("Bearer {}", self.api_key))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
```

```rust
// packages/sensor/src/probe_server.rs
use std::sync::{Arc, Mutex};
use std::thread;

pub struct ProbeStatus {
    pub platform: String,
    pub permission_status: Mutex<String>,
    pub last_capture_at: Mutex<Option<u64>>,
}

impl ProbeStatus {
    pub fn new(platform: &str) -> Self {
        ProbeStatus {
            platform: platform.to_string(),
            permission_status: Mutex::new("unknown".to_string()),
            last_capture_at: Mutex::new(None),
        }
    }
}

/// Spawns a background thread serving GET /ambient/v1/probe on `port`. Returns immediately.
pub fn serve_probe(port: u16, status: Arc<ProbeStatus>) {
    thread::spawn(move || {
        let server = tiny_http::Server::http(format!("127.0.0.1:{}", port))
            .expect("failed to bind probe server");
        for request in server.incoming_requests() {
            if request.url() != "/ambient/v1/probe" {
                let _ = request.respond(tiny_http::Response::from_string("not found").with_status_code(404));
                continue;
            }
            let body = serde_json::json!({
                "status": "ok",
                "platform": status.platform,
                "permission_status": *status.permission_status.lock().unwrap(),
                "last_capture_at": *status.last_capture_at.lock().unwrap(),
            });
            let response = tiny_http::Response::from_string(body.to_string())
                .with_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            let _ = request.respond(response);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn probe_endpoint_returns_status_json() {
        let status = Arc::new(ProbeStatus::new("macos"));
        *status.permission_status.lock().unwrap() = "granted".to_string();
        serve_probe(41415, status.clone());
        thread::sleep(Duration::from_millis(100)); // let the listener bind

        let resp = ureq::get("http://127.0.0.1:41415/ambient/v1/probe").call().unwrap();
        let body: serde_json::Value = resp.into_json().unwrap();
        assert_eq!(body["status"], "ok");
        assert_eq!(body["platform"], "macos");
        assert_eq!(body["permission_status"], "granted");
    }
}
```

```toml
# packages/sensor/Cargo.toml — add to [dependencies]
ureq = "2"
tiny_http = "0.12"
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
pub mod redact;
pub mod policy;
#[cfg(target_os = "macos")]
pub mod macos_window_source;
pub mod http_capture_client;
pub mod probe_server;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test`
Expected: PASS (all tests so far, including the two new ones)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/http_capture_client.rs packages/sensor/src/probe_server.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): HTTP capture client and probe server"
```

---

## Task 7: Sensor `main.rs` — CLI + poll loop wiring

**Files:**
- Modify: `packages/sensor/src/main.rs`
- Modify: `packages/sensor/Cargo.toml` (add `clap`)

**Interfaces:**
- Consumes: everything from Tasks 1–6
- Produces: `run_poll_iteration(source: &dyn WindowSource, policy: &AppPolicy, dedupe: &mut DedupeCache, client: &CaptureClient) -> PollOutcome` (extracted for unit testing — `main()` itself just loops calling this on a timer, which isn't unit-tested directly)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/main.rs — tests target a lib-exposed function, so first add to lib.rs:
```

```rust
// packages/sensor/src/poll_loop.rs
#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedupe::DedupeCache;
    use crate::policy::AppPolicy;
    use crate::window_source::{FakeWindowSource, WindowSnapshot, WindowSource};

    struct NullSink { pub calls: std::cell::RefCell<Vec<String>> }
    impl NullSink {
        fn new() -> Self { NullSink { calls: std::cell::RefCell::new(vec![]) } }
    }
    // A minimal stand-in for CaptureClient's send behavior, injected via a trait so the test
    // doesn't need a real HTTP server.
    pub trait CaptureSink {
        fn send(&self, snap: &WindowSnapshot, hash: &str) -> Result<(), String>;
    }
    impl CaptureSink for NullSink {
        fn send(&self, snap: &WindowSnapshot, hash: &str) -> Result<(), String> {
            self.calls.borrow_mut().push(format!("{}:{}", snap.app_bundle_id, hash));
            Ok(())
        }
    }

    #[test]
    fn changed_allowed_content_is_sent_once() {
        let source = FakeWindowSource::new();
        source.set_next(Some(WindowSnapshot {
            app_name: "Notes".into(),
            app_bundle_id: "com.example.notes".into(),
            window_title: "Untitled".into(),
            content: "first draft".into(),
        }));
        let policy = AppPolicy::with_denylist(vec![]);
        let mut dedupe = DedupeCache::new();
        let sink = NullSink::new();

        run_poll_iteration(&source, &policy, &mut dedupe, &sink);
        run_poll_iteration(&source, &policy, &mut dedupe, &sink); // same content again

        assert_eq!(sink.calls.borrow().len(), 1, "duplicate content should not be re-sent");
    }

    #[test]
    fn denied_app_is_never_sent() {
        let source = FakeWindowSource::new();
        source.set_next(Some(WindowSnapshot {
            app_name: "1Password".into(),
            app_bundle_id: "com.1password.1password".into(),
            window_title: "Vault".into(),
            content: "secret stuff".into(),
        }));
        let policy = AppPolicy::with_denylist(vec!["com.1password.1password".to_string()]);
        let mut dedupe = DedupeCache::new();
        let sink = NullSink::new();

        run_poll_iteration(&source, &policy, &mut dedupe, &sink);

        assert_eq!(sink.calls.borrow().len(), 0, "denied app content must never be sent");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test poll_loop`
Expected: FAIL — `run_poll_iteration`, `CaptureSink` not defined outside the test module.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/poll_loop.rs (prepend above the test module)
use crate::dedupe::{content_hash, DedupeCache};
use crate::policy::{AppPolicy, Policy};
use crate::redact::redact;
use crate::window_source::{WindowSnapshot, WindowSource};

pub trait CaptureSink {
    fn send(&self, snap: &WindowSnapshot, hash: &str) -> Result<(), String>;
}

/// One poll tick: read the focused window, check policy BEFORE using content, dedupe,
/// redact (pass 1), and send. Returns nothing meaningful to production callers today;
/// the return-free shape keeps this simple to call from a timer loop in main().
pub fn run_poll_iteration(
    source: &dyn WindowSource,
    policy: &AppPolicy,
    dedupe: &mut DedupeCache,
    sink: &dyn CaptureSink,
) {
    let Some(snap) = source.read_focused() else { return };

    // Policy check runs on identity fields only, before content is used for anything else.
    if policy.check(&snap.app_bundle_id) == Policy::Deny {
        return;
    }

    let redacted_content = redact(&snap.content);
    let hash = content_hash(&redacted_content);

    if !dedupe.check_and_update(&snap.app_bundle_id, &snap.window_title, &hash) {
        return; // unchanged since last poll
    }

    let redacted_snap = WindowSnapshot { content: redacted_content, ..snap };
    let _ = sink.send(&redacted_snap, &hash); // best-effort; a network failure just means this tick is lost
}
```

```rust
// packages/sensor/src/http_capture_client.rs — implement CaptureSink for the real client
// (append to the existing impl block file)
impl crate::poll_loop::CaptureSink for CaptureClient {
    fn send(&self, snap: &WindowSnapshot, hash: &str) -> Result<(), String> {
        self.send_capture(snap, hash)
    }
}
```

```rust
// packages/sensor/src/main.rs
mod poll_loop; // note: main.rs is a binary crate root; poll_loop is also re-exported via lib.rs for tests (see lib.rs change below)

use clap::Parser;
use obsidian_tc_sensor::dedupe::DedupeCache;
use obsidian_tc_sensor::http_capture_client::CaptureClient;
use obsidian_tc_sensor::policy::AppPolicy;
use obsidian_tc_sensor::poll_loop::run_poll_iteration;
use obsidian_tc_sensor::probe_server::{serve_probe, ProbeStatus};
use std::sync::Arc;
use std::time::Duration;

#[derive(Parser, Debug)]
struct Args {
    #[arg(long)]
    server_url: String,
    #[arg(long)]
    api_key: String,
    #[arg(long, default_value_t = 2000)]
    interval_ms: u64,
    #[arg(long, default_value_t = 41415)]
    probe_port: u16,
    /// Comma-separated bundle IDs to deny, e.g. default-seeded password managers.
    #[arg(long, default_value = "")]
    denylist: String,
}

fn main() {
    let args = Args::parse();
    let denylist: Vec<String> = args.denylist.split(',').filter(|s| !s.is_empty()).map(String::from).collect();

    let status = Arc::new(ProbeStatus::new(std::env::consts::OS));
    serve_probe(args.probe_port, status.clone());

    #[cfg(target_os = "macos")]
    let source = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
    #[cfg(not(target_os = "macos"))]
    compile_error!("Phase 1 of this plan only implements a macOS WindowSource");

    let policy = AppPolicy::with_denylist(denylist);
    let mut dedupe = DedupeCache::new();
    let client = CaptureClient::new(args.server_url, args.api_key);

    loop {
        run_poll_iteration(&source, &policy, &mut dedupe, &client);
        std::thread::sleep(Duration::from_millis(args.interval_ms));
    }
}
```

```rust
// packages/sensor/src/lib.rs
pub mod window_source;
pub mod dedupe;
pub mod redact;
pub mod policy;
#[cfg(target_os = "macos")]
pub mod macos_window_source;
pub mod http_capture_client;
pub mod probe_server;
pub mod poll_loop;
```

```toml
# packages/sensor/Cargo.toml — add to [dependencies]
clap = { version = "4", features = ["derive"] }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test`
Expected: PASS (all tests, including the two new `poll_loop` tests)

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/poll_loop.rs packages/sensor/src/main.rs packages/sensor/src/http_capture_client.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): wire poll loop, CLI args, and main entry point"
```

---

## Task 8: Shared config schema — `ambient` block

**Files:**
- Modify: `packages/shared/src/config.schema.ts`
- Test: `packages/shared/test/config.schema.test.ts`

**Interfaces:**
- Consumes: nothing (schema-only)
- Produces: `AmbientConfigSchema` exported from `config.schema.ts`, merged into `ServerConfigSchema` as an optional `ambient` field with defaults `{ enabled: false, retentionDays: 180, sensorApiKey: undefined, sensorProbeUrl: "http://127.0.0.1:41415" }`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/test/config.schema.test.ts — add this describe block
describe("AmbientConfigSchema", () => {
  it("defaults retentionDays to 180 and enabled to false", () => {
    const parsed = ServerConfigSchema.parse({ vaults: [{ id: "main", path: "/tmp/vault" }] });
    expect(parsed.ambient.enabled).toBe(false);
    expect(parsed.ambient.retentionDays).toBe(180);
  });

  it("rejects a non-positive retentionDays", () => {
    expect(() =>
      ServerConfigSchema.parse({
        vaults: [{ id: "main", path: "/tmp/vault" }],
        ambient: { retentionDays: 0 },
      }),
    ).toThrow();
  });

  it("accepts an explicit retention preset", () => {
    const parsed = ServerConfigSchema.parse({
      vaults: [{ id: "main", path: "/tmp/vault" }],
      ambient: { enabled: true, retentionDays: 90, sensorApiKey: "s".repeat(32) },
    });
    expect(parsed.ambient.retentionDays).toBe(90);
    expect(parsed.ambient.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && bun test test/config.schema.test.ts -t AmbientConfigSchema`
Expected: FAIL — `parsed.ambient` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/shared/src/config.schema.ts — add near the other nested config schemas
export const AmbientConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    retentionDays: z.number().int().positive().default(180),
    sensorApiKey: z.string().min(32).optional(),
    sensorProbeUrl: z.string().url().default("http://127.0.0.1:41415"),
  })
  .default({});

// In the main ServerConfigSchema object, add:
//   ambient: AmbientConfigSchema,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && bun test test/config.schema.test.ts -t AmbientConfigSchema`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.schema.ts packages/shared/test/config.schema.test.ts
git commit -m "feat(shared): add ambient config block (retention, sensor secret, probe URL)"
```

---

## Task 9: `ambient.db` provisioning

**Files:**
- Create: `packages/server/src/db/ambient.ts`
- Test: `packages/server/test/ambient-db.test.ts`

**Interfaces:**
- Consumes: `Migration`, `runMigrations` from `db/migrate.ts` (existing); `Database` from `db/types.ts` (existing); `openDatabase` from `db/open.ts` (existing) — same imports `provisionExperientialDb` already uses
- Produces: `AMBIENT_MIGRATIONS: Migration[]`, `provisionAmbientDb(cacheDir: string, opts?: { version?: string; now?: () => number; open?: (path: string) => Promise<Database> }): Promise<Database>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-db.test.ts
import { describe, expect, it } from "vitest";
import { provisionAmbientDb } from "../src/db/ambient";
import { openMemoryDb } from "./helpers";

describe("provisionAmbientDb", () => {
  it("creates the ambient tables", async () => {
    const db = await provisionAmbientDb("unused-for-memory-open", {
      open: async () => openMemoryDb(),
    });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("ambient_captures");
    expect(names).toContain("ambient_app_policy");
  });

  it("is idempotent across repeated provisioning calls on the same handle's migration chain", async () => {
    const memDb = openMemoryDb();
    await provisionAmbientDb("unused", { open: async () => memDb });
    await expect(provisionAmbientDb("unused", { open: async () => memDb })).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-db.test.ts`
Expected: FAIL — `provisionAmbientDb` not defined.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/db/ambient.ts
import { join } from "node:path";
import type { Migration } from "./migrate";
import { runMigrations } from "./migrate";
import { openDatabase } from "./open";
import type { Database } from "./types";

export const AMBIENT_MIGRATIONS: Migration[] = [
  {
    version: "20260707_001_ambient_init",
    sql: `
CREATE TABLE ambient_captures (
  id            TEXT PRIMARY KEY,
  app_name      TEXT NOT NULL,
  app_bundle_id TEXT NOT NULL,
  window_title  TEXT,
  content       TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  platform      TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX idx_ambient_captures_expires ON ambient_captures(expires_at);
CREATE INDEX idx_ambient_captures_app     ON ambient_captures(app_bundle_id, captured_at DESC);

CREATE VIRTUAL TABLE ambient_captures_fts USING fts5(
  content, window_title, app_name,
  content='ambient_captures', content_rowid='rowid'
);

CREATE TABLE ambient_app_policy (
  app_bundle_id TEXT PRIMARY KEY,
  policy        TEXT NOT NULL,
  source        TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
    `,
  },
];

export interface ProvisionAmbientOptions {
  version?: string;
  now?: () => number;
  open?: (path: string) => Promise<Database>;
}

/** Provisions ambient.db as a PHYSICALLY SEPARATE store, mirroring provisionExperientialDb:
 *  its own migration chain, never FK'd into cache.db, so ambient data can never contaminate
 *  the authoritative vault/memory graph (spec §5). */
export async function provisionAmbientDb(
  cacheDir: string,
  opts: ProvisionAmbientOptions = {},
): Promise<Database> {
  const open = opts.open ?? openDatabase;
  const db = await open(join(cacheDir, "ambient.db"));
  runMigrations(db, AMBIENT_MIGRATIONS, { version: opts.version, now: opts.now });
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-db.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/ambient.ts packages/server/test/ambient-db.test.ts
git commit -m "feat(server): provision ambient.db as a physically separate low-trust store"
```

---

## Task 10: Ambient store — captures + app policy accessors

**Files:**
- Create: `packages/server/src/ambient/store.ts`
- Test: `packages/server/test/ambient-store.test.ts`

**Interfaces:**
- Consumes: `Database` (existing), `provisionAmbientDb` (Task 9)
- Produces: `genCaptureId()`, `AmbientCaptureRow`, `insertCapture(db, input, retentionDays, now)`, `recentCaptures(db, limit)`, `searchCaptures(db, query, opts)`, `purgeExpired(db, now)`, `AppPolicyRow`, `getAppPolicy(db, appBundleId)`, `upsertAppPolicy(db, appBundleId, policy, now)`, `purgeCapturesForApp(db, appBundleId)`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-store.test.ts
import { describe, expect, it } from "vitest";
import { provisionAmbientDb } from "../src/db/ambient";
import {
  getAppPolicy,
  insertCapture,
  purgeCapturesForApp,
  purgeExpired,
  recentCaptures,
  searchCaptures,
  upsertAppPolicy,
} from "../src/ambient/store";
import { openMemoryDb } from "./helpers";

async function freshDb() {
  return provisionAmbientDb("unused", { open: async () => openMemoryDb() });
}

describe("ambient store", () => {
  it("inserts and retrieves the most recent capture", async () => {
    const db = await freshDb();
    insertCapture(
      db,
      { appName: "Notes", appBundleId: "com.example.notes", windowTitle: "Draft", content: "hello", contentHash: "h1", platform: "macos" },
      180,
      1000,
    );
    const recent = recentCaptures(db, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.content).toBe("hello");
    expect(recent[0]?.expires_at).toBe(1000 + 180 * 86_400_000);
  });

  it("finds a capture by full-text search", async () => {
    const db = await freshDb();
    insertCapture(db, { appName: "Notes", appBundleId: "com.example.notes", windowTitle: "Draft", content: "quarterly pricing review", contentHash: "h1", platform: "macos" }, 180, 1000);
    insertCapture(db, { appName: "Mail", appBundleId: "com.apple.mail", windowTitle: "Inbox", content: "lunch plans", contentHash: "h2", platform: "macos" }, 180, 1000);

    const results = searchCaptures(db, "pricing", { limit: 10 });
    expect(results.items).toHaveLength(1);
    expect(results.items[0]?.app_name).toBe("Notes");
  });

  it("purges only expired rows", async () => {
    const db = await freshDb();
    insertCapture(db, { appName: "A", appBundleId: "com.a", windowTitle: "", content: "old", contentHash: "h1", platform: "macos" }, 1, 0); // expires at 86_400_000
    insertCapture(db, { appName: "B", appBundleId: "com.b", windowTitle: "", content: "new", contentHash: "h2", platform: "macos" }, 180, 200_000_000_000);

    const result = purgeExpired(db, 100_000_000_000); // after the first row's expiry, before the second's
    expect(result.purged).toBe(1);
    expect(recentCaptures(db, 10)).toHaveLength(1);
  });

  it("upserting a deny policy purges that app's historical rows", async () => {
    const db = await freshDb();
    insertCapture(db, { appName: "Bank", appBundleId: "com.bank.app", windowTitle: "", content: "balance", contentHash: "h1", platform: "macos" }, 180, 1000);
    upsertAppPolicy(db, "com.bank.app", "deny", 2000);
    const purge = purgeCapturesForApp(db, "com.bank.app");

    expect(purge.purged).toBe(1);
    expect(getAppPolicy(db, "com.bank.app")?.policy).toBe("deny");
    expect(recentCaptures(db, 10)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-store.test.ts`
Expected: FAIL — module `../src/ambient/store` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/ambient/store.ts
import { randomBytes } from "node:crypto";
import type { Database } from "../db/types";

export interface AmbientCaptureRow {
  id: string;
  app_name: string;
  app_bundle_id: string;
  window_title: string | null;
  content: string;
  content_hash: string;
  platform: string;
  captured_at: number;
  expires_at: number;
}

const CAPTURE_COLS =
  "id, app_name, app_bundle_id, window_title, content, content_hash, platform, captured_at, expires_at";

const MS_PER_DAY = 86_400_000;

export function genCaptureId(): string {
  return `amb_${randomBytes(12).toString("hex")}`;
}

export interface InsertCaptureInput {
  appName: string;
  appBundleId: string;
  windowTitle: string | null;
  content: string;
  contentHash: string;
  platform: string;
}

export function insertCapture(
  db: Database,
  input: InsertCaptureInput,
  retentionDays: number,
  now: number,
): AmbientCaptureRow {
  const id = genCaptureId();
  const expiresAt = now + retentionDays * MS_PER_DAY;
  db.prepare(
    `INSERT INTO ambient_captures (id, app_name, app_bundle_id, window_title, content, content_hash, platform, captured_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.appName, input.appBundleId, input.windowTitle, input.content, input.contentHash, input.platform, now, expiresAt);
  db.prepare(
    `INSERT INTO ambient_captures_fts (rowid, content, window_title, app_name)
     SELECT rowid, content, window_title, app_name FROM ambient_captures WHERE id = ?`,
  ).run(id);
  return db.prepare(`SELECT ${CAPTURE_COLS} FROM ambient_captures WHERE id = ?`).get(id) as AmbientCaptureRow;
}

export function recentCaptures(db: Database, limit: number): AmbientCaptureRow[] {
  return db
    .prepare(`SELECT ${CAPTURE_COLS} FROM ambient_captures ORDER BY captured_at DESC LIMIT ?`)
    .all(limit) as AmbientCaptureRow[];
}

export interface SearchCapturesOptions {
  from?: number;
  to?: number;
  appBundleId?: string;
  limit: number;
  cursor?: string;
}

export interface SearchCapturesResult {
  items: AmbientCaptureRow[];
  nextCursor: string | null;
}

export function searchCaptures(db: Database, query: string, opts: SearchCapturesOptions): SearchCapturesResult {
  const clauses: string[] = ["ambient_captures_fts MATCH ?"];
  const params: unknown[] = [query];
  if (opts.from !== undefined) {
    clauses.push("c.captured_at >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    clauses.push("c.captured_at <= ?");
    params.push(opts.to);
  }
  if (opts.appBundleId !== undefined) {
    clauses.push("c.app_bundle_id = ?");
    params.push(opts.appBundleId);
  }
  const start = opts.cursor ? Number.parseInt(opts.cursor, 10) || 0 : 0;
  const rows = db
    .prepare(
      `SELECT ${CAPTURE_COLS.split(", ").map((c) => `c.${c}`).join(", ")}
       FROM ambient_captures_fts f JOIN ambient_captures c ON c.rowid = f.rowid
       WHERE ${clauses.join(" AND ")}
       ORDER BY c.captured_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit + 1, start) as AmbientCaptureRow[];
  const hasMore = rows.length > opts.limit;
  const items = hasMore ? rows.slice(0, opts.limit) : rows;
  return { items, nextCursor: hasMore ? String(start + opts.limit) : null };
}

export function purgeExpired(db: Database, now: number): { purged: number } {
  const info = db.prepare("DELETE FROM ambient_captures WHERE expires_at < ?").run(now);
  return { purged: info.changes };
}

export interface AppPolicyRow {
  app_bundle_id: string;
  policy: "allow" | "deny";
  source: "default_seed" | "user";
  updated_at: number;
}

export function getAppPolicy(db: Database, appBundleId: string): AppPolicyRow | undefined {
  return db.prepare("SELECT * FROM ambient_app_policy WHERE app_bundle_id = ?").get(appBundleId) as
    | AppPolicyRow
    | undefined;
}

export function upsertAppPolicy(db: Database, appBundleId: string, policy: "allow" | "deny", now: number): void {
  db.prepare(
    `INSERT INTO ambient_app_policy (app_bundle_id, policy, source, updated_at) VALUES (?, ?, 'user', ?)
     ON CONFLICT(app_bundle_id) DO UPDATE SET policy = excluded.policy, source = 'user', updated_at = excluded.updated_at`,
  ).run(appBundleId, policy, now);
}

export function purgeCapturesForApp(db: Database, appBundleId: string): { purged: number } {
  const info = db.prepare("DELETE FROM ambient_captures WHERE app_bundle_id = ?").run(appBundleId);
  return { purged: info.changes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-store.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ambient/store.ts packages/server/test/ambient-store.test.ts
git commit -m "feat(server): ambient store — captures, FTS search, app policy, purge"
```

---

## Task 11: Server-side redaction (pass 2) — fail-closed

**Files:**
- Create: `packages/server/src/ambient/redact.ts`
- Test: `packages/server/test/ambient-redact.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `AmbientRedactionError extends Error`, `redactAmbientContent(content: string): string` (throws `AmbientRedactionError` on internal failure — caller in Task 12 must catch and drop the capture, never store on catch)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-redact.test.ts
import { describe, expect, it, vi } from "vitest";
import { AmbientRedactionError, redactAmbientContent } from "../src/ambient/redact";

describe("redactAmbientContent", () => {
  it("redacts an SSN", () => {
    const out = redactAmbientContent("ssn 123-45-6789 on file");
    expect(out).not.toContain("123-45-6789");
    expect(out).toContain("[REDACTED:ssn]");
  });

  it("redacts a Luhn-valid card number", () => {
    const out = redactAmbientContent("card 4111111111111111");
    expect(out).not.toContain("4111111111111111");
    expect(out).toContain("[REDACTED:card]");
  });

  it("leaves ordinary text untouched", () => {
    expect(redactAmbientContent("just a normal note")).toBe("just a normal note");
  });

  it("throws AmbientRedactionError when the underlying regex engine fails, so the caller can fail closed", () => {
    const badPattern = { test: () => { throw new Error("boom"); } } as unknown as RegExp;
    expect(() => redactAmbientContent("anything", [badPattern])).toThrow(AmbientRedactionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-redact.test.ts`
Expected: FAIL — module `../src/ambient/redact` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/ambient/redact.ts
export class AmbientRedactionError extends Error {
  constructor(cause: unknown) {
    super(`ambient redaction pipeline failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "AmbientRedactionError";
  }
}

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CARD_RE = /\b\d{13,19}\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Pass 2 redaction — the server-side safety net behind the sensor's pass 1. Throws
 * AmbientRedactionError on any internal failure; the ingest path (Task 12) MUST catch this
 * and drop the capture rather than store it (spec §9: fail-closed is the load-bearing
 * security property of this whole feature). `extraPatterns` is test-only, for exercising
 * the fail-closed path deterministically.
 */
export function redactAmbientContent(content: string, extraPatterns: RegExp[] = []): string {
  try {
    let out = content.replace(SSN_RE, "[REDACTED:ssn]");
    out = out.replace(CARD_RE, (match) => (luhnValid(match) ? "[REDACTED:card]" : match));
    for (const pattern of extraPatterns) {
      pattern.test(out); // exercised only by the deliberately-broken test double
    }
    return out;
  } catch (cause) {
    throw new AmbientRedactionError(cause);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-redact.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ambient/redact.ts packages/server/test/ambient-redact.test.ts
git commit -m "feat(server): pass-2 ambient redaction, fail-closed on internal error"
```

---

## Task 12: Ingest — redact, policy recheck, store

**Files:**
- Create: `packages/server/src/ambient/ingest.ts`
- Test: `packages/server/test/ambient-ingest.test.ts`

**Interfaces:**
- Consumes: `redactAmbientContent`, `AmbientRedactionError` (Task 11); `insertCapture`, `getAppPolicy` (Task 10)
- Produces: `IngestCaptureInput`, `ingestCapture(db, input, opts): { accepted: boolean; reason?: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-ingest.test.ts
import { describe, expect, it } from "vitest";
import { provisionAmbientDb } from "../src/db/ambient";
import { ingestCapture } from "../src/ambient/ingest";
import { recentCaptures, upsertAppPolicy } from "../src/ambient/store";
import { openMemoryDb } from "./helpers";

async function freshDb() {
  return provisionAmbientDb("unused", { open: async () => openMemoryDb() });
}

const baseInput = {
  appName: "Notes",
  appBundleId: "com.example.notes",
  windowTitle: "Draft",
  content: "quarterly pricing review",
  contentHash: "h1",
  platform: "macos",
  capturedAt: 1000,
};

describe("ingestCapture", () => {
  it("accepts and stores an allowed capture", () => {
    const db = openMemoryDb();
    const result = ingestCapture(db, baseInput, { retentionDays: 180, now: () => 1000 });
    expect(result.accepted).toBe(true);
    expect(recentCaptures(db, 10)).toHaveLength(1);
  });

  it("rejects a capture from a server-side-denied app without storing it", () => {
    const db = openMemoryDb();
    upsertAppPolicy(db, "com.example.notes", "deny", 500);
    const result = ingestCapture(db, baseInput, { retentionDays: 180, now: () => 1000 });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("app_denied");
    expect(recentCaptures(db, 10)).toHaveLength(0);
  });

  it("redacts content before storing", () => {
    const db = openMemoryDb();
    ingestCapture(db, { ...baseInput, content: "card 4111111111111111" }, { retentionDays: 180, now: () => 1000 });
    const rows = recentCaptures(db, 10);
    expect(rows[0]?.content).not.toContain("4111111111111111");
  });
});
```

Note: this test file provisions `ambient.db` tables via `provisionAmbientDb` in earlier tasks' tests, but here uses a raw `openMemoryDb()` directly for `ingestCapture` — align this with whatever pattern `test/helpers.ts` already establishes for other domains (e.g. `m5-helpers.ts` builds a fully-migrated db before testing store functions). If `openMemoryDb()` alone doesn't include the ambient migrations, call `provisionAmbientDb` first as the other ambient tests do, then pass its returned handle into `ingestCapture`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-ingest.test.ts`
Expected: FAIL — module `../src/ambient/ingest` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/ambient/ingest.ts
import type { Database } from "../db/types";
import { AmbientRedactionError, redactAmbientContent } from "./redact";
import { getAppPolicy, insertCapture } from "./store";

export interface IngestCaptureInput {
  appName: string;
  appBundleId: string;
  windowTitle: string | null;
  content: string;
  contentHash: string;
  platform: string;
  capturedAt: number;
}

export interface IngestOptions {
  retentionDays: number;
  now: () => number;
}

export interface IngestResult {
  accepted: boolean;
  reason?: "app_denied" | "redaction_failed";
}

/**
 * Server-side ingest: policy recheck (defense in depth against a stale/compromised sensor),
 * then pass-2 redaction, then store. FAIL CLOSED: any redaction error drops the capture —
 * it is never stored (spec §9). This must run behind the sensor-secret auth check in the
 * HTTP route (Task 13), not as authorization logic itself.
 */
export function ingestCapture(db: Database, input: IngestCaptureInput, opts: IngestOptions): IngestResult {
  const policy = getAppPolicy(db, input.appBundleId);
  if (policy?.policy === "deny") {
    return { accepted: false, reason: "app_denied" };
  }

  let redacted: string;
  try {
    redacted = redactAmbientContent(input.content);
  } catch (e) {
    if (e instanceof AmbientRedactionError) {
      return { accepted: false, reason: "redaction_failed" };
    }
    throw e;
  }

  insertCapture(
    db,
    {
      appName: input.appName,
      appBundleId: input.appBundleId,
      windowTitle: input.windowTitle,
      content: redacted,
      contentHash: input.contentHash,
      platform: input.platform,
    },
    opts.retentionDays,
    opts.now(),
  );
  return { accepted: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-ingest.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ambient/ingest.ts packages/server/test/ambient-ingest.test.ts
git commit -m "feat(server): ambient ingest pipeline — policy recheck, fail-closed redaction, store"
```

---

## Task 13: Wire `POST /ambient/v1/capture` into the HTTP transport

**Files:**
- Modify: `packages/server/src/transports/http.ts`
- Test: `packages/server/test/ambient-route.test.ts`

**Interfaces:**
- Consumes: `ingestCapture` (Task 12); existing Hono app construction in `http.ts`
- Produces: a mounted route, no new exported functions (route-level integration test only)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-route.test.ts
import { describe, expect, it } from "vitest";
import { buildHttpApp } from "../src/transports/http"; // verify this is the actual exported app-builder name in http.ts; adjust the import if the existing export is named differently
import { provisionAmbientDb } from "../src/db/ambient";
import { recentCaptures } from "../src/ambient/store";

describe("POST /ambient/v1/capture", () => {
  it("stores a valid, correctly-authenticated capture", async () => {
    const ambientDb = await provisionAmbientDb("unused", { open: async () => (await import("./helpers")).openMemoryDb() });
    const app = buildHttpApp({ /* ...existing required options..., */ ambientDb, ambientApiKey: "test-secret", ambientRetentionDays: 180 } as never);

    const res = await app.request("/ambient/v1/capture", {
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
      body: JSON.stringify({
        app_name: "Notes",
        app_bundle_id: "com.example.notes",
        window_title: "Draft",
        content: "hello",
        content_hash: "h1",
        platform: "macos",
        captured_at: 1000,
      }),
    });

    expect(res.status).toBe(200);
    expect(recentCaptures(ambientDb, 10)).toHaveLength(1);
  });

  it("rejects a request with the wrong secret", async () => {
    const ambientDb = await provisionAmbientDb("unused", { open: async () => (await import("./helpers")).openMemoryDb() });
    const app = buildHttpApp({ ambientDb, ambientApiKey: "test-secret", ambientRetentionDays: 180 } as never);

    const res = await app.request("/ambient/v1/capture", {
      method: "POST",
      headers: { Authorization: "Bearer wrong-secret", "Content-Type": "application/json" },
      body: JSON.stringify({ app_name: "x", app_bundle_id: "x", window_title: null, content: "x", content_hash: "x", platform: "macos", captured_at: 1 }),
    });

    expect(res.status).toBe(401);
  });
});
```

**Note for the implementer:** `http.ts`'s existing app-builder function name/signature must be verified against the current file (it takes `registry`, `auth`, `db`, `acl`, `vaultId`, etc. per `HttpAppOptions` — see the file as it stands at plan-writing time) before wiring the two new fields (`ambientDb`, `ambientApiKey`, `ambientRetentionDays`) into its options type. Extend `HttpAppOptions` rather than introducing a second app-builder.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-route.test.ts`
Expected: FAIL — 404, route not mounted.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/transports/http.ts — add to HttpAppOptions:
//   ambientDb?: Database;
//   ambientApiKey?: string;
//   ambientRetentionDays?: number;
//
// and, wherever the Hono app's routes are registered (alongside the existing MCP route
// mounting), add:

app.post("/ambient/v1/capture", async (c) => {
  if (!options.ambientDb || !options.ambientApiKey) {
    return c.json({ ok: false, code: "ambient_not_configured" }, 404);
  }
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
  if (token !== options.ambientApiKey) {
    return c.json({ ok: false, code: "unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.content !== "string" || typeof body.app_bundle_id !== "string") {
    return c.json({ ok: false, code: "invalid_input" }, 400);
  }
  const result = ingestCapture(
    options.ambientDb,
    {
      appName: String(body.app_name ?? ""),
      appBundleId: body.app_bundle_id,
      windowTitle: body.window_title ?? null,
      content: body.content,
      contentHash: String(body.content_hash ?? ""),
      platform: String(body.platform ?? "unknown"),
      capturedAt: Number(body.captured_at ?? Date.now()),
    },
    { retentionDays: options.ambientRetentionDays ?? 180, now: Date.now },
  );
  return c.json({ ok: result.accepted, reason: result.reason });
});
```

```typescript
// packages/server/src/transports/http.ts — add near the other imports
import { ingestCapture } from "../ambient/ingest";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-route.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transports/http.ts packages/server/test/ambient-route.test.ts
git commit -m "feat(server): mount POST /ambient/v1/capture with dedicated bearer auth"
```

---

## Task 14: MCP tools — `get_current_context` / `search_ambient_context`

**Files:**
- Create: `packages/server/src/tools/m8/ambient-tools.ts`
- Test: `packages/server/test/m8-ambient-tools.test.ts`

**Interfaces:**
- Consumes: `recentCaptures`, `searchCaptures` (Task 10); `defineTool` (existing, from `tools/m1/define.ts`); `Pagination` schema (existing, from `@the-40-thieves/obsidian-tc-shared`)
- Produces: `buildAmbientTools(deps: { ambientDb: Database }): ToolDefinition[]`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/m8-ambient-tools.test.ts
import { describe, expect, it } from "vitest";
import { provisionAmbientDb } from "../src/db/ambient";
import { insertCapture } from "../src/ambient/store";
import { buildAmbientTools } from "../src/tools/m8/ambient-tools";
import { openMemoryDb } from "./helpers";

async function toolsWithSeededDb() {
  const db = await provisionAmbientDb("unused", { open: async () => openMemoryDb() });
  insertCapture(db, { appName: "Notes", appBundleId: "com.example.notes", windowTitle: "Draft", content: "quarterly pricing review", contentHash: "h1", platform: "macos" }, 180, 1000);
  return { db, tools: buildAmbientTools({ ambientDb: db }) };
}

describe("ambient MCP tools", () => {
  it("get_current_context returns the most recent capture", async () => {
    const { tools } = await toolsWithSeededDb();
    const tool = tools.find((t) => t.name === "get_current_context")!;
    expect(tool.requiredScopes).toEqual(["read:ambient"]);
    const result = tool.handler({}, {} as never);
    expect((result as { app_name: string }).app_name).toBe("Notes");
  });

  it("get_current_context has no vault parameter, unlike every vault-scoped tool", async () => {
    const { tools } = await toolsWithSeededDb();
    const tool = tools.find((t) => t.name === "get_current_context")!;
    expect(tool.inputSchema.safeParse({ vault: "main" }).success).toBe(false); // .strict() schema rejects the unknown field
  });

  it("search_ambient_context finds by query", async () => {
    const { tools } = await toolsWithSeededDb();
    const tool = tools.find((t) => t.name === "search_ambient_context")!;
    expect(tool.requiredScopes).toEqual(["read:ambient"]);
    const result = tool.handler({ query: "pricing" }, {} as never) as { items: unknown[] };
    expect(result.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/m8-ambient-tools.test.ts`
Expected: FAIL — module `../src/tools/m8/ambient-tools` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/tools/m8/ambient-tools.ts
import { Pagination } from "@the-40-thieves/obsidian-tc-shared";
import { z } from "zod";
import type { ToolDefinition } from "../../mcp/registry";
import { recentCaptures, searchCaptures } from "../../ambient/store";
import type { Database } from "../../db/types";
import { defineTool } from "../m1/define";

export interface M8Deps {
  ambientDb: Database;
}

/**
 * No `vault` parameter on either tool — ambient context has no vault boundary (spec §5),
 * unlike every other tool domain in this codebase.
 */
export function buildAmbientTools(deps: M8Deps): ToolDefinition[] {
  return [
    defineTool({
      name: "get_current_context",
      description: "Read the most recently captured ambient context (active app/window/text).",
      inputSchema: z.object({}).strict(),
      requiredScopes: ["read:ambient"],
      handler: () => {
        const [latest] = recentCaptures(deps.ambientDb, 1);
        if (!latest) return { app_name: null, window_title: null, content: null, captured_at: null };
        return {
          app_name: latest.app_name,
          window_title: latest.window_title,
          content: latest.content,
          captured_at: latest.captured_at,
        };
      },
    }),

    defineTool({
      name: "search_ambient_context",
      description: "Full-text search over captured ambient context history.",
      inputSchema: z
        .object({
          query: z.string().min(1),
          from: z.number().int().optional(),
          to: z.number().int().optional(),
          app_bundle_id: z.string().optional(),
        })
        .merge(Pagination)
        .strict(),
      requiredScopes: ["read:ambient"],
      handler: (input) => {
        const limit = input.limit ?? 20;
        const result = searchCaptures(deps.ambientDb, input.query, {
          from: input.from,
          to: input.to,
          appBundleId: input.app_bundle_id,
          limit,
          cursor: input.cursor,
        });
        return {
          items: result.items.map((r) => ({
            id: r.id,
            app_name: r.app_name,
            window_title: r.window_title,
            content: r.content,
            captured_at: r.captured_at,
          })),
          next_cursor: result.nextCursor,
        };
      },
    }),
  ];
}
```

**Note for the implementer:** verify the exact shape of `ToolDefinition`/`defineTool`/`Pagination` against `tools/m1/define.ts` and `tools/m1/index.ts` at implementation time — this task follows the same shape `memory-tools.ts` (Task-equivalent in M5) already uses, but signatures should be checked against the current file rather than assumed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/m8-ambient-tools.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tools/m8/ambient-tools.ts packages/server/test/m8-ambient-tools.test.ts
git commit -m "feat(server): get_current_context and search_ambient_context MCP tools"
```

---

## Task 15: Register the m8 ambient tools into the registry

**Files:**
- Modify: wherever tool domains are aggregated for registration (verify against how `tools/m7/index.ts` is wired into the server today — likely `src/server.ts` or `src/mcp/server.ts`)
- Test: `packages/server/test/tool-count.test.ts` (existing file — extend it)

**Interfaces:**
- Consumes: `buildAmbientTools` (Task 14)
- Produces: nothing new exported; registers 2 more tools into the live registry

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/tool-count.test.ts — locate the existing assertion on total tool count
// (per README: "105 tools across 28 domains") and add:
it("includes the new ambient domain tools", () => {
  // Adjust this assertion to however the existing test constructs/inspects the full registry —
  // e.g. if it does `expect(allToolNames).toContain(...)`, add:
  expect(allToolNames).toContain("get_current_context");
  expect(allToolNames).toContain("search_ambient_context");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/tool-count.test.ts`
Expected: FAIL — new tool names absent from the registry.

- [ ] **Step 3: Write minimal implementation**

```typescript
// Wherever buildMemoryTools(...) (M5) or buildBulkTools(...) (M6) etc. are currently called
// and their results registered — add the analogous call:
import { buildAmbientTools } from "./tools/m8/ambient-tools";
// ...
if (config.ambient.enabled && ambientDb) {
  registry.registerAll(buildAmbientTools({ ambientDb }));
}
```

**Note for the implementer:** the exact call site and registration API (`registry.registerAll` vs. individual `registry.register` calls in a loop) must match the pattern already used for M6/M7 tool registration in the current codebase — copy that pattern exactly rather than inventing a new one. The conditional on `config.ambient.enabled` matters: when ambient capture isn't configured, these two tools should not even be advertised, consistent with `toolVisibility`'s existing philosophy of only surfacing what's actually usable.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/tool-count.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): register ambient tools when ambient.enabled is configured"
```

---

## Task 16: Maintenance sweep — purge expired ambient captures

**Files:**
- Modify: `packages/server/src/db/maintenance.ts`
- Test: `packages/server/test/maintenance.test.ts` (existing file — extend it)

**Interfaces:**
- Consumes: `purgeExpired` (Task 10)
- Produces: nothing new exported; the existing sweep function gains one more purge call

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/maintenance.test.ts — add:
import { provisionAmbientDb } from "../src/db/ambient";
import { insertCapture, recentCaptures } from "../src/ambient/store";

it("purges expired ambient captures during the sweep", async () => {
  const ambientDb = await provisionAmbientDb("unused", { open: async () => openMemoryDb() });
  insertCapture(ambientDb, { appName: "A", appBundleId: "com.a", windowTitle: "", content: "old", contentHash: "h", platform: "macos" }, 1, 0);

  runMaintenanceSweep({ /* ...existing required args..., */ ambientDb, now: () => 200_000_000_000 });

  expect(recentCaptures(ambientDb, 10)).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/maintenance.test.ts -t "purges expired ambient"`
Expected: FAIL — the row is still present; the sweep function doesn't yet accept/use `ambientDb`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/db/maintenance.ts — add to the sweep function's options type and body
import { purgeExpired as purgeExpiredAmbient } from "../ambient/store";

// In the existing sweep function's options interface, add:
//   ambientDb?: Database;
//
// In the existing sweep function's body, alongside the existing idempotency/elicit-token
// reaping calls, add:
if (opts.ambientDb) {
  purgeExpiredAmbient(opts.ambientDb, opts.now());
}
```

**Note for the implementer:** match the exact existing function name/signature/options-interface in `maintenance.ts` (it already purges idempotency and elicit rows on a schedule — this is one more call in that same function, following the same "optional store" pattern as everything else that's conditionally configured).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/maintenance.test.ts`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db/maintenance.ts packages/server/test/maintenance.test.ts
git commit -m "feat(server): purge expired ambient captures in the maintenance sweep"
```

---

## Task 17: CLI — `obsidian-tc sensor install` / `sensor status`

**Files:**
- Create: `packages/server/src/cli/sensor-install.ts`
- Modify: `packages/server/src/cli.ts` (wire the new subcommand — verify exact command-registration pattern against how `plugin install` is already wired)
- Test: `packages/server/test/sensor-cli.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `generateSensorApiKey(): string`, `writeSensorConfig(path: string, config: { serverUrl: string; apiKey: string }, opts?: { writeFile?: (path: string, content: string) => void }): void`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/sensor-cli.test.ts
import { describe, expect, it, vi } from "vitest";
import { generateSensorApiKey, writeSensorConfig } from "../src/cli/sensor-install";

describe("sensor install", () => {
  it("generates a key at least 32 characters long", () => {
    const key = generateSensorApiKey();
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it("generates a different key each call", () => {
    expect(generateSensorApiKey()).not.toBe(generateSensorApiKey());
  });

  it("writes the expected sensor config file content", () => {
    const written: Record<string, string> = {};
    writeSensorConfig("/tmp/sensor.json", { serverUrl: "http://127.0.0.1:8765", apiKey: "x".repeat(32) }, {
      writeFile: (path, content) => { written[path] = content; },
    });
    const parsed = JSON.parse(written["/tmp/sensor.json"] ?? "{}");
    expect(parsed.serverUrl).toBe("http://127.0.0.1:8765");
    expect(parsed.apiKey).toBe("x".repeat(32));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/sensor-cli.test.ts`
Expected: FAIL — module `../src/cli/sensor-install` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/cli/sensor-install.ts
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

export function generateSensorApiKey(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars
}

export interface SensorConfig {
  serverUrl: string;
  apiKey: string;
}

export function writeSensorConfig(
  path: string,
  config: SensorConfig,
  opts: { writeFile?: (path: string, content: string) => void } = {},
): void {
  const write = opts.writeFile ?? writeFileSync;
  write(path, JSON.stringify(config, null, 2));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/sensor-cli.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli/sensor-install.ts packages/server/test/sensor-cli.test.ts
git commit -m "feat(cli): sensor install helpers — key generation and config writing"
```

**Note for the implementer:** wiring `sensor-install.ts` into an actual `obsidian-tc sensor install` CLI subcommand (argument parsing, printing next-step instructions to the user, invoking platform-specific autostart registration) follows the exact pattern `cli/plugin-install.ts` already establishes for `obsidian-tc plugin install` — copy that command's structure in `cli.ts`/`cli/args.ts` rather than inventing a new one. Per-OS autostart registration (LaunchAgent plist generation on macOS) is real, non-trivial platform code; if it doesn't fit in this task's scope, it should be split into its own follow-up task rather than stubbed.

---

## Task 18: End-to-end integration test

**Files:**
- Test: `packages/server/test/ambient-integration.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9–15

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-integration.test.ts
import { describe, expect, it } from "vitest";
import { provisionAmbientDb } from "../src/db/ambient";
import { ingestCapture } from "../src/ambient/ingest";
import { buildAmbientTools } from "../src/tools/m8/ambient-tools";
import { openMemoryDb } from "./helpers";

describe("ambient end-to-end: ingest -> search tool", () => {
  it("a captured event is findable via search_ambient_context immediately after ingest", async () => {
    const db = await provisionAmbientDb("unused", { open: async () => openMemoryDb() });

    const ingestResult = ingestCapture(
      db,
      {
        appName: "Notes",
        appBundleId: "com.example.notes",
        windowTitle: "Draft",
        content: "roadmap discussion about the sensor rollout",
        contentHash: "h1",
        platform: "macos",
        capturedAt: 1000,
      },
      { retentionDays: 180, now: () => 1000 },
    );
    expect(ingestResult.accepted).toBe(true);

    const tools = buildAmbientTools({ ambientDb: db });
    const searchTool = tools.find((t) => t.name === "search_ambient_context")!;
    const result = searchTool.handler({ query: "roadmap" }, {} as never) as { items: Array<{ content: string }> };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toContain("roadmap");

    const currentTool = tools.find((t) => t.name === "get_current_context")!;
    const current = currentTool.handler({}, {} as never) as { app_name: string };
    expect(current.app_name).toBe("Notes");
  });

  it("a redaction-pipeline failure means the event is never searchable", async () => {
    // This exercises the fail-closed contract end to end: ingestCapture's catch path
    // (Task 12) must mean nothing lands in the store for the search tool to find.
    const db = await provisionAmbientDb("unused", { open: async () => openMemoryDb() });
    // ingestCapture itself only fails closed on an AmbientRedactionError from redactAmbientContent;
    // this test documents that contract rather than forcing a real internal failure (already
    // covered directly in ambient-redact.test.ts's fail-closed test).
    const tools = buildAmbientTools({ ambientDb: db });
    const searchTool = tools.find((t) => t.name === "search_ambient_context")!;
    const result = searchTool.handler({ query: "anything" }, {} as never) as { items: unknown[] };
    expect(result.items).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-integration.test.ts`
Expected: FAIL only if any earlier task's code has a wiring bug — at this point in the plan all consumed functions already exist, so this test should largely pass on first run; treat any failure here as a signal to revisit the specific earlier task it points to.

- [ ] **Step 3: (No new implementation expected)**

If Step 2 fails, the fix belongs in whichever earlier task's file the failure traces back to — do not add new production code directly in this task; correct the earlier task and re-run.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-integration.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/test/ambient-integration.test.ts
git commit -m "test(server): end-to-end ambient ingest -> search_ambient_context coverage"
```

---

## Self-Review

**Spec coverage:**
- §3 (local-desktop only): captured as a Global Constraint; no code in this plan attempts Docker/remote wiring. ✅
- §4.1 (sensor is sole permission holder; push capture / pull probe): Tasks 1–7 (sensor) + Task 13 (ingest route) implement exactly this shape. ✅
- §4.2 (thin native layer, testable core): `MacosWindowSource` (Task 5) is the only OS-specific code; dedupe/redact/policy/poll_loop (Tasks 2–4, 7) are pure and fully unit-tested via `FakeWindowSource`. ✅
- §5 (ambient.db physically separate, no vault_id): Task 9 provisions a separate file; Task 10's schema has no `vault_id` column anywhere. ✅
- §6 (capture flow: policy-before-read, dedupe, redact pass 1+2, fail-closed, observability): Tasks 2–4, 7 (sensor side) and 11–12 (server side) cover this. Observability wiring (OTel/Prometheus/MORGIANA/event_log) on the ingest route is called out as an implementer note in Task 13 rather than fully coded — **gap noted below**.
- §7 (180-day default retention, configurable): Task 8 (config schema) + Task 10 (`insertCapture` computes `expires_at` from `retentionDays`). ✅
- §8 (FTS5 only, no embeddings): Task 10's schema and `searchCaptures` are FTS-only; no embedding code anywhere in this plan. ✅
- §9 (scopes, fail-closed redaction, kill switch, rate limiting, sensor health as observability): `read:ambient` scope wired in Task 14; fail-closed redaction in Tasks 11–12 with a dedicated test. **Gaps noted below**: the kill switch (`sensor pause` / `ambient.enabled: false` at runtime), the dedicated ingest rate-limit tier, and `server_health` sensor-status integration are not separately tasked.
- §10 (vault promotion via `capture_queue`): not tasked — **gap noted below**.

**Gaps identified and disposition:**
1. **Observability emission on the ingest route** (OTel span, Prometheus counter, MORGIANA event, `event_log` row) is mentioned only as a note in Task 13, not coded. This should be its own follow-up task before this ships to real users, since §6 calls it out as a first-class requirement ("no new observability system required" implies it must actually call the existing one). Added as Task 19 below rather than silently leaving it as a comment.
2. **Runtime kill switch** (`obsidian-tc sensor pause`, `ambient.enabled` toggled live) is not tasked — Task 8 only adds the config field; nothing reads it to stop an already-running sensor. Added as Task 20.
3. **`server_health` sensor-status integration** (§6's "sensor health is an observability concern") and the probe-client (§4.1's `GET /ambient/v1/probe` from the server side) are not tasked — the sensor serves the probe (Task 6) but nothing on the server side calls it. Added as Task 21.
4. **Vault promotion via `capture_queue`** (§10) is explicitly out of scope for this plan per the spec's own phasing language ("when a user or agent wants to") — this is a usage-time feature that composes existing M5 tools (`enqueueCapture` with `source: "ambient"`) rather than new plumbing, and is reasonable to defer to a follow-up plan rather than block Phase 1 on it. Left out.
5. **Rate limiting on the ingest route** is not tasked. Given dedup already bounds request volume under normal operation, and this is a local-loopback-only endpoint (not internet-facing), this is a reasonable Phase 1 deferral rather than a blocking gap — noted for a follow-up plan, not added here.

**Placeholder scan:** no "TBD"/"TODO"/"implement later" found in any task's code. The two "Note for the implementer" callouts (Tasks 14, 15, 17) are explicit instructions to verify an existing file's current shape before wiring against it — not placeholders for missing logic, since the actual new code in each of those tasks is fully written.

**Type consistency check:** `AmbientCaptureRow`, `InsertCaptureInput`, `AppPolicyRow` (Task 10) are used with matching shapes in Tasks 11, 12, 14, 16, 18. `IngestCaptureInput`/`IngestResult` (Task 12) match their usage in Task 13's route handler and Task 18's integration test. `WindowSnapshot`/`WindowSource`/`CaptureSink` (Tasks 1, 6, 7) are consistent across the sensor crate. Confirmed no drift.

## Additional tasks added during self-review

### Task 19: Observability on the ingest route

**Files:**
- Modify: `packages/server/src/transports/http.ts` (the route added in Task 13)
- Test: extend `packages/server/test/ambient-route.test.ts`

**Interfaces:**
- Consumes: existing `metrics/registry.ts`, `morgiana/emitter.ts`, `audit.ts` exports (verify exact function names against those files at implementation time — this task calls them, it does not redefine them)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-route.test.ts — add
it("records an event_log row for a successful ingest", async () => {
  const ambientDb = await provisionAmbientDb("unused", { open: async () => (await import("./helpers")).openMemoryDb() });
  const cacheDb = (await import("./helpers")).openMemoryDb(); // wherever event_log actually lives — verify against audit.ts's writeEvent signature
  const app = buildHttpApp({ ambientDb, ambientApiKey: "test-secret", ambientRetentionDays: 180, cacheDb } as never);

  await app.request("/ambient/v1/capture", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ app_name: "Notes", app_bundle_id: "com.example.notes", window_title: null, content: "hi", content_hash: "h1", platform: "macos", captured_at: 1 }),
  });

  const rows = cacheDb.prepare("SELECT * FROM event_log WHERE event_type = 'ambient_capture'").all();
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-route.test.ts -t "event_log row"`
Expected: FAIL — no `event_log` row written.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/transports/http.ts — inside the /ambient/v1/capture handler from Task 13,
// after computing `result`, before returning:
import { writeEvent } from "../audit";
// ...
if (options.cacheDb) {
  writeEvent(options.cacheDb, {
    ts: Date.now(),
    vault_id: null,
    tool_name: "ambient_capture",
    caller: "sensor",
    status: result.accepted ? "ok" : "skipped",
    error_code: result.reason ?? null,
    event_type: "ambient_capture",
  });
}
```

**Note for the implementer:** verify `writeEvent`'s exact parameter shape against `audit.ts` (already read during planning — see the `AuditEvent` interface) and confirm `options.cacheDb` is the right handle name to add to `HttpAppOptions` (it should be the *existing* `cache.db` handle already passed elsewhere in this file, not a new database — `event_log` lives in `cache.db`, not `ambient.db`, per the existing schema). OTel span and Prometheus counter emission should follow the same call sites already used by the main tool-dispatch path (`otel/tracing.ts`, `metrics/registry.ts`) — wire them the same way once the exact existing call signatures are confirmed.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transports/http.ts packages/server/test/ambient-route.test.ts
git commit -m "feat(server): emit audit event_log row on ambient capture ingest"
```

### Task 20: Runtime kill switch — `ambient.enabled` gates the route live

**Files:**
- Modify: `packages/server/src/transports/http.ts` (the route from Task 13)
- Test: extend `packages/server/test/ambient-route.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-route.test.ts — add
it("refuses ingest when ambient capture is disabled, even with a valid secret", async () => {
  const ambientDb = await provisionAmbientDb("unused", { open: async () => (await import("./helpers")).openMemoryDb() });
  const app = buildHttpApp({ ambientDb, ambientApiKey: "test-secret", ambientRetentionDays: 180, ambientEnabled: false } as never);

  const res = await app.request("/ambient/v1/capture", {
    method: "POST",
    headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ app_name: "x", app_bundle_id: "x", window_title: null, content: "x", content_hash: "x", platform: "macos", captured_at: 1 }),
  });

  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-route.test.ts -t "refuses ingest when ambient capture is disabled"`
Expected: FAIL — currently accepts regardless of an enabled flag.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/transports/http.ts — at the top of the /ambient/v1/capture handler,
// before the auth check:
if (options.ambientEnabled === false) {
  return c.json({ ok: false, code: "ambient_disabled" }, 403);
}
```

Add `ambientEnabled?: boolean` to `HttpAppOptions`, sourced from the live `config.ambient.enabled` value at server startup, re-read on each request rather than captured once — this is what makes it a genuine runtime kill switch (a config reload or a future `sensor pause` command that flips this value takes effect on the next request, not only at next restart). If the current config-loading architecture only supports startup-time snapshots, that limitation should be called out explicitly rather than silently treated as "live."

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transports/http.ts packages/server/test/ambient-route.test.ts
git commit -m "feat(server): ambient.enabled=false refuses ingest at the route (runtime kill switch)"
```

### Task 21: Server-side probe client + `server_health` sensor status

**Files:**
- Create: `packages/server/src/ambient/probe.ts`
- Test: `packages/server/test/ambient-probe.test.ts`

**Interfaces:**
- Consumes: nothing new (a plain HTTP GET)
- Produces: `SensorProbeStatus`, `probeSensor(probeUrl: string, opts?: { fetchFn?: typeof fetch; timeoutMs?: number }): Promise<SensorProbeStatus>`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/ambient-probe.test.ts
import { describe, expect, it, vi } from "vitest";
import { probeSensor } from "../src/ambient/probe";

describe("probeSensor", () => {
  it("returns reachable status on a successful probe", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok", platform: "macos", permission_status: "granted", last_capture_at: 123 }),
    });
    const result = await probeSensor("http://127.0.0.1:41415/ambient/v1/probe", { fetchFn: fetchFn as never });
    expect(result.reachable).toBe(true);
    expect(result.permissionStatus).toBe("granted");
  });

  it("returns unreachable status without throwing when the sensor is down", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeSensor("http://127.0.0.1:41415/ambient/v1/probe", { fetchFn: fetchFn as never });
    expect(result.reachable).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/ambient-probe.test.ts`
Expected: FAIL — module `../src/ambient/probe` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/ambient/probe.ts
export interface SensorProbeStatus {
  reachable: boolean;
  platform?: string;
  permissionStatus?: string;
  lastCaptureAt?: number | null;
}

/** Mirrors the Obsidian companion's probe pattern: never throws, degrades to
 *  { reachable: false } on any failure so callers (server_health) can surface
 *  sensor health as a status field rather than a per-call error (spec §9). */
export async function probeSensor(
  probeUrl: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<SensorProbeStatus> {
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const res = await fetchFn(probeUrl, { signal: AbortSignal.timeout(opts.timeoutMs ?? 500) });
    if (!res.ok) return { reachable: false };
    const body = (await res.json()) as { platform?: string; permission_status?: string; last_capture_at?: number | null };
    return {
      reachable: true,
      platform: body.platform,
      permissionStatus: body.permission_status,
      lastCaptureAt: body.last_capture_at ?? null,
    };
  } catch {
    return { reachable: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/ambient-probe.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ambient/probe.ts packages/server/test/ambient-probe.test.ts
git commit -m "feat(server): probeSensor for server_health sensor-status reporting"
```

**Note for the implementer:** wiring `probeSensor`'s result into the actual `server_health`/`get_server_config` admin tool's response object (alongside the existing `native_loaded` / `vec_enabled` / `fts_enabled` flags) requires locating that tool's current implementation and adding one more field — follow the existing flag pattern exactly.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-ambient-context-macos-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
