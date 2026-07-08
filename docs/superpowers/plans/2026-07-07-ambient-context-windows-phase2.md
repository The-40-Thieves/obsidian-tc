# Ambient Context Capture (Windows Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows `WindowSource` backend to the sensor, reusing every piece of Phase 1's platform-agnostic core (dedupe, redaction, policy, store, MCP tools, ingest) unchanged.

**Architecture:** Phase 1 established a `WindowSource` trait specifically so a new platform is additive, not invasive. This phase implements `WindowsWindowSource` by shelling out to PowerShell running .NET UI Automation (`System.Windows.Automation`) — the same "shell out rather than raw FFI" trade-off Phase 1 made for macOS's `osascript`/JXA approach, for the same reason: correct, complete, testable code beats plausible-looking unsafe FFI bindings I can't compile-verify here. Nothing outside `packages/sensor/src/windows_window_source.rs` and `main.rs`'s platform-selection branch changes.

**Tech Stack:** Rust (no new crate dependencies — this phase only shells out to `powershell.exe`, already available on every supported Windows target), PowerShell / .NET UI Automation.

## Global Constraints

(Inherits every constraint from the Phase 1 plan. Additions specific to this phase:)

- No new Rust dependencies for the Windows `WindowSource` itself — it shells out to `powershell.exe`, mirroring the macOS `osascript` approach.
- The stable per-app identifier on Windows is the process executable path (not a true Application User Model ID / AUMID) for this phase — AUMID retrieval requires Windows Runtime APIs that are a meaningfully larger lift and are called out explicitly as a documented future improvement, not silently substituted.
- `main.rs`'s existing `#[cfg(not(target_os = "macos"))] compile_error!` (Phase 1, Task 7) must be replaced with a real Windows branch, not simply removed.
- Windows autostart uses a per-user Scheduled Task (`schtasks.exe` / `Register-ScheduledTask`), not a system service — avoids requiring administrator rights, consistent with the spec's least-privilege posture for the sensor process.

---

## File Structure

**New:**
- `packages/sensor/src/windows_window_source.rs` — `WindowsWindowSource` (`#[cfg(target_os = "windows")]`)
- `packages/server/src/cli/sensor-install-windows.ts` — Windows-specific Scheduled Task registration, called from the existing `sensor-install.ts` CLI flow

**Modified:**
- `packages/sensor/src/lib.rs` — add the new module under its platform cfg
- `packages/sensor/src/main.rs` — replace the `compile_error!` non-macOS branch with a real Windows source selection
- `packages/server/src/cli/sensor-install.ts` (from Phase 1, Task 17) — dispatch to the new Windows-specific installer when running on Windows

---

## Task 1: `WindowsWindowSource` via PowerShell UI Automation

**Files:**
- Create: `packages/sensor/src/windows_window_source.rs`
- Modify: `packages/sensor/src/lib.rs`

**Interfaces:**
- Consumes: `WindowSnapshot`, `WindowSource` (Phase 1, Task 1)
- Produces: `WindowsWindowSource::new()`, `build_uia_script() -> &'static str` (exposed for the unit test, same pattern as Phase 1 Task 5's `build_jxa_script`)

- [ ] **Step 1: Write the failing test**

```rust
// packages/sensor/src/windows_window_source.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uia_script_references_automation_element_and_expected_fields() {
        let script = build_uia_script();
        assert!(script.contains("AutomationElement"));
        assert!(script.contains("FocusedElement"));
        assert!(script.contains("ConvertTo-Json"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sensor && cargo test windows_window_source`
Expected: FAIL — `build_uia_script` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/windows_window_source.rs (prepend above the test module)
use crate::window_source::{WindowSnapshot, WindowSource};
use std::process::Command;

pub struct WindowsWindowSource;

impl WindowsWindowSource {
    pub fn new() -> Self {
        WindowsWindowSource
    }
}

/// PowerShell + .NET UI Automation. Uses the focused element's ProcessId to resolve the
/// owning process (our stable-enough app identifier for this phase — see the plan's Global
/// Constraints re: AUMID being a documented future improvement, not this phase's approach),
/// the focused element's Name as the window title, and — where the element exposes
/// ValuePattern — its current text as content. A focusable element without ValuePattern
/// yields an empty content string, handled identically to any other empty capture by the
/// existing dedupe/redact pipeline.
pub fn build_uia_script() -> &'static str {
    r#"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($focused -eq $null) { Write-Output '{}'; exit }
$procId = $focused.Current.ProcessId
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$appName = if ($proc) { $proc.ProcessName } else { "" }
$appPath = if ($proc) { $proc.Path } else { "" }
$windowTitle = $focused.Current.Name
$content = ""
try {
  $valuePattern = $focused.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $content = $valuePattern.Current.Value
} catch { $content = "" }
$result = @{ appName = $appName; appPath = $appPath; windowTitle = $windowTitle; content = $content }
$result | ConvertTo-Json -Compress
"#
}

