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
//!   v4
//!   plain|regex|fuzzy
//!   flags: files_only(l) line_numbers(n) count(c) ignore_case(i) hidden(h)
//!          sep_between_files(s) — each char or '-'    e.g. "-n--hs"
//!   <dir_prefixes comma-joined, e.g. "app/,lib/" or empty=cwd>
//!   <pattern>
//!   <path_prefix>
//!   <before_context>
//!   <after_context>
//!   <include_exts comma-joined, e.g. ".ts,.tsx" or empty>
//! Response (daemon -> client): first line is the exit code, or the literal
//! "FALLBACK" (daemon can't serve -> client cold-scans); the rest is the output.
//! The version tag ("v3") makes an older daemon reject a newer client cleanly.

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

pub fn socket_path(root: &Path) -> Option<PathBuf> {
    let dir = daemons_dir()?;
    let key = format!("{:016x}", fnv1a(&root.to_string_lossy()));
    Some(dir.join(format!("{key}.sock")))
}

fn encode_req(req: &SearchReq) -> String {
    use crate::Mode;
    format!(
        "v4\n{}\n{}{}{}{}{}{}\n{}\n{}\n{}\n{}\n{}\n{}\n",
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
    let (first, rest) = resp.split_once('\n')?;
    if first == "FALLBACK" {
        return None;
    }
    let code: i32 = first.trim().parse().ok()?;
    Some((rest.to_string(), code))
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
    // Single daemon per root: if one already answers, step aside.
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
    // The watcher must be READY before we serve, or file creates/edits made
    // after startup are missed and the daemon would return staler results than a
    // cold scan (silent wrong results). fff's watcher then keeps the index live
    // (handle_create_or_modify), so the daemon is never staler than reality.
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
    let _ = &frecency; // kept alive for the picker's lifetime

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
    if lines.len() < 9 || lines[0] != "v4" {
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
            let _ = out.write_all(format!("{code}\n").as_bytes());
            let _ = out.write_all(body.as_bytes());
        }
        None => {
            let _ = out.write_all(b"FALLBACK\n");
        }
    }
}
