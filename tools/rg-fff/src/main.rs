//! rg-fff — a multicall search front end backed by `fff` (fast file finder),
//! transparently replacing Claude Code's embedded `ugrep`/`bfs`/ripgrep for
//! content/file search, with a re-exec fallback to the real embedded tool.
//!
//! Claude Code shadows the shell `grep`/`find` with its embedded `ugrep`/`bfs`
//! (and offers `rg` separately). We get installed in their place and dispatch on
//! argv0:
//!   * argv0 = ugrep | grep   -> fff content search (literal), else embedded ugrep
//!   * argv0 = rg             -> fff content search (literal), else embedded rg
//!   * argv0 = bfs  | find    -> embedded bfs (fff find_files is a roadmap item)
//!   * argv0 = fff            -> explicit fff content search (+ --fuzzy)
//!
//! Output impersonates the tool the model invoked (grep/rg-style PATH:LINE:TEXT),
//! ranked by fff. Fallback re-execs the real embedded tool via the claude binary
//! (argv0 multicall), so nothing is ever silently lost.

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use fff_search::file_picker::FilePicker;
use fff_search::{
    AiGrepConfig, FFFMode, FilePickerOptions, GrepMode, GrepSearchOptions,
    QueryParser, SharedFilePicker, SharedFrecency,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tool {
    Ugrep, // grep shadow
    Rg,    // ripgrep
    Bfs,   // find shadow
    Fff,   // explicit
}

impl Tool {
    fn from_argv0(a0: &str) -> Tool {
        let base = Path::new(a0)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(a0);
        match base {
            "ugrep" | "grep" => Tool::Ugrep,
            "rg" => Tool::Rg,
            "bfs" | "find" => Tool::Bfs,
            _ => Tool::Fff, // "fff", "rg-fff", anything else
        }
    }
    /// The argv0 to use when re-execing the real embedded tool.
    fn embedded_argv0(self) -> &'static str {
        match self {
            Tool::Ugrep => "ugrep",
            Tool::Rg => "rg",
            Tool::Bfs => "bfs",
            Tool::Fff => "rg",
        }
    }
}

struct Opts {
    tool: Tool,
    raw: Vec<String>, // every arg after argv0 (for verbatim fallback)
    pattern: Option<String>,
    paths: Vec<String>,
    ignore_case: bool,
    line_numbers: bool, // emit PATH:LINE:TEXT vs PATH:TEXT
    files_only: bool,   // -l
    count: bool,        // -c
    recursive: bool,    // -r / -R (grep)
    fuzzy: bool,        // --fuzzy (fff explicit)
    // any flag that means "fff cannot fof-this faithfully" -> fall back
    force_fallback: bool,
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let a0 = argv.first().cloned().unwrap_or_default();
    let tool = Tool::from_argv0(&a0);
    let raw: Vec<String> = argv[1..].to_vec();

    // --version / -V: impersonate the real tool exactly (re-exec embedded).
    if raw.iter().any(|a| a == "--version" || a == "-V") {
        fallback(tool, &raw); // never returns
    }

    // find/bfs: fff find_files is a roadmap item; for now route to embedded bfs.
    if tool == Tool::Bfs {
        fallback(tool, &raw);
    }

    let opts = parse(tool, raw);
    if eligible(&opts) {
        let code = run_fff(&opts);
        std::process::exit(code);
    }
    fallback(opts.tool, &opts.raw);
}

