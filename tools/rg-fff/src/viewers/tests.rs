use super::learning::{capture, record_worker, Recording, MAX_OPERANDS};
use super::options::operands;
use super::selection::{eligible_mask, recognize, resolve_original, trusted_gnu, trusted_uutils};
use super::signals::SignalRelay;
use super::{Flavor, Viewer};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "fff-viewer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn parse(viewer: Viewer, flavor: Flavor, values: &[&str]) -> Option<Vec<String>> {
    operands(
        viewer,
        flavor,
        &values.iter().map(OsString::from).collect::<Vec<_>>(),
        flavor != Flavor::Bsd,
    )
    .map(|items| {
        items
            .into_iter()
            .map(|s| s.into_string().unwrap())
            .collect()
    })
}

#[test]
fn viewer_arguments_preserve_option_operands_and_stdin() {
    assert_eq!(
        parse(
            Viewer::Cat,
            Flavor::Gnu,
            &["-ns", "-", "quoted name", "--", "-filename"]
        ),
        Some(vec!["quoted name".into(), "-filename".into()])
    );
    assert_eq!(
        parse(Viewer::Head, Flavor::Gnu, &["-qn", "2", "one", "two"]),
        Some(vec!["one".into(), "two".into()])
    );
    assert_eq!(
        parse(Viewer::Head, Flavor::Gnu, &["--bytes=2KiB", "one"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Tail, Flavor::Bsd, &["-n", "+2", "one"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Sed, Flavor::Gnu, &["-ne", "1p;q", "one"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Sed, Flavor::Bsd, &["-n", "-f", "script.sed", "one"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Sed, Flavor::Gnu, &["one", "-e", "1p"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Head, Flavor::Uutils, &["one", "--lines=1K", "-z"]),
        Some(vec!["one".into()])
    );
    assert_eq!(
        parse(Viewer::Cat, Flavor::Uutils, &["-A", "one", "--show-ends"]),
        Some(vec!["one".into()])
    );
}

#[test]
fn uutils_is_trusted_only_at_its_packaged_root_owned_path() {
    let fixture = Fixture::new();
    let copy = fixture.0.join("cat");
    fs::write(&copy, b"\x7fELFuutils coreutils").unwrap();
    let metadata = fs::metadata(&copy).unwrap();
    assert!(!trusted_uutils(&copy, Viewer::Cat, &metadata));
    assert_eq!(recognize(&copy, Viewer::Cat), None);
    let packaged = Path::new("/usr/lib/cargo/bin/coreutils/cat");
    if let Ok(metadata) = fs::metadata(packaged) {
        assert!(!trusted_uutils(packaged, Viewer::Sed, &metadata));
        assert_eq!(
            recognize(Path::new("/usr/bin/cat"), Viewer::Cat),
            Some(Flavor::Uutils)
        );
    }
}

#[test]
fn ambiguous_mutating_follow_zero_and_multi_input_sed_skip_learning() {
    for (viewer, args) in [
        (Viewer::Cat, vec!["--help", "one"]),
        (Viewer::Head, vec!["-n0", "one"]),
        (Viewer::Head, vec!["-n", "-2", "one"]),
        (Viewer::Tail, vec!["-n+0", "one"]),
        (Viewer::Tail, vec!["-f", "one"]),
        (Viewer::Sed, vec!["-i", "s/x/y/", "one"]),
        (Viewer::Sed, vec!["-n", "1p;q", "one", "two"]),
        (Viewer::Sed, vec!["-e"]),
    ] {
        assert_eq!(
            parse(viewer, Flavor::Gnu, &args),
            None,
            "{viewer:?}: {args:?}"
        );
    }
    assert_eq!(parse(Viewer::Cat, Flavor::Bsd, &["--number", "one"]), None);
    assert_eq!(parse(Viewer::Head, Flavor::Bsd, &["-n", "2K", "one"]), None);
}

#[test]
fn bsd_and_posix_option_order_does_not_permute_file_names() {
    assert_eq!(
        parse(Viewer::Cat, Flavor::Bsd, &["one", "-n"]),
        Some(vec!["one".into(), "-n".into()])
    );
    let args = [OsString::from("one"), OsString::from("-n")];
    assert_eq!(
        operands(Viewer::Cat, Flavor::Gnu, &args, false),
        Some(args.to_vec())
    );
}

#[test]
fn capture_deduplicates_and_excludes_foreign_nonregular_and_non_utf8_files() {
    let fixture = Fixture::new();
    let root = fixture.0.join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("empty"), "").unwrap();
    fs::write(root.join("ž file"), "content").unwrap();
    fs::write(fixture.0.join("foreign"), "content").unwrap();
    symlink(fixture.0.join("foreign"), root.join("escape")).unwrap();
    let invalid = OsString::from_vec(vec![b'b', 0xff]);
    if let Err(error) = fs::write(root.join(&invalid), "content") {
        assert!(cfg!(target_os = "macos") && error.raw_os_error() == Some(libc::EILSEQ));
    }
    let files = ["empty", "empty", "ž file", "escape", "."].map(OsString::from);
    let root = fs::canonicalize(root).unwrap();
    let mut inputs = files.to_vec();
    inputs.push(invalid);
    let receipts = capture(&inputs, &root, &root);
    assert_eq!(receipts.len(), 2);
    assert!(receipts.iter().any(|r| r.path.ends_with("empty")));
    assert!(capture(
        &vec![OsString::from("empty"); MAX_OPERANDS + 1],
        &root,
        &root
    )
    .is_empty());
}

#[test]
fn worker_completes_matching_queries_and_separates_navigation_sessions() {
    if std::env::var_os("RG_FFF_VIEWER_TEST_WORKER").is_none() {
        let fixture = Fixture::new();
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "viewers::tests::worker_completes_matching_queries_and_separates_navigation_sessions", "--nocapture"])
            .env("RG_FFF_VIEWER_TEST_WORKER", "1")
            .env("RG_FFF_STATE_DIR", fixture.0.join("state"))
            .env("RG_FFF_NO_DAEMON", "1")
            .status().unwrap();
        assert!(status.success());
        return;
    }
    let fixture = Fixture::new();
    let root = fs::canonicalize(&fixture.0).unwrap();
    let cwd = root.join("src");
    fs::create_dir(&cwd).unwrap();
    let path = cwd.join("source.rs");
    fs::write(&path, "synthetic needle\n").unwrap();
    let mut request =
        crate::parse(crate::Tool::Rg, vec!["needle".into()]).to_req(crate::Mode::Plain);
    request.session = "synthetic-bash-process".into();
    crate::feedback::remember_files(
        &root,
        &request.pattern,
        &request.session,
        &["src/source.rs".into()],
    );
    let record = Recording {
        cwd: cwd.clone(),
        root: root.clone(),
        session: "synthetic-live-session".into(),
        receipt_session: request.session,
        files: capture(&[OsString::from("source.rs")], &cwd, &root),
    };
    record_worker(&serde_json::to_string(&record).unwrap());
    assert_eq!(crate::feedback::preferred(&root, "needle"), Some(path));
    assert_eq!(
        crate::navigation::pointers(&root, &record.session),
        vec!["src/source.rs"]
    );
    assert!(crate::navigation::pointers(&root, "synthetic-other-session").is_empty());
    let alias = cwd.join("alias.rs");
    symlink(cwd.join("source.rs"), &alias).unwrap();
    let stale = Recording {
        cwd: cwd.clone(),
        root: root.clone(),
        session: "synthetic-race-session".into(),
        receipt_session: "synthetic-race-process".into(),
        files: capture(&[OsString::from("alias.rs")], &cwd, &root),
    };
    fs::write(cwd.join("replacement.rs"), "replacement\n").unwrap();
    fs::remove_file(&alias).unwrap();
    symlink(cwd.join("replacement.rs"), &alias).unwrap();
    record_worker(&serde_json::to_string(&stale).unwrap());
    assert!(crate::navigation::pointers(&root, &stale.session).is_empty());
    unsafe {
        libc::signal(libc::SIGCHLD, libc::SIG_IGN);
    }
    let relay = SignalRelay::install().unwrap();
    let child = relay
        .command(
            Path::new("/bin/sh"),
            &[OsString::from("-c"), OsString::from("exit 7")],
            OsStr::new("sh"),
        )
        .spawn()
        .unwrap();
    relay.attach(&child);
    assert_eq!(relay.wait(&child).unwrap().code(), Some(7));
    drop(relay);
    let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigaction(libc::SIGCHLD, std::ptr::null(), &mut action);
    }
    assert_eq!(action.sa_sigaction, libc::SIG_IGN);
}

#[test]
fn path_resolution_handles_relative_empty_and_duplicate_proxy_entries() {
    let fixture = Fixture::new();
    let proxy = fixture.0.join("proxy");
    let bin = fixture.0.join("bin");
    fs::create_dir(&proxy).unwrap();
    fs::create_dir(&bin).unwrap();
    let image = fixture.0.join("image");
    fs::write(&image, "proxy").unwrap();
    fs::set_permissions(&image, fs::Permissions::from_mode(0o755)).unwrap();
    symlink(&image, proxy.join("cat")).unwrap();
    fs::write(bin.join("cat"), "native").unwrap();
    fs::set_permissions(bin.join("cat"), fs::Permissions::from_mode(0o755)).unwrap();
    let path = std::env::join_paths([&proxy, &proxy, Path::new("bin")]).unwrap();
    let resolved = resolve_original(Viewer::Cat, &path, Some(&proxy), &image, &fixture.0).unwrap();
    assert_eq!(resolved, PathBuf::from("bin/cat"));
    let path = std::env::join_paths([&proxy, Path::new("")]).unwrap();
    fs::write(fixture.0.join("cat"), "native").unwrap();
    fs::set_permissions(fixture.0.join("cat"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        resolve_original(Viewer::Cat, &path, Some(&proxy), &image, &fixture.0).unwrap(),
        PathBuf::from("./cat")
    );
}

#[test]
fn custom_scripts_and_untrusted_images_are_not_probed_or_learned() {
    let fixture = Fixture::new();
    let path = fixture.0.join("cat");
    fs::write(&path, b"#!/bin/sh\necho GNU coreutils\n").unwrap();
    assert_eq!(recognize(&path, Viewer::Cat), None);
    fs::write(&path, b"\x7fELFGNU coreutils").unwrap();
    assert_eq!(recognize(&path, Viewer::Cat), None);
    assert!(trusted_gnu(
        Path::new("/opt/homebrew/Cellar/coreutils/9.12/bin/gcat"),
        Viewer::Cat
    ));
    assert!(trusted_gnu(
        Path::new("/nix/store/hash-gnused-4.9/bin/sed"),
        Viewer::Sed
    ));
    assert!(!trusted_gnu(Path::new("/usr/local/bin/cat"), Viewer::Cat));
}

#[test]
fn mask_omits_custom_viewers_and_paths_that_can_change_after_cd() {
    let fixture = Fixture::new();
    let image = std::env::current_exe().unwrap();
    let base = OsStr::new("/bin:/usr/bin");
    let native = eligible_mask(base, None, &image, &fixture.0);
    assert_eq!(native, 15);
    for search in [
        OsStr::new(":/bin:/usr/bin"),
        OsStr::new("relative:/bin:/usr/bin"),
    ] {
        assert_eq!(eligible_mask(search, None, &image, &fixture.0), 0);
    }
    assert_eq!(
        eligible_mask(OsStr::new("/bin:/usr/bin:"), None, &image, &fixture.0),
        native
    );
    let custom = fixture.0.join("custom");
    fs::create_dir(&custom).unwrap();
    fs::write(custom.join("cat"), "printf custom\\n\n").unwrap();
    fs::set_permissions(custom.join("cat"), fs::Permissions::from_mode(0o700)).unwrap();
    let search = std::env::join_paths([&custom, Path::new("/bin"), Path::new("/usr/bin")]).unwrap();
    assert_eq!(
        eligible_mask(&search, None, &image, &fixture.0),
        native & !1
    );
    let proxy = fixture.0.join("proxy");
    fs::create_dir(&proxy).unwrap();
    for viewer in ["cat", "head", "tail", "sed"] {
        symlink(&image, proxy.join(viewer)).unwrap();
    }
    let search =
        std::env::join_paths([&proxy, &proxy, Path::new("/bin"), Path::new("/usr/bin")]).unwrap();
    assert_eq!(
        eligible_mask(&search, Some(&proxy), &image, &fixture.0),
        native
    );
    assert_eq!(eligible_mask(&search, None, &image, &fixture.0), native);
}