impl WindowSource for WindowsWindowSource {
    fn read_focused(&self) -> Option<WindowSnapshot> {
        let output = Command::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(build_uia_script())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
        let app_name = parsed.get("appName")?.as_str()?.to_string();
        if app_name.is_empty() {
            return None;
        }
        let app_path = parsed.get("appPath").and_then(|v| v.as_str()).unwrap_or("").to_string();
        Some(WindowSnapshot {
            app_name: app_name.clone(),
            app_bundle_id: if app_path.is_empty() { app_name } else { app_path },
            window_title: parsed.get("windowTitle").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            content: parsed.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        })
    }
}
```

```rust
// packages/sensor/src/lib.rs — add alongside the existing macOS cfg block
#[cfg(target_os = "windows")]
pub mod windows_window_source;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo test windows_window_source`
Expected: PASS (1 test) — this test is pure string-content assertion, so it runs on any host regardless of target OS, same as the macOS equivalent in Phase 1.

- [ ] **Step 5: Manual verification (cannot be automated — no GUI session in CI)**

Run on a real Windows machine:
```powershell
cargo run --bin obsidian-tc-sensor -- --server-url http://127.0.0.1:8765 --api-key <test-key> --interval-ms 2000
```
Then focus a text editor with some visible text and confirm (via a temporary `eprintln!` in `poll_loop.rs`, removed before commit) that a `WindowSnapshot` with the correct process name and visible text is produced. Record the result in the task's PR description, same as Phase 1 Task 5's manual verification step.

- [ ] **Step 6: Commit**

```bash
git add packages/sensor/src/windows_window_source.rs packages/sensor/src/lib.rs
git commit -m "feat(sensor): Windows WindowSource via PowerShell UI Automation"
```

---

## Task 2: Wire Windows into `main.rs`'s platform selection

**Files:**
- Modify: `packages/sensor/src/main.rs`

**Interfaces:**
- Consumes: `WindowsWindowSource` (Task 1)
- Produces: nothing new exported — replaces the Phase 1 `compile_error!` branch

- [ ] **Step 1: Write the failing test**

This task changes conditional-compilation wiring rather than testable logic (the same shape as Phase 1's `main.rs` task) — there is no unit test for a `main()` platform-selection branch. Instead, verify by compilation on each target:

Run (on any host, cross-compiling — mirrors the project's existing cargo-zigbuild cross-compilation setup used for the native module's musl targets):
```bash
cd packages/sensor && cargo check --target x86_64-pc-windows-gnu
```
Expected: FAIL — the current `compile_error!("Phase 1 of this plan only implements a macOS WindowSource")` still fires for any non-macOS target, including Windows.

- [ ] **Step 2: (covered by Step 1 above — no separate failing-test run needed for this task)**

- [ ] **Step 3: Write minimal implementation**

```rust
// packages/sensor/src/main.rs — replace this block from Phase 1:
//
//   #[cfg(target_os = "macos")]
//   let source = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
//   #[cfg(not(target_os = "macos"))]
//   compile_error!("Phase 1 of this plan only implements a macOS WindowSource");
//
// with:

#[cfg(target_os = "macos")]
let source = obsidian_tc_sensor::macos_window_source::MacosWindowSource::new();
#[cfg(target_os = "windows")]
let source = obsidian_tc_sensor::windows_window_source::WindowsWindowSource::new();
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!("This plan implements macOS and Windows WindowSources; Linux lands in Phase 3");
```

**Note for the implementer:** `run_poll_iteration` (Phase 1, Task 7) takes `&dyn WindowSource`, so `source` above must be passed the same way regardless of which branch compiled — no change needed to the loop body itself, only to which concrete type `source` binds to.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sensor && cargo check --target x86_64-pc-windows-gnu`
Expected: PASS (compiles clean)

