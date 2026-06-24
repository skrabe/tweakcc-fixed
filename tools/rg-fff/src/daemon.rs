//! Warm-index daemon: a per-root, long-lived fff `FilePicker` behind a Unix
//! domain socket. fff's background watcher keeps the index fresh, so the daemon
//! answers grep queries instantly without paying the cold directory scan each
//! time.
//!
//! Strictly an optimization. If no daemon is running, the socket is stale, or
//! anything fails, the client cold-scans (and lazily spawns a daemon for next
//! time). Correctness never depends on the daemon — only latency.
//!
//! Protocol (client -> daemon), 9 newline-terminated lines:
//!   v5
//!   plain|regex|fuzzy
//!   flags: files_only(l) line_numbers(n) count(c) ignore_case(i) hidden(h)
//!          sep_between_files(s) — each char or '-'    e.g. "-n--hs"
//!   <dir_prefixes comma-joined, e.g. "app/,lib/" or empty=cwd>
//!   <pattern>
//!   <path_prefix>
//!   <before_context>
//!   <after_context>
//!   <include_exts comma-joined, e.g. ".ts,.tsx" or empty>
//! Response (daemon -> client): the literal "FALLBACK\n" (daemon can't serve ->
//! client cold-scans), OR `<exit_code>\n<body_byte_len>\n<body>` — the client
//! verifies it received exactly body_byte_len bytes, so a daemon killed mid-write
//! is detected (short read -> cold-scan) rather than silently under-reporting.
//! The version tag ("v5") makes an older daemon reject a newer client cleanly, and
//! is embedded in the socket filename so versions never share a socket.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::{fs, thread};

use fff_search::file_picker::FilePicker;
use fff_search::{FFFMode, FilePickerOptions, SharedFilePicker, SharedFrecency};

use crate::{format_results, SearchReq};

const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const QUERY_READ_TIMEOUT: Duration = Duration::from_secs(20);
const SCAN_TIMEOUT: Duration = Duration::from_secs(30);
const WATCHER_TIMEOUT: Duration = Duration::from_secs(10);
const WATCHDOG_TICK: Duration = Duration::from_secs(60);

/// FNV-1a — deterministic across processes (DefaultHasher is not), so client and
/// daemon agree on the socket name for a given root.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn daemons_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".tweakcc").join("fff").join("daemons"))
}

/// Wire protocol version. Bumped on any breaking change to the request/response
/// shape. Embedded in BOTH the handshake (an old daemon rejects a newer client)
/// AND the socket filename (so a post-upgrade binary opens its OWN socket instead
/// of colliding with a still-running old-format daemon that holds the old name —
/// otherwise the new daemon can't bind and the root stays cold until the old one
/// idle-times-out).
pub const PROTO: &str = "v5";

pub fn socket_path(root: &Path) -> Option<PathBuf> {
    let dir = daemons_dir()?;
    let key = format!("{:016x}", fnv1a(&root.to_string_lossy()));
    Some(dir.join(format!("{key}-{PROTO}.sock")))
}

fn encode_req(req: &SearchReq) -> String {
    use crate::Mode;
    format!(
        "{PROTO}\n{}\n{}{}{}{}{}{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
        match req.mode {
            Mode::Plain => "plain",
            Mode::Regex => "regex",
            Mode::Fuzzy => "fuzzy",
        },
        if req.files_only { "l" } else { "-" },
        if req.line_numbers { "n" } else { "-" },
        if req.count { "c" } else { "-" },
        if req.ignore_case { "i" } else { "-" },
        if req.hidden { "h" } else { "-" },
        if req.sep_between_files { "s" } else { "-" },
        req.dir_prefixes.join(","),
        req.pattern,
        req.path_prefix,
        req.before_context,
        req.after_context,
        req.include_exts.join(","),
    )
}

/// Client: try to satisfy a search via a running daemon for `root`.
/// Returns None on any error / no daemon — caller then cold-scans.
pub fn query(root: &Path, req: &SearchReq) -> Option<(String, i32)> {
    // A pattern with an embedded newline can't survive the line protocol; let
    // the cold path (which never serializes it) handle that rare case.
    if req.pattern.contains('\n')
        || req.dir_prefixes.iter().any(|d| d.contains('\n'))
    {
        return None;
    }
    let sock = socket_path(root)?;
    let mut stream = UnixStream::connect(&sock).ok()?;
    stream.set_read_timeout(Some(QUERY_READ_TIMEOUT)).ok()?;
    stream.write_all(encode_req(req).as_bytes()).ok()?;
    stream.flush().ok()?;
    stream.shutdown(Shutdown::Write).ok()?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).ok()?;
    parse_daemon_response(&resp)
}

