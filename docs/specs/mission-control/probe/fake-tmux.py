#!/usr/bin/env python3
import sys, os, time, select
LOG = os.environ.get("FAKE_TMUX_LOG", "/tmp/tmux-calls.log")
argv = sys.argv[1:]
stdin_data = ""
if not sys.stdin.isatty():
    try:
        r,_,_ = select.select([sys.stdin], [], [], 0.05)
        if r: stdin_data = sys.stdin.read()
    except Exception: pass
with open(LOG, "a") as f:
    f.write("=== %.6f pid=%d\n" % (time.time(), os.getpid()))
    f.write("ARGV: %r\n" % (argv,))
    f.write("CWD: %s\n" % os.getcwd())
    if stdin_data: f.write("STDIN: %r\n" % stdin_data)
    f.write("\n")

# strip leading socket flags (-L name / -S path) to find the verb
i = 0
while i < len(argv) and argv[i] in ("-L", "-S"):
    i += 2
rest = argv[i:]
verb = rest[0] if rest else ""

def out(s):
    sys.stdout.write(s + "\n")

if "-V" in argv:
    out("tmux 3.5a"); sys.exit(0)
if verb == "has-session":
    sys.exit(1)                      # force session creation path
# find -F format string if present
fmt = ""
if "-F" in rest:
    j = rest.index("-F")
    if j+1 < len(rest): fmt = rest[j+1]
if verb in ("new-session","new-window","split-window"):
    if "#{pane_id}" in fmt: out("%1")
    elif fmt: out("fake")
    sys.exit(0)
if verb == "list-panes":
    if "#{pane_id}" in fmt: out("%0")
    elif fmt: out("fake")
    sys.exit(0)
if verb == "list-windows":
    out("swarm-view"); sys.exit(0)
if verb == "display-message":
    if "#{pane_id}" in rest: out("%0")
    elif "#{window_id}" in rest: out("@0")
    else: out("")
    sys.exit(0)
sys.exit(0)
