# Ambient Context Capture (Linux Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Linux `WindowSource` backend to the sensor via AT-SPI (the desktop-agnostic accessibility D-Bus service present on GNOME, KDE, and most other Linux desktops with assistive technology enabled), reusing every piece of Phase 1's platform-agnostic core unchanged.

**Architecture:** Same trait-boundary approach as Phase 2 — implement `WindowSource` for `LinuxWindowSource`, wire it into `main.rs`'s platform selection, add systemd-user-unit autostart. **Update:** this plan originally flagged the Rust `atspi` crate's async API as the one piece of the whole three-phase plan written from memory without high confidence, unlike macOS's `osascript`/JXA and Windows' PowerShell/.NET UI Automation (both long-stable, thoroughly documented scripting surfaces). That uncertainty has since been resolved by fetching `odilia-app/atspi`'s own published examples (`currently-focused-frame.rs`, `selected-text.rs`) directly — the active-frame-finding logic in Task 1 is now confirmed against real, current (v0.30.0) crate code rather than guessed. One narrower piece remains best-effort: the text-content sub-lookup within the active frame goes beyond what those examples directly demonstrate (they find the active window, not text within it), so Task 1's manual verification step (Step 6) should confirm that specific inner loop against a live session.

**Tech Stack:** Rust (`atspi` crate for AT-SPI D-Bus access, `tokio` current-thread runtime to bridge its async API into the sync `WindowSource` trait), systemd user units for autostart.

## Global Constraints

(Inherits every constraint from the Phase 1 plan. Additions specific to this phase:)

