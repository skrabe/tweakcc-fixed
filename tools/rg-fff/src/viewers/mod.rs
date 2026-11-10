mod learning;
mod options;
mod selection;
mod signals;
#[cfg(test)]
mod tests;

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::time::Duration;

use learning::{record_worker, recording};
use options::operands;
use selection::{eligible_mask, recognize, resolve_original};
use signals::{execute_original, record_bounded, restore_pipe, terminate, SignalRelay};

const RECORD_TIMEOUT: Duration = Duration::from_millis(250);
const WORKER_FLAG: &str = "--record-viewer-reads";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Viewer {
    Cat,
    Head,
    Tail,
    Sed,
}

impl Viewer {
    fn from_name(name: &OsStr) -> Option<Self> {
        match name.as_bytes() {
            b"cat" => Some(Self::Cat),
            b"head" => Some(Self::Head),
            b"tail" => Some(Self::Tail),
            b"sed" => Some(Self::Sed),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Cat => "cat",
            Self::Head => "head",
            Self::Tail => "tail",
            Self::Sed => "sed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Flavor {
    Gnu,
    Bsd,
    // uutils accepts GNU's option grammar but permutes even under POSIXLY_CORRECT.
    Uutils,
}

impl Flavor {
    fn gnu_syntax(self) -> bool {
        self != Self::Bsd
    }
}

pub fn dispatch() -> bool {
    let args: Vec<OsString> = std::env::args_os().collect();
    let Some(argv0) = args.first() else {
        return false;
    };
    let name = Path::new(argv0).file_name().unwrap_or(argv0);
    if matches!(name.as_bytes(), b"rg-fff" | b"fff")
        && args.get(1).is_some_and(|s| s == "--viewer-mask")
    {
        if std::thread::Builder::new()
            .spawn(|| {
                std::thread::sleep(RECORD_TIMEOUT);
                unsafe {
                    libc::write(libc::STDOUT_FILENO, b"0\n".as_ptr().cast(), 2);
                    libc::_exit(0);
                }
            })
            .is_err()
        {
            println!("0");
            return true;
        }
        let mask = std::env::current_dir().ok().map_or(0, |cwd| {
            let image = std::env::current_exe().unwrap_or_else(|_| PathBuf::from(argv0));
            let search_path =
                std::env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
            let proxy = std::env::var_os("RG_FFF_VIEWER_DIR").map(PathBuf::from);
            eligible_mask(&search_path, proxy.as_deref(), &image, &cwd)
        });
        println!("{mask}");
        return true;
    }
    if matches!(name.as_bytes(), b"rg-fff" | b"fff")
        && args.get(1).is_some_and(|s| s == WORKER_FLAG)
    {
        if let Some(payload) = args.get(2).and_then(|s| s.to_str()) {
            record_worker(payload);
        }
        return true;
    }
    let Some(viewer) = Viewer::from_name(name) else {
        return false;
    };
    restore_pipe();
    let cwd = match std::env::current_dir() {
        Ok(cwd) => cwd,
        Err(error) => {
            eprintln!("{}: {error}", viewer.name());
            std::process::exit(126);
        }
    };
    let image = std::env::current_exe().unwrap_or_else(|_| PathBuf::from(argv0));
    let search_path = std::env::var_os("PATH").unwrap_or_else(|| OsString::from("/usr/bin:/bin"));
    let proxy = std::env::var_os("RG_FFF_VIEWER_DIR").map(PathBuf::from);
    let original = match resolve_original(viewer, &search_path, proxy.as_deref(), &image, &cwd) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{}: {error}", viewer.name());
            std::process::exit(if error.raw_os_error() == Some(libc::ENOENT) {
                127
            } else {
                126
            });
        }
    };
    let record = recognize(&original, viewer).and_then(|flavor| {
        let permute = match flavor {
            Flavor::Gnu => std::env::var_os("POSIXLY_CORRECT").is_none(),
            Flavor::Uutils => true,
            Flavor::Bsd => false,
        };
        operands(viewer, flavor, &args[1..], permute).and_then(|files| recording(&files, &cwd))
    });
    let Some(record) = record else {
        execute_original(&original, &args[1..], argv0);
    };
    let relay = match SignalRelay::install() {
        Ok(relay) => relay,
        Err(_) => execute_original(&original, &args[1..], argv0),
    };
    let child = match relay.command(&original, &args[1..], argv0).spawn() {
        Ok(child) => child,
        Err(_) => {
            drop(relay);
            execute_original(&original, &args[1..], argv0);
        }
    };
    relay.attach(&child);
    let status = match relay.wait(&child) {
        Ok(status) => status,
        Err(_) => {
            let mut child = child;
            let _ = child.kill();
            child
                .wait()
                .unwrap_or_else(|_| ExitStatus::from_raw(1 << 8))
        }
    };
    if status.success() && relay.cancelled().is_none() {
        record_bounded(&record, &image, &relay);
    }
    let cancelled = relay.cancelled();
    drop(relay);
    terminate(status, cancelled)
}