/// Parse a daemon response: `FALLBACK\n` -> None (cold-scan), or the length-framed
/// `<exit_code>\n<byte_len>\n<body>` -> Some((body, code)). Returns None on any
/// short/garbled read (e.g. daemon killed mid-write) so the caller cold-scans
/// instead of serving a truncated, under-reporting result.
fn parse_daemon_response(resp: &str) -> Option<(String, i32)> {
    let (first, rest) = resp.split_once('\n')?;
    if first == "FALLBACK" {
        return None;
    }
    let code: i32 = first.trim().parse().ok()?;
    let (len_line, body) = rest.split_once('\n')?;
    let expected: usize = len_line.trim().parse().ok()?;
    if body.len() != expected {
        return None;
    }
    Some((body.to_string(), code))
}

/// Client: spawn a detached daemon for `root`. Best-effort, never blocks; null
/// stdio + setsid so it outlives the Claude Code Bash command that started it.
pub fn spawn_detached(root: &Path) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut cmd = Command::new(exe);
    cmd.arg("--daemon")
        .arg(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid in the child only detaches it into a new session; no shared
    // state is touched between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let _ = cmd.spawn();
}

/// Daemon entry point. Serves `root` until idle, then exits.
pub fn serve(root_arg: &str) {
    let root = match fs::canonicalize(root_arg) {
        Ok(r) => r,
        Err(_) => return,
    };
    let sock = match socket_path(&root) {
        Some(s) => s,
        None => return,
    };
    if let Some(parent) = sock.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Single daemon per root: if one already answers, step aside. The residual
    // TOCTOU between this connect() and the bind() below is benign and self-healing:
    // if two cold searches race to spawn, the last bind wins and the loser's socket
    // is unlinked, so every client reaches the live socket or cold-scans — never a
    // wrong result — and the orphaned daemon idle-times-out. A flock would close the
    // window but isn't worth it for a bounded, correctness-neutral race.
    if UnixStream::connect(&sock).is_ok() {
        return;
    }
    let _ = fs::remove_file(&sock); // clear a stale socket
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(_) => return,
    };

    let shared = SharedFilePicker::default();
    let frecency = SharedFrecency::default();
    if FilePicker::new_with_shared_state(
        shared.clone(),
        frecency.clone(),
        FilePickerOptions {
            base_path: root.to_string_lossy().into_owned(),
            mode: FFFMode::Ai,
            ..Default::default()
        },
    )
    .is_err()
    {
        let _ = fs::remove_file(&sock);
        return;
    }
    shared.wait_for_scan(SCAN_TIMEOUT);
    // The watcher must be READY before we serve, or file creates/edits made after
    // startup are missed. The accept loop below is reached only AFTER this wait, so
    // connections queued during startup are served with a ready index, and fff's
    // watcher then keeps it live (handle_create_or_modify). CAVEAT: this wait is
    // time-bounded — if a pathological watcher init TIMES OUT, the daemon proceeds
    // anyway (liveness over a hung daemon), leaving a brief window where a just-made
    // edit is missed until the watcher catches up. That is bounded and only ever
    // costs a redundant Read, never a wrong match (the scanned index is current as
    // of scan time, and any uncertainty falls back to a cold scan).
    shared.wait_for_watcher(WATCHER_TIMEOUT);

    let last = Arc::new(Mutex::new(Instant::now()));

    // Watchdog: self-terminate when idle or after the root disappears, so no
    // daemon is ever leaked. (Index freshness is the watcher's job, not ours.)
    {
        let last = last.clone();
        let sock = sock.clone();
        let root = root.clone();
        thread::spawn(move || loop {
            thread::sleep(WATCHDOG_TICK);
            let idle = last
                .lock()
                .map(|t| t.elapsed())
                .unwrap_or(Duration::ZERO);
            if idle > IDLE_TIMEOUT || !root.exists() {
                let _ = fs::remove_file(&sock);
                std::process::exit(0);
            }
        });
    }
    // (No frecency keep-alive needed: new_with_shared_state cloned the Arc into the
    // background scan thread, which owns its own refcount — the local binding is not
    // load-bearing, matching the two main.rs picker sites that just drop it.)

    for conn in listener.incoming() {
        let stream = match conn {
            Ok(s) => s,
            Err(_) => continue,
        };
        if let Ok(mut t) = last.lock() {
            *t = Instant::now();
        }
        let shared = shared.clone();
        thread::spawn(move || handle(stream, &shared));
    }
}

