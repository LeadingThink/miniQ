# macOS application control acceptance

`app_automation` targets a specific process and window. Its Accessibility operations
must continue while a different application is in front, without moving the system
pointer. This is a separate guarantee from the foreground `computer_use` tool.

The native acceptance fixture is synthetic and cannot send mail. It contains a
subject field, multiline body, secure field, button counter, and attachment chooser.
A second process displays an unrelated foreground window. The test reads the
frontmost PID, pointer location, and global modifier state through public Cocoa/Quartz
APIs before and after actions. It also checks effect readback, Unicode content, complete pagination,
password exclusion, stale-observation rejection, target-only screenshots, and a
native file chooser opening a temporary subdirectory and selecting a generated
attachment. The chooser case exercises AX controls from Apple's file-panel service.

A fourth case uses a custom AppKit view with ordinary `keyDown`, `mouseDown`, and
`scrollWheel` handlers. It has no AXPress or writable AX text substitute. The test
checks process-directed Unicode input across native text batches, a modified named
key, a click whose screenshot coordinates come from observed bounds, and two-axis
scroll delivery. It verifies actual handler results and unchanged foreground,
pointer and keyboard modifiers after every action. Passing compilation alone does
not establish native delivery or isolation; run this opt-in case on the target Mac.
An additional custom `NSView` fixture records real AppKit `keyDown`, `mouseDown`,
and `scrollWheel` delivery. That test checks Unicode input across Quartz batches,
Shift+ArrowLeft, screenshot-derived click coordinates, and both scroll axes. Each
step must use the tool's `processEvent` route, read back its effect, and preserve the
foreground process, pointer, and actual keyboard modifiers. It does not substitute
AXPress or manually forward events to make the test pass.

## Run

Run from the repository root on macOS with Xcode Command Line Tools installed:

```sh
cargo test -p miniq-tools --test app_automation_macos --no-run
MINIQ_RUN_APP_AUTOMATION_UI_TEST=1 cargo test -p miniq-tools \
  --test app_automation_macos -- --ignored --test-threads=1 --nocapture
```

The tests are ignored during ordinary test runs because they create native fixture
windows. The environment variable explicitly opts in to those windows. Keep the
pointer still during the brief native assertions; physical pointer movement correctly
fails the unchanged-pointer assertion. Fixtures and generated screenshots live in
temporary directories and are removed after each test. Only the fixture's own child
processes are terminated.

Accessibility must be granted to the actual execution process or its responsible
application. The screenshot and custom-event cases also need Screen Recording. The tests preflight
permissions without requesting them. A missing grant produces a `NOT RUN` failure
with the executable path, before launching any fixture. Treat that result as blocked
native verification, not as a passing acceptance test. Grant permissions manually in
macOS System Settings and rerun from the same execution context; do not reset global
permissions or automate system privacy dialogs. Rebuilding an unsigned test binary
can change its identity and require checking permissions again.

To run AX acceptance without the separate screenshot case:

```sh
MINIQ_RUN_APP_AUTOMATION_UI_TEST=1 cargo test -p miniq-tools \
  --test app_automation_macos background_app_actions_preserve_foreground_and_cursor \
  -- --ignored --test-threads=1 --nocapture
```

## Manual fixture and file chooser

For app-specific exploration, compile the fixture into a temporary directory and
start it with `--state-file <temporary-json-path>`. A second instance can take
`--foreground` with its own state path. `--probe` prints the current foreground PID
and pointer location without activating an application.
Use `--events` instead of the default controls to inspect the custom event surface.
Only setup establishes its real first responder before the unrelated fixture takes
the foreground. The probe excludes event-delivery flags such as `maskNonCoalesced`
from its keyboard-modifier comparison.

Use `app_automation.windows` to identify the exact target PID/window, then `inspect`
and its `nextOffset`/`parentId` pages. Prefer `setValue` for the subject/body and
`invoke` with the observed `AXPress` action for buttons. The attachment button opens
a native file chooser and records only the selected basename. Test it using a
synthetic temporary file. A sheet may change the
application's key window; refresh `windows` and `inspect` rather than replaying an
action whose follow-up observation failed. The chooser test selects a local file and
checks its basename in the fixture; it does not exercise networking, mail delivery,
or upload behavior in third-party applications.

During diagnosis, a temporary local event monitor confirmed that background
`Cmd+Shift+G` reached the correct file-panel window with the correct key and
modifiers, but did not open the
Go to Folder interface. A successful event dispatch must not be presented as a
successful application action. The acceptance workflow therefore uses observed
`AXPress` actions through `invoke`, plus `select`, and verifies the selected file
instead of relying on that shortcut. The file-panel's
column view can leave the current directory to the right of visible ancestor columns.
The test inspects the actual browser branch, including the public `AXColumns`
relationship and each scroll area's `AXContents`. On the tested macOS file panel,
column scroll areas returned an empty `AXChildren` array even while `AXContents`
contained the file list. The backend preserves `AXChildren`, adds those real
references without duplicates, and reports `childrenSources`. This reads contents
without simulating scrolling. Real `AXParent` chains still determine whether an
element belongs to the target window; a page's logical owner is not a
replacement for that security check. The test does not traverse the sidebar for every
operation or race a temporary view-options menu. It reads the rightmost path column
for the current directory, selects the synthetic folder, then selects the file and
confirms its name in the native preview before pressing the enabled attachment
button. AppKit may report an unsupported setter after the selection has actually
changed. The test does not replay that mutation: only fresh observations and the
final basename recorded by the fixture establish success. Small fixture controls use
two-element pages to verify complete pagination; the file browser uses pages of forty elements.
Setup activates the synthetic target once and confirms its key window,
then switches to the independent foreground fixture before any automation begins.

Application support still matters: custom canvas controls may not expose usable AX
elements, and some applications reject background events. An explicit unsupported
result must never silently fall back to global mouse or keyboard input. No acceptance
test should use a real mailbox, send messages, or change user documents.