/// Parse grep/ugrep/rg/fff argv into our decision struct. Conservative: anything
/// we don't confidently understand sets force_fallback so we defer to the real
/// tool rather than return a wrong result.
fn parse(tool: Tool, raw: Vec<String>) -> Opts {
    let mut o = Opts {
        tool,
        raw: raw.clone(),
        pattern: None,
        paths: Vec::new(),
        ignore_case: false,
        // grep emits PATH:LINE:TEXT only with -n; rg/fff default to line numbers.
        line_numbers: !matches!(tool, Tool::Ugrep),
        files_only: false,
        count: false,
        recursive: false,
        fuzzy: false,
        force_fallback: false,
    };
    let mut explicit_pattern: Option<String> = None;
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let a = &raw[i];
        match a.as_str() {
            "--fuzzy" => o.fuzzy = true,
            "-i" | "--ignore-case" => o.ignore_case = true,
            "-l" | "--files-with-matches" | "-L" | "--files-without-match" => {
                o.files_only = true;
                if a == "-L" || a == "--files-without-match" {
                    o.force_fallback = true; // inverse — fff can't do
                }
            }
            "-c" | "--count" => o.count = true,
            "-n" | "--line-number" => o.line_numbers = true,
            "-h" | "--no-filename" | "-H" | "--with-filename" | "--color"
            | "--color=never" | "--color=always" | "--color=auto" => {}
            "-r" | "-R" | "--recursive" | "--dereference-recursive" => {
                o.recursive = true
            }
            // CC-injected ugrep flags — fff already honors ignores/hidden/binary.
            "-G" | "--basic-regexp" | "--ignore-files" | "--hidden" | "-I"
            | "--no-ignore" | "--include-dir" => {}
            // capability gaps fff can't faithfully serve -> defer to real tool.
            "-P" | "--perl-regexp" | "-E" | "--extended-regexp" | "-o"
            | "--only-matching" | "-v" | "--invert-match" | "-x"
            | "--line-regexp" | "-w" | "--word-regexp" | "-z" | "--null-data"
            | "-U" | "--multiline" | "--multiline-dotall" | "-f" | "--file"
            | "-A" | "--after-context" | "-B" | "--before-context" | "-C"
            | "--context" | "-m" | "--max-count" | "-t" | "--type" => {
                o.force_fallback = true;
                // value-taking ones: skip their value too
                if matches!(
                    a.as_str(),
                    "-f" | "--file"
                        | "-A"
                        | "--after-context"
                        | "-B"
                        | "--before-context"
                        | "-C"
                        | "--context"
                        | "-m"
                        | "--max-count"
                        | "-t"
                        | "--type"
                ) {
                    i += 1;
                }
            }
            "-e" | "--regexp" | "--pattern" => {
                if i + 1 < raw.len() {
                    explicit_pattern = Some(raw[i + 1].clone());
                    i += 1;
                }
            }
            "--exclude-dir" | "--exclude" | "--include" | "-g" | "--glob" => {
                // value-taking; skip value. (exclude-dir is CC's VCS list, fine.)
                if i + 1 < raw.len() {
                    i += 1;
                }
            }
            other => {
                if let Some(rest) = other.strip_prefix("--exclude-dir=") {
                    let _ = rest; // CC VCS excludes — fff handles ignores
                } else if other.starts_with("--exclude=")
                    || other.starts_with("--include=")
                    || other.starts_with("--color=")
                {
                    // glob filters -> defer (fff constraint translation is lossy)
                    if other.starts_with("--exclude=")
                        || other.starts_with("--include=")
                    {
                        o.force_fallback = true;
                    }
                } else if let Some(combined) = other.strip_prefix('-') {
                    if combined.is_empty() {
                        positionals.push(other.to_string()); // lone "-" (stdin)
                        o.force_fallback = true;
                    } else if combined.starts_with('-') {
                        // unknown long flag -> tolerate (don't crash), but if it
                        // could change semantics, be safe: defer.
                        o.force_fallback = true;
                    } else {
                        // bundled short flags like -rn, -ri, -rln
                        for ch in combined.chars() {
                            match ch {
                                'i' => o.ignore_case = true,
                                'n' => o.line_numbers = true,
                                'l' => o.files_only = true,
                                'c' => o.count = true,
                                'r' | 'R' => o.recursive = true,
                                'H' | 'h' | 'I' | 'G' => {}
                                'w' | 'o' | 'v' | 'x' | 'E' | 'P' | 'F'
                                | 'z' | 'U' => o.force_fallback = true,
                                _ => o.force_fallback = true,
                            }
                        }
                    }
                } else {
                    positionals.push(other.to_string());
                }
            }
        }
        i += 1;
    }

    if let Some(p) = explicit_pattern {
        o.pattern = Some(p);
        o.paths = positionals;
    } else if !positionals.is_empty() {
        o.pattern = Some(positionals.remove(0));
        o.paths = positionals;
    }
    o
}

/// fff serves a query only when its result is faithfully tool-equivalent.
fn eligible(o: &Opts) -> bool {
    if o.force_fallback {
        return false;
    }
    let pat = match &o.pattern {
        Some(p) if !p.is_empty() => p,
        _ => return false,
    };
    // Explicit fff/fuzzy always serves; otherwise require plain literal ASCII.
    if !o.fuzzy {
        if has_regex_meta(pat) {
            return false; // regex -> the real tool does it right
        }
        if pat.chars().count() < 3 {
            return false; // bigram prefilter unreliable on sub-3-char
        }
    }
    if !pat.is_ascii() {
        return false;
    }
    if o.ignore_case {
        return false; // case-insensitive -> defer (preserve exact semantics)
    }
    // path target: default cwd, or a single dir. A single file or multiple
    // paths -> defer (grep/ugrep handle those precisely; fff is tree-oriented).
    match o.paths.len() {
        0 => true,
        1 => {
            let p = &o.paths[0];
            // grep without -r on a dir errors; with -r or a dir, fff is right.
            Path::new(p).is_dir()
        }
        _ => false,
    }
}

/// Regex-metacharacter test mirroring fff's `regex::escape(t) != t`.
fn has_regex_meta(t: &str) -> bool {
    t.chars().any(|c| {
        matches!(
            c,
            '\\' | '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{'
                | '}' | '^' | '$' | '#' | '&' | '-' | '~'
        )
    })
}

