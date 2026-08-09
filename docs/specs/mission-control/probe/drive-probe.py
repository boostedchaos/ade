import os, pty, sys, time, select, signal, re

SP = os.environ["SP"]
proj = sys.argv[2]
prompt = sys.argv[1]
env = dict(os.environ)
env["PATH"] = SP + "/probe/bin:" + env["PATH"]
env["FAKE_TMUX_LOG"] = SP + "/probe/tmux-calls.log"
env["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"] = "1"
env["TMUX"] = "/fake-socket,0,0"
env["TMUX_PANE"] = "%0"
env["TERM"] = "xterm-256color"
env.pop("CLAUDE_CODE_CHILD_SESSION", None)
env.pop("CLAUDECODE", None)

BIN = "~/.local/share/claude/versions/2.1.226"
pid, fd = pty.fork()
if pid == 0:
    os.chdir(proj)
    os.execve(BIN, [BIN, "--dangerously-skip-permissions", "--teammate-mode", "tmux", "--debug"], env)

buf = bytearray()
out = open(SP + "/probe/pty3.out", "wb")

def clean():
    d = bytes(buf).decode("utf8", "replace")
    d = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", d)
    return d.replace("\r", "\n")

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r,_,_ = select.select([fd], [], [], 0.3)
        if r:
            try: d = os.read(fd, 65536)
            except OSError: return False
            if not d: return False
            buf.extend(d); out.write(d); out.flush()
    return True

def wait_for(pat, seconds):
    end = time.time() + seconds
    while time.time() < end:
        pump(0.5)
        if re.search(pat, clean().replace(" ", ""), re.I):
            return True
    return False

if wait_for(r"trustthisfolder", 45):
    print("[drive] trust dialog -> Enter", flush=True)
    time.sleep(1); os.write(fd, b"\r")
pump(30)
print("[drive] sending prompt", flush=True)
os.write(fd, prompt.encode())
time.sleep(2)
os.write(fd, b"\r")
pump(300)
try:
    os.write(fd, b"\x03"); time.sleep(1); os.write(fd, b"\x03")
except OSError: pass
pump(10)
try: os.kill(pid, signal.SIGKILL)
except Exception: pass
out.close()
print("[drive] done", flush=True)