Run: `cd packages/sensor && cargo check` (native host target, e.g. macOS CI)
Expected: PASS — confirms the macOS branch still compiles unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/sensor/src/main.rs
git commit -m "feat(sensor): select WindowsWindowSource on Windows targets"
```

---

## Task 3: Windows autostart — per-user Scheduled Task

**Files:**
- Create: `packages/server/src/cli/sensor-install-windows.ts`
- Modify: `packages/server/src/cli/sensor-install.ts` (Phase 1, Task 17)
- Test: `packages/server/test/sensor-cli-windows.test.ts`

**Interfaces:**
- Consumes: `SensorConfig`, `writeSensorConfig` (Phase 1, Task 17)
- Produces: `buildScheduledTaskXml(config: { sensorBinaryPath: string; args: string[] }): string`, `registerWindowsAutostart(config: {...}, opts?: { runCommand?: (cmd: string, args: string[]) => void }): void`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/server/test/sensor-cli-windows.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildScheduledTaskXml, registerWindowsAutostart } from "../src/cli/sensor-install-windows";

describe("Windows sensor autostart", () => {
  it("builds Scheduled Task XML referencing the sensor binary and its args", () => {
    const xml = buildScheduledTaskXml({
      sensorBinaryPath: "C:\\Users\\me\\obsidian-tc-sensor.exe",
      args: ["--server-url", "http://127.0.0.1:8765", "--api-key", "secret"],
    });
    expect(xml).toContain("obsidian-tc-sensor.exe");
    expect(xml).toContain("LogonTrigger");
    expect(xml).toContain("--server-url");
  });

  it("registers the task via schtasks.exe with the expected arguments", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    registerWindowsAutostart(
      { sensorBinaryPath: "C:\\sensor.exe", args: ["--server-url", "http://127.0.0.1:8765"] },
      { runCommand: (cmd, args) => calls.push({ cmd, args }) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe("schtasks.exe");
    expect(calls[0]?.args).toContain("/Create");
    expect(calls[0]?.args).toContain("/SC");
    expect(calls[0]?.args).toContain("ONLOGON");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && bun test test/sensor-cli-windows.test.ts`
Expected: FAIL — module `../src/cli/sensor-install-windows` does not exist.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/server/src/cli/sensor-install-windows.ts
export interface WindowsAutostartConfig {
  sensorBinaryPath: string;
  args: string[];
}

/** A minimal Task Scheduler XML definition: run at logon, no elevated privileges required —
 *  a per-user task, consistent with the plan's least-privilege constraint (no admin rights). */
export function buildScheduledTaskXml(config: WindowsAutostartConfig): string {
  const argsXml = config.args.map((a) => a.replace(/&/g, "&amp;")).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Actions Context="Author">
    <Exec>
      <Command>${config.sensorBinaryPath}</Command>
      <Arguments>${argsXml}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

export interface RegisterAutostartOptions {
  runCommand?: (cmd: string, args: string[]) => void;
}

/** Registers the sensor as a per-user Scheduled Task via schtasks.exe /Create, run-at-logon,
 *  no admin elevation required. */
export function registerWindowsAutostart(config: WindowsAutostartConfig, opts: RegisterAutostartOptions = {}): void {
  const run =
    opts.runCommand ??
    ((cmd: string, args: string[]) => {
      // Production default: shell out for real. Kept out of the test path via injection above.
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      execFileSync(cmd, args);
    });
  run("schtasks.exe", [
    "/Create",
    "/TN",
    "ObsidianTcSensor",
    "/TR",
    `"${config.sensorBinaryPath}" ${config.args.join(" ")}`,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/F",
  ]);
}
```

```typescript
// packages/server/src/cli/sensor-install.ts (Phase 1, Task 17) — extend the install flow:
import { registerWindowsAutostart } from "./sensor-install-windows";
// ...
// Wherever the existing install flow branches on platform (or add such a branch if it
// doesn't yet — Phase 1's Task 17 only implemented the macOS LaunchAgent path per its own
// "Note for the implementer"):
if (process.platform === "win32") {
  registerWindowsAutostart({ sensorBinaryPath: sensorBinaryPath, args: sensorArgs });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && bun test test/sensor-cli-windows.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli/sensor-install-windows.ts packages/server/src/cli/sensor-install.ts packages/server/test/sensor-cli-windows.test.ts
git commit -m "feat(cli): register the sensor as a per-user Windows Scheduled Task on install"
```

---

## Self-Review

**Spec coverage:** this phase's only obligation from the design spec is §12's "Windows as an additive platform backend behind the same thin native-primitive interface." Task 1 implements exactly that interface (`WindowSource`); Task 2 wires it in without touching any Phase 1 logic; Task 3 covers the autostart half of "install the sensor" that Phase 1 explicitly deferred for non-macOS platforms. ✅

**Placeholder scan:** none found. The AUMID-vs-executable-path trade-off is stated as an explicit, documented engineering decision (Global Constraints), not a placeholder.

**Type consistency:** `WindowSnapshot`/`WindowSource` used identically to Phase 1's definitions (no redefinition, only a new implementer). `WindowsAutostartConfig`/`registerWindowsAutostart` are new and self-contained, matching the `SensorConfig`/`writeSensorConfig` naming shape already established in Phase 1's Task 17.

**Known residual for a future pass:** true AUMID resolution (rather than executable path) if Windows Store / UWP apps need to be distinguished by identity rather than by `.exe` path — noted, not blocking.