fn handle(stream: UnixStream, shared: &SharedFilePicker) {
    let read_half = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(read_half);
    let mut lines: Vec<String> = Vec::with_capacity(9);
    for _ in 0..9 {
        let mut l = String::new();
        match reader.read_line(&mut l) {
            Ok(0) => break,
            Ok(_) => lines.push(l.trim_end_matches('\n').to_string()),
            Err(_) => break,
        }
    }
    let mut out = stream;
    if lines.len() < 9 || lines[0] != PROTO {
        let _ = out.write_all(b"FALLBACK\n");
        return;
    }
    let flags = lines[2].as_bytes();
    let req = SearchReq {
        mode: match lines[1].as_str() {
            "regex" => crate::Mode::Regex,
            "fuzzy" => crate::Mode::Fuzzy,
            _ => crate::Mode::Plain,
        },
        files_only: flags.first() == Some(&b'l'),
        line_numbers: flags.get(1) == Some(&b'n'),
        count: flags.get(2) == Some(&b'c'),
        ignore_case: flags.get(3) == Some(&b'i'),
        hidden: flags.get(4) == Some(&b'h'),
        sep_between_files: flags.get(5) == Some(&b's'),
        dir_prefixes: if lines[3].is_empty() {
            Vec::new()
        } else {
            lines[3].split(',').map(String::from).collect()
        },
        pattern: lines[4].clone(),
        path_prefix: lines[5].clone(),
        before_context: lines[6].parse().unwrap_or(0),
        after_context: lines[7].parse().unwrap_or(0),
        include_exts: if lines[8].is_empty() {
            Vec::new()
        } else {
            lines[8].split(',').map(String::from).collect()
        },
    };

    let guard = match shared.read() {
        Ok(g) => g,
        Err(_) => {
            let _ = out.write_all(b"FALLBACK\n");
            return;
        }
    };
    let picker = match guard.as_ref() {
        Some(p) => p,
        None => {
            let _ = out.write_all(b"FALLBACK\n");
            return;
        }
    };
    match format_results(picker, &req) {
        Some((body, code)) => {
            // Length-framed: `<code>\n<byte_len>\n<body>`. The client verifies it
            // received exactly byte_len bytes — if the daemon is killed mid-write
            // (OOM/pkill), the short read is detected and the client cold-scans
            // instead of silently serving a truncated (under-reporting) result.
            let _ =
                out.write_all(format!("{code}\n{}\n", body.len()).as_bytes());
            let _ = out.write_all(body.as_bytes());
        }
        None => {
            let _ = out.write_all(b"FALLBACK\n");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_response_complete_is_served() {
        // <code>\n<len>\n<body>, len matches body byte length
        let body = "src/a.ts:1:hit\nsrc/b.ts:2:hit\n";
        let resp = format!("0\n{}\n{}", body.len(), body);
        assert_eq!(parse_daemon_response(&resp), Some((body.to_string(), 0)));
    }

    #[test]
    fn parse_response_no_match_empty_body() {
        // exit 1, empty body, len 0 — still a valid complete response
        assert_eq!(parse_daemon_response("1\n0\n"), Some((String::new(), 1)));
    }

    #[test]
    fn parse_response_fallback_is_none() {
        assert_eq!(parse_daemon_response("FALLBACK\n"), None);
    }

    #[test]
    fn parse_response_short_read_is_none() {
        // daemon killed mid-write: declared 100 bytes, only a few arrived ->
        // must reject (None) so the client cold-scans, never serve truncated.
        assert_eq!(parse_daemon_response("0\n100\nsrc/a.ts:1:hi"), None);
        // truncated before the length line at all
        assert_eq!(parse_daemon_response("0\n"), None);
        // garbled code line
        assert_eq!(parse_daemon_response("xx\n3\nabc"), None);
    }

    #[test]
    fn socket_path_embeds_proto_version() {
        // versions must never share a socket (post-upgrade collision guard)
        let p = socket_path(Path::new("/tmp/some/root")).unwrap();
        let name = p.file_name().unwrap().to_string_lossy();
        assert!(name.ends_with(&format!("-{PROTO}.sock")), "got {name}");
    }
}
