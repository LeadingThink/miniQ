#!/usr/bin/env python3
"""PTY smoke test for the miniQ rich REPL (isolated data dir)."""
import os, pty, re, select, sys, time, tempfile

ROOT = "/private/tmp/miniq-apple/target/debug"
data = tempfile.mkdtemp(prefix="miniq-pty-")
proj = tempfile.mkdtemp(prefix="miniq-proj-")
open(os.path.join(proj, "hello.txt"), "w").write("hi\n")

import subprocess
cfg = subprocess.run([f"{ROOT}/miniq", "--data-dir", data, "--daemon-path", f"{ROOT}/miniq-daemon",
    "configure", "--model", "claude-haiku-4.5"], env={**os.environ, "MINIQ_API_KEY": "sk-pty-smoke-dummy"},
    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
print("configure:", cfg.returncode, (cfg.stdout + cfg.stderr)[-300:])

pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.environ.update(TERM="xterm-256color", MINIQ_DATA_DIR=data, COLUMNS="100", LINES="30")
    os.execv(f"{ROOT}/miniq", ["miniq", "--daemon-path", f"{ROOT}/miniq-daemon"])

import fcntl, termios, struct
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
buf = b""

def read(t=1.5):
    global buf
    end = time.time() + t
    out = b""
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            # answer cursor-position queries so crossterm does not stall
            if b"\x1b[6n" in chunk:
                os.write(fd, b"\x1b[1;1R")
    buf += out
    return out.decode("utf-8", "replace")

def clean(s):
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r", "", s)

def send(b, t=1.5):
    os.write(fd, b)
    return clean(read(t))

results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n  --- {detail[-600:]!r}"))

start = clean(read(8))
check("starts rich REPL", len(start) > 0, start)
out = send(b"/he\t", 1.5)
check("tab completes /help", "/help" in out, out)
out = send(b"\r", 1.5)
check("/help lists slash commands", "/permissions" in out and "/goal" in out, out)
out = send(b"/permissions\r")
check("/permissions shows mode", re.search(r"(?i)always|auto|full", out), out)
out = send(b"\x1b[Z", 1.5)  # Shift+Tab
check("Shift+Tab cycles approval", re.search(r"(?i)auto|full|always", out), out)
out = send(b"/goal\r")
check("/goal empty state", "No goal" in out, out)
out = send(b"/goal ship the parity release\r")
check("/goal set", "Goal active" in out, out)
out = send(b"/goal pause\r")
check("/goal pause", "Goal paused" in out, out)
out = send(b"/goal\r")
check("/goal shows paused", "paused" in out and "ship the parity" in out, out)
out = send(b"@hel\t", 1.5)
check("@ path completion", "hello.txt" in out, out)
send(b"\x15")  # clear line (Ctrl+U)
out = send(b"!echo local-shell-ok\r", 2)
check("!cmd runs locally", "local-shell-ok" in out, out)
out = send(b"line one\x1b\rline two", 1)  # Alt+Enter newline
check("Alt+Enter multi-line", "line two" in out, out)
out = send(b"\x03", 1)  # Ctrl+C clears
out2 = send(b"\x1b[A", 1)  # history up -> last submitted
check("history recall", "echo local-shell-ok" in out2 or "/goal" in out2, out2)
send(b"\x03", 0.5)
out = send(b"/skills\r", 2)
check("/skills responds", re.search(r"(?i)skill", out), out)
out = send(b"/usage\r", 2)
check("/usage responds", re.search(r"(?i)model call|usage", out), out)
send(b"\x15", 0.3)  # empty the line first
send(b"\x03", 0.3)
try:
    send(b"\x03", 1.5)
except OSError:
    pass
time.sleep(0.5)
try:
    wpid, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    wpid = pid
check("double Ctrl+C exits", wpid == pid, clean(buf.decode("utf-8", "replace"))[-400:])
if wpid != pid:
    os.kill(pid, 9)
hist = os.path.join(data, "cli_history")
check("history file written", os.path.exists(hist) and "goal" in open(hist).read(), str(os.listdir(data)))
print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed; data={data}")