/// Run fff and emit tool-compatible output. Returns process exit code.
fn run_fff(o: &Opts) -> i32 {
    let base = ".".to_string();
    let mode = if o.fuzzy {
        GrepMode::Fuzzy
    } else {
        GrepMode::PlainText
    };

    let shared_picker = SharedFilePicker::default();
    let shared_frecency = SharedFrecency::default();
    if FilePicker::new_with_shared_state(
        shared_picker.clone(),
        shared_frecency.clone(),
        FilePickerOptions {
            base_path: base.into(),
            mode: FFFMode::Ai,
            ..Default::default()
        },
    )
    .is_err()
    {
        fallback(o.tool, &o.raw);
    }
    shared_picker.wait_for_scan(Duration::from_secs(15));
    let guard = match shared_picker.read() {
        Ok(g) => g,
        Err(_) => fallback(o.tool, &o.raw),
    };
    let picker = match guard.as_ref() {
        Some(p) => p,
        None => fallback(o.tool, &o.raw),
    };

    // Build the fff query: a dir path becomes a constraint so emitted paths stay
    // cwd-relative (matching grep -r <dir> output).
    let pattern = o.pattern.clone().unwrap_or_default();
    let mut query = String::new();
    if let Some(dir) = o.paths.first() {
        let d = dir.trim_end_matches('/');
        if !d.is_empty() && d != "." {
            query.push_str(d);
            query.push('/');
            query.push(' ');
        }
    }
    query.push_str(&pattern);

    let parser = QueryParser::new(AiGrepConfig);
    let parsed = parser.parse(&query);

    use std::io::Write;
    let out = std::io::stdout();
    let mut w = std::io::BufWriter::new(out.lock());

    // count mode: per-file match counts (file:count)
    if o.count {
        let mut any = false;
        let mut file_offset = 0usize;
        let mut counts: std::collections::BTreeMap<String, usize> =
            std::collections::BTreeMap::new();
        loop {
            let opts = grep_opts(mode, file_offset, false);
            let r = picker.grep(&parsed, &opts);
            for m in &r.matches {
                let f = r.files[m.file_index];
                *counts.entry(f.relative_path(picker)).or_insert(0) += 1;
            }
            if r.next_file_offset == 0 {
                break;
            }
            file_offset = r.next_file_offset;
        }
        for (f, c) in &counts {
            let _ = writeln!(w, "{f}:{c}");
            any = true;
        }
        let _ = w.flush();
        return if any { 0 } else { 1 };
    }

    let mut any = false;
    let mut file_offset = 0usize;
    loop {
        let opts = grep_opts(mode, file_offset, o.files_only);
        let result = picker.grep(&parsed, &opts);

        if o.files_only {
            for f in &result.files {
                let _ = writeln!(w, "{}", f.relative_path(picker));
                any = true;
            }
        } else {
            for m in &result.matches {
                let f = result.files[m.file_index];
                if o.line_numbers {
                    let _ = writeln!(
                        w,
                        "{}:{}:{}",
                        f.relative_path(picker),
                        m.line_number,
                        m.line_content
                    );
                } else {
                    let _ = writeln!(
                        w,
                        "{}:{}",
                        f.relative_path(picker),
                        m.line_content
                    );
                }
                any = true;
            }
        }
        if o.fuzzy || result.next_file_offset == 0 {
            break;
        }
        file_offset = result.next_file_offset;
    }
    let _ = w.flush();
    if any {
        0
    } else {
        1
    }
}

fn grep_opts(mode: GrepMode, file_offset: usize, files_only: bool) -> GrepSearchOptions {
    GrepSearchOptions {
        max_file_size: 10 * 1024 * 1024,
        max_matches_per_file: if files_only { 1 } else { 1_000_000 },
        smart_case: false,
        file_offset,
        page_limit: 1_000_000,
        mode,
        time_budget_ms: 0,
        before_context: 0,
        after_context: 0,
        classify_definitions: false,
        trim_whitespace: false,
        abort_signal: None,
    }
}

/// Re-exec the real embedded tool via the claude binary (argv0 multicall).
/// Never returns.
fn fallback(tool: Tool, args: &[String]) -> ! {
    use std::os::unix::process::CommandExt;

    let claude = std::env::var("CLAUDE_CODE_EXECPATH")
        .ok()
        .filter(|p| Path::new(p).exists())
        .or_else(|| {
            let h = std::env::var("HOME").ok()?;
            let p = format!("{h}/.local/bin/claude");
            if Path::new(&p).exists() {
                Some(p)
            } else {
                None
            }
        });

    let a0 = tool.embedded_argv0();
    if let Some(bin) = claude {
        let mut cmd = Command::new(&bin);
        // embedded ripgrep expects --no-config; ugrep/bfs take args as-is.
        if tool == Tool::Rg && !args.iter().any(|a| a == "--no-config") {
            cmd.arg("--no-config");
        }
        cmd.args(args);
        cmd.arg0(a0);
        let err = cmd.exec();
        eprintln!("rg-fff: failed to exec embedded {a0}: {err}");
    }
    // last resort: the system tool on PATH
    let sys = match tool {
        Tool::Bfs => "find",
        Tool::Ugrep => "grep",
        _ => "rg",
    };
    let err = Command::new(sys).args(args).exec();
    eprintln!("rg-fff: failed to exec {sys}: {err}");
    std::process::exit(2);
}