- AT-SPI requires assistive technology to be enabled on the session (e.g. GNOME: `gsettings set org.gnome.desktop.interface toolkit-accessibility true`; this is often on by default when any AT-SPI client has ever connected, but must not be assumed). The sensor's probe status (`permission_status`, Phase 1 Task 6) should report `"denied"` when the accessibility bus is unreachable, not crash.
- Wayland vs. X11 is not a fork point for AT-SPI itself (it's a D-Bus service independent of the display protocol), but it is exactly why AT-SPI — not a display-server-specific window-inspection API — is the right choice for this platform.
- The active-frame-finding portion of the `atspi` crate call chain in Task 1 is confirmed against the crate's own current (v0.30.0) published examples. The text-content sub-lookup is best-effort beyond those examples and should be confirmed against a live session per Task 1's Step 6 — narrower in scope than originally flagged, still worth checking before calling this phase done.
- `main.rs`'s platform-selection `compile_error!` (last updated in Phase 2, Task 2) must be replaced with a real Linux branch, not simply removed.
- Linux autostart uses a per-user systemd unit (`~/.config/systemd/user/`), not a system service — no root required, consistent with the least-privilege posture established in Phases 1–2.

---

## File Structure

**New:**
- `packages/sensor/src/linux_window_source.rs` — `LinuxWindowSource` (`#[cfg(target_os = "linux")]`)
- `packages/server/src/cli/sensor-install-linux.ts` — systemd user unit generation, called from the existing `sensor-install.ts` CLI flow

**Modified:**
- `packages/sensor/src/lib.rs` — add the new module under its platform cfg
- `packages/sensor/src/main.rs` — replace the Phase 2 `compile_error!` non-macOS/Windows branch with a real Linux branch
- `packages/sensor/Cargo.toml` — add `atspi` and `tokio` under `[target.'cfg(target_os = "linux")'.dependencies]`
- `packages/server/src/cli/sensor-install.ts` — dispatch to the new Linux-specific installer when running on Linux

---

## Task 1: `LinuxWindowSource` via AT-SPI

**Files:**
- Create: `packages/sensor/src/linux_window_source.rs`
- Modify: `packages/sensor/src/lib.rs`
- Modify: `packages/sensor/Cargo.toml`

**Interfaces:**
- Consumes: `WindowSnapshot`, `WindowSource` (Phase 1, Task 1)
- Produces: `LinuxWindowSource::new()`, `map_atspi_fields(app_name: &str, app_id: &str, window_title: &str, text: &str) -> WindowSnapshot` (the fully-testable pure part of this module)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/linux_window_source.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_raw_atspi_fields_into_a_window_snapshot() {
        let snap = map_atspi_fields("gedit", "org.gnome.gedit", "Untitled Document 1", "hello world");
        assert_eq!(snap.app_name, "gedit");
        assert_eq!(snap.app_bundle_id, "org.gnome.gedit");
        assert_eq!(snap.window_title, "Untitled Document 1");
        assert_eq!(snap.content, "hello world");
    }

    #[test]
    fn maps_empty_fields_without_panicking() {
        let snap = map_atspi_fields("", "", "", "");
        assert_eq!(snap.app_name, "");
        assert_eq!(snap.content, "");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test linux_window_source`
Expected: FAIL — `map_atspi_fields` not defined.

- [ ] **Step 3: Write the pure mapping function and the trait scaffold (fully concrete, high confidence)**

```rust
// packages/sensor/src/linux_window_source.rs (prepend above the test module)
use crate::window_source::{WindowSnapshot, WindowSource};

pub struct LinuxWindowSource {
    runtime: tokio::runtime::Runtime,
}

impl LinuxWindowSource {
    pub fn new() -> Self {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build a tokio runtime for the AT-SPI connection");
        LinuxWindowSource { runtime }
    }
}

/// Pure mapping from raw AT-SPI fields to our WindowSnapshot shape. This is the fully
/// unit-testable part of this module — no D-Bus connection required.
pub fn map_atspi_fields(app_name: &str, app_id: &str, window_title: &str, text: &str) -> WindowSnapshot {
    WindowSnapshot {
        app_name: app_name.to_string(),
        app_bundle_id: app_id.to_string(),
        window_title: window_title.to_string(),
        content: text.to_string(),
    }
}

impl WindowSource for LinuxWindowSource {
    fn read_focused(&self) -> Option<WindowSnapshot> {
        let fields = self.runtime.block_on(query_focused_accessible())?;
        Some(map_atspi_fields(&fields.0, &fields.1, &fields.2, &fields.3))
    }
}
```

- [ ] **Step 4: Write the AT-SPI query function — now verified against the crate's own published examples**

*(Updated after implementation-time research: the code below was originally a best-guess and is now replaced with an approach confirmed directly against `odilia-app/atspi`'s own `atspi/examples/currently-focused-frame.rs` and `atspi/examples/selected-text.rs`, current crate version 0.30.0 as of this check. The real API is traversal-based — registry → top-level apps → each app's child frames → the one with `State::Active` — which is actually a better fit for a synchronous poll loop than the event-stream pattern I'd originally guessed at, since it needs no background listener task.)*

```toml
# packages/sensor/Cargo.toml
[target.'cfg(target_os = "linux")'.dependencies]
atspi = "0.30"
atspi-proxies = "0.30"
tokio = { version = "1", features = ["rt-multi-thread"] }
```

```rust
// packages/sensor/src/linux_window_source.rs — add above the WindowSource impl
use atspi::State;
use atspi_proxies::accessible::ObjectRefExt;

/// Queries the AT-SPI accessibility bus for the currently active frame (window) and
/// returns (app_name, app_bus_name, window_title, text). Returns None when the
/// accessibility bus is unreachable (assistive technology not enabled) or no frame is
/// currently active. Confirmed against atspi 0.30.0's own currently-focused-frame.rs
/// example: walk the registry's top-level apps, then each app's child frames, and find
/// the one frame with State::Active.
///
/// Text content is a best-effort addition beyond what that example covers (it only finds
/// the active frame/window, not text within it): this walks the active frame's immediate
/// children for one exposing a Text interface, mirroring the macOS JXA script's same
/// best-effort-with-empty-fallback shape. If this narrower text-lookup step needs
/// adjustment once exercised against a live desktop (Step 6), only this inner loop should
/// need to change — the active-frame-finding logic above it is confirmed, not a guess.
async fn query_focused_accessible() -> Option<(String, String, String, String)> {
    let atspi = atspi::AccessibilityConnection::new().await.ok()?;
    let conn = atspi.connection();
    let apps = atspi.root_accessible_on_registry().await.ok()?.get_children().await.ok()?;

    for app in apps.iter() {
        let app_proxy = app.clone().into_accessible_proxy(conn).await.ok()?;
        let app_name = app_proxy.name().await.unwrap_or_default();
        let app_bus_name = app.name().map(|n| n.to_string()).unwrap_or_default();

        let Ok(children) = app_proxy.get_children().await else { continue };
        for frame in children.iter() {
            if frame.is_null() {
                continue;
            }
            let Ok(frame_proxy) = frame.clone().into_accessible_proxy(conn).await else { continue };
            let Ok(state) = frame_proxy.get_state().await else { continue };
            if !state.contains(State::Active) {
                continue;
            }

            let window_title = frame_proxy.name().await.unwrap_or_default();
            let mut text = String::new();
            if let Ok(frame_children) = frame_proxy.get_children().await {
                for child in frame_children.iter() {
                    if child.is_null() {
                        continue;
                    }
                    if let Ok(child_proxy) = child.clone().into_accessible_proxy(conn).await {
                        if let Ok(proxies) = child_proxy.proxies().await {
                            if let Ok(text_proxy) = proxies.text().await {
                                if let Ok(count) = text_proxy.character_count().await {
                                    text = text_proxy.get_text(0, count).await.unwrap_or_default();
                                    if !text.is_empty() {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return Some((app_name, app_bus_name, window_title, text));
        }
    }
    None
}
```

```rust
// packages/sensor/src/lib.rs — add alongside the existing macOS/Windows cfg blocks
#[cfg(target_os = "linux")]
pub mod linux_window_source;
```

- [ ] **Step 5: Run the pure-mapping test to verify it passes**

Run: `cd packages/sensor && cargo test linux_window_source`
Expected: PASS (2 tests) — this only exercises `map_atspi_fields`, which has no D-Bus dependency, so it runs identically in CI regardless of the query function's correctness.

- [ ] **Step 6: Manual verification on a real Linux desktop session (cannot be automated — no accessibility bus in CI)**

```bash
# Ensure assistive technology is enabled (GNOME example; adjust for other desktops):
gsettings set org.gnome.desktop.interface toolkit-accessibility true
# Then:
cd packages/sensor && cargo run --bin obsidian-tc-sensor -- --server-url http://127.0.0.1:8765 --api-key <test-key>
```
Focus a text editor with visible text and confirm a correct `WindowSnapshot` is produced (add a temporary `eprintln!` in `poll_loop.rs`, removed before commit, same as Phases 1–2's manual verification steps). The active-frame app name/window title should work as directly confirmed by the crate's own example; pay particular attention to whether the text-content sub-lookup actually finds text in common editors/browsers — if it comes back empty more often than expected, the inner child-walking loop in Step 4 is the piece to adjust (e.g., searching more than one level of children, or checking `State::Focused` rather than just presence of a Text interface), not the active-frame-finding logic above it.

- [ ] **Step 7: Commit**

```bash
git add packages/sensor/Cargo.toml packages/sensor/src/linux_window_source.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): Linux WindowSource via AT-SPI (verified against live session per Step 6)"
```

---

## Task 2: Wire Linux into `main.rs`'s platform selection

**Files:**
- Modify: `packages/sensor/src/main.rs`

**Interfaces:**
- Consumes: `LinuxWindowSource` (Task 1)
- Produces: nothing new exported — replaces Phase 2's `compile_error!` branch

- [ ] **Step 1: Write the failing check**

Run: `cd packages/sensor && cargo check --target x86_64-unknown-linux-gnu`
Expected: FAIL — the Phase 2 `compile_error!("This plan implements macOS and Windows WindowSources; Linux lands in Phase 3")` still fires for the Linux target.

- [ ] **Step 2: (covered by Step 1 above)**

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/main.rs — replace the Phase 2 block:
//
//   #[cfg(target_os = "macos")]
//   let source = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
//   #[cfg(target_os = "windows")]
//   let source = obsidian_tc_sensor::windows_window_source::WindowsWindowSource::new();
//   #[cfg(not(any(target_os = "macos", target_os = "windows")))]
//   compile_error!("This plan implements macOS and Windows WindowSources; Linux lands in Phase 3");
//
// with:

#[cfg(target_os = "macos")]
let source = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
#[cfg(target_os = "windows")]
let source = obsidian_tc_sensor::windows_window_source::WindowsWindowSource::new();
#[cfg(target_os = "linux")]
let source = obsidian_tc_sensor::linux_window_source::LinuxWindowSource::new();
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
compile_error!("obsidian-tc-sensor supports macOS, Windows, and Linux only");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo check --target x86_64-unknown-linux-gnu`
Expected: PASS

Run: `cd packages/sensor && cargo check --target x86_64-pc-windows-gnu && cargo check` (native host)
Expected: PASS — confirms Phases 1–2's branches are still unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/src/main.rs
git commit -m "feat(sensor): select LinuxWindowSource on Linux targets"
```

---

## Task 3: Linux autostart — per-user systemd unit

**Files:**
- Create: `packages/server/src/cli/sensor-install-linux.ts`
- Modify: `packages/server/src/cli/sensor-install.ts`
- Test: `packages/server/test/sensor-cli-linux.test.ts`

**Interfaces:**
- Consumes: `SensorConfig`, `writeSensorConfig` (Phase 1, Task 17)
- Produces: `buildSystemdUnit(config: { sensorBinaryPath: string; args: string[] }): string`, `registerLinuxAutostart(config: {...}, opts?: { writeFile?: (path: string, content: string) => void; runCommand?: (cmd: string, args: string[]) => void }): void`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/sensor-cli-linux.test.ts
import { describe, expect, it } from "vitest";
import { buildSystemdUnit, registerLinuxAutostart } from "../src/cli/sensor-install-linux";

describe("Linux sensor autostart", () => {
  it("builds a systemd user unit referencing the sensor binary and its args", () => {
    const unit = buildSystemdUnit({
      sensorBinaryPath: "/home/me/.local/bin/obsidian-tc-sensor",
      args: ["--server-url", "http://127.0.0.1:8765", "--api-key", "secret"],
    });
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/home/me/.local/bin/obsidian-tc-sensor --server-url http://127.0.0.1:8765 --api-key secret");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("writes the unit file and enables it via systemctl --user", () => {
    const written: Record<string, string> = {};
    const calls: Array<{ cmd: string; args: string[] }> = [];
    registerLinuxAutostart(
      { sensorBinaryPath: "/usr/local/bin/obsidian-tc-sensor", args: ["--server-url", "http://127.0.0.1:8765"] },
      {
        writeFile: (path, content) => { written[path] = content; },
        runCommand: (cmd, args) => calls.push({ cmd, args }),
      },
    );
    const unitPath = Object.keys(written).find((p) => p.endsWith("obsidian-tc-sensor.service"));
    expect(unitPath).toBeDefined();
    expect(calls.some((c) => c.cmd === "systemctl" && c.args.includes("--user") && c.args.includes("enable"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/sensor-cli-linux.test.ts`
Expected: FAIL — module `../src/cli/sensor-install-linux` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/cli/sensor-install-linux.ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface LinuxAutostartConfig {
  sensorBinaryPath: string;
  args: string[];
}

/** A minimal per-user systemd unit — no root required, runs at user login/graphical-session
 *  start (WantedBy=default.target under `systemctl --user`), consistent with the
 *  least-privilege posture established for macOS/Windows autostart in Phases 1–2. */
export function buildSystemdUnit(config: LinuxAutostartConfig): string {
  return `[Unit]
Description=obsidian-tc ambient context sensor

[Service]
ExecStart=${config.sensorBinaryPath} ${config.args.join(" ")}
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

export interface RegisterLinuxAutostartOptions {
  writeFile?: (path: string, content: string) => void;
  runCommand?: (cmd: string, args: string[]) => void;
}

export function registerLinuxAutostart(config: LinuxAutostartConfig, opts: RegisterLinuxAutostartOptions = {}): void {
  const writeFile =
    opts.writeFile ??
    ((path: string, content: string) => {
      const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
      const { dirname } = require("node:path") as typeof import("node:path");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    });
  const runCommand =
    opts.runCommand ??
    ((cmd: string, args: string[]) => {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync(cmd, args);
    });

  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, "obsidian-tc-sensor.service");
  writeFile(unitPath, buildSystemdUnit(config));
  runCommand("systemctl", ["--user", "daemon-reload"]);
  runCommand("systemctl", ["--user", "enable", "--now", "obsidian-tc-sensor.service"]);
}
```

```typescript
// packages/server/src/cli/sensor-install.ts — extend the install flow:
import { registerLinuxAutostart } from "./sensor-install-linux";
// ...
if (process.platform === "linux") {
  registerLinuxAutostart({ sensorBinaryPath: sensorBinaryPath, args: sensorArgs });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/sensor-cli-linux.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli/sensor-install-linux.ts packages/server/src/cli/sensor-install.ts packages/server/test/sensor-cli-linux.test.ts
git commit -m "feat(cli): register the sensor as a per-user systemd unit on Linux install"
```

---

## Self-Review

**Spec coverage:** covers §12's Linux backend obligation via the same `WindowSource` trait boundary as Phase 2. ✅

**Placeholder scan:** the AT-SPI query function (Task 1, Step 4) was originally flagged with an explicit, bounded verification requirement rather than presented as certain; that verification has since been performed against the crate's own published examples (`odilia-app/atspi`, v0.30.0) and the code updated accordingly. The remaining best-effort text-lookup sub-step is called out specifically rather than glossed over. No other placeholders found.

**Type consistency:** `WindowSnapshot`/`WindowSource` used identically to Phases 1–2. `LinuxAutostartConfig`/`registerLinuxAutostart` follow the same shape as Phase 2's `WindowsAutostartConfig`/`registerWindowsAutostart`.

**Cross-phase consistency check:** confirmed `main.rs`'s cfg-gated platform selection in this phase's Task 2 is additive to (not a rewrite of) Phase 2's Task 2 — the macOS and Windows branches are carried forward unchanged, only the fallback `compile_error!` branch narrows further.

**Residual honestly flagged, not silently accepted:** the active-frame-finding logic is now confirmed against real crate examples; if Task 1's live-session check (Step 6) finds the text-content sub-lookup needs adjustment, the fix stays local to `query_focused_accessible`'s inner child-walking loop — nothing else in this phase or in Phases 1–2 depends on its internals, only on its fixed `async fn ... -> Option<(String, String, String, String)>` signature.
