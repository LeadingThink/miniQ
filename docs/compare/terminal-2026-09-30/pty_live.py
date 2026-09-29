#!/usr/bin/env python3
"""Live PTY test: approval card, queue, steer, Esc cancel, question card.
Uses an isolated data dir whose settings copy ONLY the provider from the real
settings (no remote access). The key is never printed."""
import json, os, pty, re, select, time, tempfile, fcntl, termios, struct

ROOT = "/private/tmp/miniq-apple/target/debug"
data = tempfile.mkdtemp(prefix="miniq-live-")
proj = tempfile.mkdtemp(prefix="miniq-liveproj-")
real = json.load(open(os.path.expanduser("~/.local/share/miniq/settings.json")))
json.dump({"provider": real["provider"], "mcpServers": [], "approvalMode": "alwaysAsk"},
          open(os.path.join(data, "settings.json"), "w"))
os.chmod(os.path.join(data, "settings.json"), 0o600)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.environ.update(TERM="xterm-256color", MINIQ_DATA_DIR=data, COLUMNS="110", LINES="40")
    os.execv(f"{ROOT}/miniq", ["miniq", "--daemon-path", f"{ROOT}/miniq-daemon"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
log = open("/tmp/cli-cmp/pty_live.log", "w")
seen = ""

def clean(s):
    return re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r", "", s)

def pump(t):
    global seen
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            if b"\x1b[6n" in chunk:
                os.write(fd, b"\x1b[1;1R")
            text = clean(chunk.decode("utf-8", "replace"))
            seen += text
            log.write(text); log.flush()

def wait_for(pattern, t, since):
    end = time.time() + t
    while time.time() < end:
        pump(0.3)
        m = re.search(pattern, seen[since:])
        if m:
            return m
    return None

def send(b):
    os.write(fd, b)

results = []
def check(name, cond, since=0):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"\n  --- {seen[since:][-700:]!r}"), flush=True)

def idle(t=90):
    # a finished turn prints a completion line; then give the UI a moment
    pump(1.0)

pump(8)
# 1. approval card
m0 = len(seen)
send(b"Create a file named approval.txt containing the text ok using your file write tool. Then reply with the single word DONE.\r")
m = wait_for(r"Approval needed", 120, m0)
check("approval card appears", m, m0)
if m:
    check("approval card shows 4 choices", wait_for(r"always allow", 5, m0), m0)
    send(b"1")
    check("approve once -> tool runs / DONE", wait_for(r"DONE", 150, m0), m0)
    check("file actually written", os.path.exists(os.path.join(proj, "approval.txt")))
pump(3)

if os.environ.get("SKIP_QSE"):
    pass
else:
  # 2. queue while running
  m0 = len(seen)
  send(b"Write the numbers from 1 to 60, one per line, no other text.\r")
  wait_for(r"\b5\b", 60, m0)
  send(b"Reply only with QUEUEDOK\r")
  check("Enter while running queues", wait_for(r"(?i)queued", 10, m0), m0)
  check("queued message runs after turn", wait_for(r"QUEUEDOK", 200, m0), m0)
  pump(3)

  # 3. steer while running
  m0 = len(seen)
  send(b"Write the numbers from 1 to 80, one per line, no other text.\r")
  wait_for(r"\b4\b", 60, m0)
  send(b"Ignore the list; reply only STEEROK")
  send(b"\t")
  check("Tab steers", wait_for(r"(?i)steer", 10, m0), m0)
  check("steer text reaches model", wait_for(r"STEEROK", 200, m0), m0)
  pump(3)

  # 4. Esc cancel
  m0 = len(seen)
  send(b"Write the numbers from 1 to 300, one per line, no other text.\r")
  wait_for(r"\b3\b", 60, m0)
  send(b"\x1b")
  check("Esc cancels turn", wait_for(r"(?i)cancel|interrupt|stopped", 20, m0), m0)
  pump(3)

# 5. question card
m0 = len(seen)
send(b"Use your ask-user / question tool (not plain text) to ask me to choose between options Apple and Banana. After I answer, reply FRUIT=<answer>.\r")
m = wait_for(r"Type an answer", 120, m0)
check("question card appears", m and re.search(r"1\. Apple", seen[m0:]), m0)
if m:
    pump(2)
    send(b"2\r")
    check("option number answers question", wait_for(r"FRUIT=\s*Banana", 150, m0), m0)
pump(2)

# status/usage after real turns
m0 = len(seen)
send(b"/usage\r")
check("/usage counts real calls", wait_for(r"(?i)\d+\s*model call|input", 10, m0), m0)

send(b"\x15"); send(b"\x03"); pump(0.5)
try:
    send(b"\x03")
except OSError:
    pass
time.sleep(1)
try:
    os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    pass
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed; data={data}")
