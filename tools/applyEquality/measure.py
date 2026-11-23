import json
import os
import resource
import subprocess
import sys
import threading
import time


def tree_rss_kb(root):
    total = 0
    stack = [root]
    seen = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            with open(f"/proc/{pid}/status") as status:
                for line in status:
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1])
                        break
            for task in os.listdir(f"/proc/{pid}/task"):
                with open(f"/proc/{pid}/task/{task}/children") as children:
                    stack.extend(int(child) for child in children.read().split())
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return total


def main():
    out = sys.argv[1]
    command = sys.argv[2:]
    interval = float(os.environ.get("EQ_SAMPLE_S", "0"))
    started = time.monotonic()
    child = subprocess.Popen(command)
    peak = [0]
    done = threading.Event()

    def sample():
        while not done.wait(interval):
            peak[0] = max(peak[0], tree_rss_kb(child.pid))

    sampler = None
    if interval > 0:
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
    code = child.wait()
    wall = time.monotonic() - started
    done.set()
    if sampler:
        sampler.join()
    usage = resource.getrusage(resource.RUSAGE_CHILDREN)
    with open(out, "w") as handle:
        json.dump(
            {
                "exit": code,
                "wall_s": round(wall, 3),
                "user_s": round(usage.ru_utime, 3),
                "sys_s": round(usage.ru_stime, 3),
                "maxrss_mb": round(usage.ru_maxrss / 1024, 1),
                "sampled_peak_mb": round(peak[0] / 1024, 1) if sampler else None,
            },
            handle,
        )
    sys.exit(code if code >= 0 else 128 - code)


main()
