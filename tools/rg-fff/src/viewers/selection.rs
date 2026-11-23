use std::ffi::{CString, OsStr};
use std::fs;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use super::{Flavor, Viewer};

const MAX_IMAGE: u64 = 8 * 1024 * 1024;

fn executable(path: &Path) -> bool {
    let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    fs::metadata(path).is_ok_and(|m| m.is_file())
        && unsafe { libc::access(name.as_ptr(), libc::X_OK) == 0 }
}

pub(super) fn resolve_original(
    viewer: Viewer,
    search_path: &OsStr,
    proxy_dir: Option<&Path>,
    image: &Path,
    cwd: &Path,
) -> io::Result<PathBuf> {
    original_selection(viewer, search_path, proxy_dir, image, cwd).map(|(path, _)| path)
}

fn original_selection(
    viewer: Viewer,
    search_path: &OsStr,
    proxy_dir: Option<&Path>,
    image: &Path,
    cwd: &Path,
) -> io::Result<(PathBuf, bool)> {
    let proxy_dir = proxy_dir.and_then(|p| fs::canonicalize(p).ok());
    let image = fs::metadata(image).ok().map(|m| (m.dev(), m.ino()));
    let mut denied = false;
    let mut stable = true;
    for directory in std::env::split_paths(search_path) {
        stable &= directory.is_absolute();
        let absolute = cwd.join(&directory);
        if proxy_dir
            .as_ref()
            .is_some_and(|p| fs::canonicalize(&absolute).ok().as_ref() == Some(p))
        {
            continue;
        }
        let candidate = if directory.as_os_str().is_empty() {
            Path::new(".").join(viewer.name())
        } else {
            directory.join(viewer.name())
        };
        let absolute = cwd.join(&candidate);
        if let Ok(metadata) = fs::metadata(&absolute) {
            if image == Some((metadata.dev(), metadata.ino())) {
                continue;
            }
            if executable(&absolute) {
                return Ok((candidate, stable));
            }
            denied = true;
        }
    }
    Err(io::Error::from_raw_os_error(if denied {
        libc::EACCES
    } else {
        libc::ENOENT
    }))
}

pub(super) fn eligible_mask(
    search_path: &OsStr,
    proxy_dir: Option<&Path>,
    image: &Path,
    cwd: &Path,
) -> u8 {
    [Viewer::Cat, Viewer::Head, Viewer::Tail, Viewer::Sed]
        .into_iter()
        .enumerate()
        .fold(0, |mask, (bit, viewer)| {
            if original_selection(viewer, search_path, proxy_dir, image, cwd)
                .ok()
                .is_some_and(|(path, stable)| stable && recognize(&path, viewer).is_some())
            {
                mask | (1 << bit)
            } else {
                mask
            }
        })
}

fn native_image(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x7fELF")
        || matches!(
            bytes.get(..4),
            Some(
                b"\xfe\xed\xfa\xce"
                    | b"\xce\xfa\xed\xfe"
                    | b"\xfe\xed\xfa\xcf"
                    | b"\xcf\xfa\xed\xfe"
                    | b"\xca\xfe\xba\xbe"
                    | b"\xbe\xba\xfe\xca"
                    | b"\xca\xfe\xba\xbf"
                    | b"\xbf\xba\xfe\xca"
            )
        )
}

pub(super) fn trusted_gnu(path: &Path, viewer: Viewer) -> bool {
    let Some(name) = path.file_name().and_then(OsStr::to_str) else {
        return false;
    };
    if name != viewer.name() && name != format!("g{}", viewer.name()) {
        return false;
    }
    if path
        .parent()
        .is_some_and(|p| p == Path::new("/bin") || p == Path::new("/usr/bin"))
    {
        return true;
    }
    let package = if viewer == Viewer::Sed {
        "gnu-sed"
    } else {
        "coreutils"
    };
    for base in [
        "/opt/homebrew/Cellar",
        "/usr/local/Cellar",
        "/home/linuxbrew/.linuxbrew/Cellar",
    ] {
        if path
            .strip_prefix(Path::new(base).join(package))
            .ok()
            .is_some_and(|p| {
                let parts: Vec<_> = p.components().collect();
                parts.len() == 3 && parts[1].as_os_str() == "bin"
            })
        {
            return true;
        }
    }
    for base in ["/nix/store", "/gnu/store"] {
        if path.strip_prefix(base).ok().is_some_and(|p| {
            let parts: Vec<_> = p.components().collect();
            let Some(package_name) = parts.first().and_then(|p| p.as_os_str().to_str()) else {
                return false;
            };
            let expected = if viewer == Viewer::Sed {
                "-gnused-"
            } else {
                "-coreutils-"
            };
            parts.len() == 3 && parts[1].as_os_str() == "bin" && package_name.contains(expected)
        }) {
            return true;
        }
    }
    false
}

// Ubuntu 25.10+ links cat/head/tail to one ~10 MB uutils multicall image, too
// large to scan per call, so trust rests on its root-owned packaged path.
pub(super) fn trusted_uutils(path: &Path, viewer: Viewer, metadata: &fs::Metadata) -> bool {
    viewer != Viewer::Sed
        && path == Path::new("/usr/lib/cargo/bin/coreutils").join(viewer.name())
        && metadata.uid() == 0
        && metadata.mode() & 0o022 == 0
}

pub(super) fn recognize(path: &Path, viewer: Viewer) -> Option<Flavor> {
    let path = fs::canonicalize(path).ok()?;
    let metadata = fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    if trusted_uutils(&path, viewer, &metadata) {
        let mut header = [0; 4];
        fs::File::open(&path).ok()?.read_exact(&mut header).ok()?;
        return native_image(&header).then_some(Flavor::Uutils);
    }
    if metadata.len() > MAX_IMAGE {
        return None;
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)
        .ok()?
        .take(MAX_IMAGE + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_IMAGE || !native_image(&bytes) {
        return None;
    }
    let marker: &[u8] = if viewer == Viewer::Sed {
        b"GNU sed"
    } else {
        b"GNU coreutils"
    };
    if trusted_gnu(&path, viewer) && bytes.windows(marker.len()).any(|window| window == marker) {
        return Some(Flavor::Gnu);
    }
    if cfg!(target_os = "macos") {
        let system = if viewer == Viewer::Cat {
            PathBuf::from("/bin/cat")
        } else {
            PathBuf::from("/usr/bin").join(viewer.name())
        };
        if path == system {
            return Some(Flavor::Bsd);
        }
    }
    None
}
