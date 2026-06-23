//! rg-fff — a multicall search front end backed by `fff` (fast file finder),
//! transparently replacing Claude Code's embedded `ugrep`/`bfs`/ripgrep for
//! content/file search, with a re-exec fallback to the real embedded tool.
//!
//! Claude Code shadows the shell `grep`/`find` with its embedded `ugrep`/`bfs`
//! (and offers `rg` separately). We get installed in their place and dispatch on
//! argv0:
//!   * argv0 = ugrep | grep   -> fff content search (literal + regex), else ugrep
//!   * argv0 = rg             -> fff content search (literal + regex), else rg
//!   * argv0 = bfs  | find    -> embedded bfs (fff find_files is a roadmap item)
//!   * argv0 = fff            -> explicit fff content search
//!
//! Modes (chosen by `search_mode`, never the model): Plain (literal), Regex
//! (regex::bytes — the same engine ripgrep uses), Fuzzy (`--fuzzy`). fff serves
//! a query ONLY when its result is provably byte-equivalent to the real tool;
//! every uncertainty defers via a verbatim re-exec, so correctness never depends
//! on fff — only latency/ranking.
//!
//! Levers: `--fuzzy`, `--no-fallback` (CI), `--fff-claude-bin=P` (rg resolver),
//! `--daemon <root>` (warm-index daemon, see daemon.rs).

mod daemon;

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use fff_search::file_picker::FilePicker;
use fff_search::{
    AiGrepConfig, FFFMode, FFFQuery, FilePickerOptions, FuzzyQuery, GrepMode,
    GrepSearchOptions, QueryParser, SharedFilePicker, SharedFrecency,
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
            _ => Tool::Fff,
        }
    }
    fn embedded_argv0(self) -> &'static str {
        match self {
            Tool::Ugrep => "ugrep",
            Tool::Rg => "rg",
            Tool::Bfs => "bfs",
            Tool::Fff => "rg",
        }
    }
}

/// Which fff content-search mode a query resolves to (None elsewhere = fall back).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Plain,
    Regex,
    Fuzzy,
}

struct Opts {
    tool: Tool,
    raw: Vec<String>,
    pattern: Option<String>,
    paths: Vec<String>,
    ignore_case: bool,
    line_numbers: bool,
    files_only: bool,
    count: bool,
    recursive: bool,
    fuzzy: bool,
    ere: bool,    // -E / egrep / rg — extended-regex dialect (≈ RE2)
    hidden: bool, // --hidden — search dotfiles (rg skips them by default)
    no_fallback: bool,
    claude_bin: Option<String>,
    force_fallback: bool,
}

/// The minimal, serializable request shared by the cold path and the daemon.
pub struct SearchReq {
    pub pattern: String,
    pub dir: Option<String>,
    pub line_numbers: bool,
    pub files_only: bool,
    pub count: bool,
    pub mode: Mode,
    pub ignore_case: bool,
    pub hidden: bool,        // include dotfiles (else filtered to match the tool)
    pub path_prefix: String, // "./" iff the tool echoes it for this path arg
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();

    if argv.get(1).map(|s| s == "--daemon").unwrap_or(false) {
        let root = argv.get(2).cloned().unwrap_or_else(|| ".".to_string());
        daemon::serve(&root);
        return;
    }

    let a0 = argv.first().cloned().unwrap_or_default();
    let tool = Tool::from_argv0(&a0);
    let raw: Vec<String> = argv[1..].to_vec();

    if raw.iter().any(|a| a == "--version" || a == "-V") {
        let cb = claude_bin_from(&raw);
        fallback(tool, &strip_custom(&raw), cb.as_deref());
    }
    if tool == Tool::Bfs {
        let cb = claude_bin_from(&raw);
        fallback(tool, &strip_custom(&raw), cb.as_deref());
    }

    let opts = parse(tool, raw);
    if let Some(mode) = search_mode(&opts) {
        std::process::exit(run_search(&opts, mode));
    }
    if opts.no_fallback {
        eprintln!("rg-fff: not fff-eligible and --no-fallback is set");
        std::process::exit(2);
    }
    fallback(opts.tool, &strip_custom(&opts.raw), opts.claude_bin.as_deref());
}

fn claude_bin_from(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("--fff-claude-bin=").map(String::from))
}

/// Remove our private flags before re-execing the real embedded tool.
fn strip_custom(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|a| {
            *a != "--fuzzy"
                && *a != "--no-fallback"
                && *a != "--daemon"
                && !a.starts_with("--fff-claude-bin=")
        })
        .cloned()
        .collect()
}

/// Parse grep/ugrep/rg/fff argv. Conservative: anything we don't confidently
/// understand sets force_fallback so we defer rather than return a wrong result.
fn parse(tool: Tool, raw: Vec<String>) -> Opts {
    let mut o = Opts {
        tool,
        raw: raw.clone(),
        pattern: None,
        paths: Vec::new(),
        ignore_case: false,
        line_numbers: !matches!(tool, Tool::Ugrep),
        files_only: false,
        count: false,
        recursive: false,
        fuzzy: false,
        ere: matches!(tool, Tool::Rg | Tool::Fff), // RE2 dialect by default
        hidden: false,
        no_fallback: false,
        claude_bin: None,
        force_fallback: false,
    };
    let mut explicit_pattern: Option<String> = None;
    let mut positionals: Vec<String> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let a = &raw[i];
        match a.as_str() {
            "--fuzzy" => o.fuzzy = true,
            "--no-fallback" => o.no_fallback = true,
            "-i" | "--ignore-case" => o.ignore_case = true,
            "-l" | "--files-with-matches" | "-L" | "--files-without-match" => {
                o.files_only = true;
                if a == "-L" || a == "--files-without-match" {
                    o.force_fallback = true;
                }
            }
            "-c" | "--count" => o.count = true,
            "-n" | "--line-number" => o.line_numbers = true,
            "-h" | "--no-filename" | "-H" | "--with-filename" | "--color"
            | "--color=never" | "--color=always" | "--color=auto" => {}
            "-r" | "-R" | "--recursive" | "--dereference-recursive" => {
                o.recursive = true
            }
            "--hidden" => o.hidden = true,
            "-G" | "--basic-regexp" | "--ignore-files" | "-I" | "--no-ignore"
            | "--include-dir" => {}
            "-E" | "--extended-regexp" => o.ere = true,
            // capability gaps fff can't faithfully serve -> defer.
            "-P" | "--perl-regexp" | "-o" | "--only-matching" | "-v"
            | "--invert-match" | "-x" | "--line-regexp" | "-w"
            | "--word-regexp" | "-z" | "--null-data" | "-U" | "--multiline"
            | "--multiline-dotall" | "-f" | "--file" | "-A"
            | "--after-context" | "-B" | "--before-context" | "-C"
            | "--context" | "-m" | "--max-count" | "-t" | "--type" => {
                o.force_fallback = true;
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
                if i + 1 < raw.len() {
                    i += 1;
                }
            }
            other => {
                if let Some(cb) = other.strip_prefix("--fff-claude-bin=") {
                    o.claude_bin = Some(cb.to_string());
                } else if other.strip_prefix("--exclude-dir=").is_some() {
                    // CC VCS excludes — fff honors ignores
                } else if other.starts_with("--exclude=")
                    || other.starts_with("--include=")
                {
                    o.force_fallback = true;
                } else if other.starts_with("--color=") {
                } else if let Some(combined) = other.strip_prefix('-') {
                    if combined.is_empty() {
                        positionals.push(other.to_string());
                        o.force_fallback = true;
                    } else if combined.starts_with('-') {
                        o.force_fallback = true;
                    } else {
                        for ch in combined.chars() {
                            match ch {
                                'i' => o.ignore_case = true,
                                'n' => o.line_numbers = true,
                                'l' => o.files_only = true,
                                'c' => o.count = true,
                                'r' | 'R' => o.recursive = true,
                                'E' => o.ere = true,
                                'H' | 'h' | 'I' | 'G' => {}
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

/// Decide which fff mode (if any) serves this query *faithfully tool-equivalent*.
/// None => fall back to the real embedded tool.
fn search_mode(o: &Opts) -> Option<Mode> {
    if o.force_fallback {
        return None;
    }
    let pat = match &o.pattern {
        Some(p) if !p.is_empty() => p,
        _ => return None,
    };
    if !pat.is_ascii() {
        return None;
    }
    // ugrep needs -r to recurse (else stdin / top-level only); rg/fff recurse by
    // default; fuzzy is fff-only discovery.
    if !o.fuzzy && o.tool == Tool::Ugrep && !o.recursive {
        return None;
    }
    // path target: cwd (no path) or a single relative directory. A file, multi-
    // path, or absolute dir defers (grep echoes the path arg verbatim — fff is
    // cwd-relative, so an absolute arg would format differently).
    let path_ok = match o.paths.len() {
        0 => true,
        1 => {
            let p = &o.paths[0];
            // Bare "." is fine; "./..." and absolute args are deferred (their
            // path echoing is tool-specific/uncertain).
            Path::new(p).is_dir()
                && !p.starts_with('/')
                && (p == "." || !p.starts_with("./"))
        }
        _ => false,
    };
    if !path_ok || dir_has_dsl_operator(o) {
        return None;
    }

    if o.fuzzy {
        // Fuzzy runs through fff's DSL (keeps simple tokens literal) -> no DSL ops.
        // (-i on fuzzy is handled by smart_case; fuzzy is approximate anyway.)
        if has_dsl_operator(pat) {
            return None;
        }
        return Some(Mode::Fuzzy);
    }
    let is_regex_orig = has_regex_meta(pat, o.ere);
    if o.ignore_case || is_regex_orig {
        // Regex mode bypasses the DSL (raw pattern as the needle), so DSL operators
        // in the pattern are fine. -i is served here via a (?i) prefix built in
        // effective_pattern. The dialect gate applies only to a genuine regex
        // original — an escaped -i literal carries no dialect risk.
        if is_regex_orig && !regex_dialect_ok(pat, o) {
            return None;
        }
        // An escaped -i literal still wants the bigram floor for a sound prefilter.
        if !is_regex_orig && pat.chars().count() < 3 {
            return None;
        }
        if !regex_servable(&effective_pattern(o, Mode::Regex)) {
            return None;
        }
        Some(Mode::Regex)
    } else {
        // Literal/plain: routed through the DSL, so avoid its operators; needs
        // >= 3 chars for a reliable bigram prefilter.
        if has_dsl_operator(pat) {
            return None;
        }
        if pat.chars().count() < 3 {
            return None;
        }
        Some(Mode::Plain)
    }
}

/// The literal pattern as a case-insensitive regex: `(?i)` + the pattern (regex
/// metacharacters escaped when the original was a literal, so it stays literal).
fn ci_regex_pattern(o: &Opts) -> String {
    let pat = o.pattern.clone().unwrap_or_default();
    let body = if has_regex_meta(&pat, o.ere) {
        pat
    } else {
        regex::escape(&pat)
    };
    format!("(?i){body}")
}

/// The actual needle fff runs for a given mode: a `(?i)` regex for case-
/// insensitive Regex searches, otherwise the raw pattern. (Plain/Fuzzy handle
/// `-i` via smart_case; only Regex needs the inline flag.)
fn effective_pattern(o: &Opts, mode: Mode) -> String {
    if matches!(mode, Mode::Regex) && o.ignore_case {
        ci_regex_pattern(o)
    } else {
        o.pattern.clone().unwrap_or_default()
    }
}

/// fff's query DSL reinterprets these as operators (whitespace = multiple terms,
/// '/' = path constraint, ':' = location, '!' = negation) — anything routed
/// through the parser (Plain/Fuzzy) must avoid them.
fn has_dsl_operator(s: &str) -> bool {
    s.chars().any(|c| matches!(c, ' ' | '\t' | '/' | ':' | '!'))
}
fn dir_has_dsl_operator(o: &Opts) -> bool {
    // The dir is a path, so '/' is fine; whitespace/':'/'!' would misparse (DSL)
    // or are pathological for the post-filter.
    o.paths
        .first()
        .map(|p| p.chars().any(|c| matches!(c, ' ' | '\t' | ':' | '!')))
        .unwrap_or(false)
}

/// Does `t` contain a regex metacharacter for the active dialect?
/// BRE (ugrep `-G`): only `. * [ ] ^ $ \` are special. ERE (rg / `-E` / fff):
/// also `+ ? ( ) { } |`. Determines whether a pattern is "regex" vs literal —
/// keyed on the dialect (`o.ere`), so `ugrep -E "a|b"` is correctly seen as regex.
fn has_regex_meta(t: &str, ere: bool) -> bool {
    t.chars().any(|c| match c {
        '\\' | '.' | '*' | '[' | ']' | '^' | '$' => true,
        '+' | '?' | '(' | ')' | '{' | '}' | '|' => ere,
        _ => false,
    })
}

/// Can fff's regex engine serve `pat` byte-equivalently? Compile it exactly as
/// fff does and DEFER when (a) it won't compile (fff would silently degrade to
/// literal), (b) it can match the empty string (matches every line, where grep
/// and RE2 disagree on zero-width line counting), or (c) it can match a newline
/// (line-based grep/rg never see the trailing `\n`, but fff's multi_line engine
/// can — so it matches at line-end positions the tools don't, changing WHICH
/// lines match). General over-approximations, not case-by-case.
fn regex_servable(pat: &str) -> bool {
    if can_match_newline(pat) {
        return false;
    }
    let p = if pat.contains("\\n") {
        pat.replace("\\n", "\n")
    } else {
        pat.to_string()
    };
    match regex::bytes::RegexBuilder::new(&p)
        .unicode(false)
        .multi_line(true)
        .build()
    {
        Ok(re) => !re.is_match(b""),
        Err(_) => false,
    }
}

/// Sound over-approximation of "this regex can match the newline character":
/// `\s` (whitespace class includes \n), a negated class `[^…]` (matches \n), a
/// literal `\n`/`\r`/`\v`/`\f`, dotall `(?s)`, or `[[:space:]]`.
fn can_match_newline(pat: &str) -> bool {
    pat.contains("\\s")
        || pat.contains("[^")
        || pat.contains("[[:space:]")
        || pat.contains("\\n")
        || pat.contains("\\r")
        || pat.contains("\\v")
        || pat.contains("\\f")
        || pat.contains("(?s")
}

/// Is `pat`'s regex dialect byte-equivalent to fff's RE2 (`regex::bytes`)?
/// fff's regex IS ripgrep's engine, so rg/fff map 1:1. grep's BRE/ERE differ in
/// escapes and which chars are special — serve only the provably-shared subset.
fn regex_dialect_ok(pat: &str, o: &Opts) -> bool {
    match o.tool {
        Tool::Rg | Tool::Fff => true, // same regex crate -> 1:1
        Tool::Bfs => false,
        Tool::Ugrep if o.ere => {
            // POSIX ERE ≈ RE2 except backslash escapes (`\d`/`\w`/`\b` are literal
            // in grep -E but classes in RE2) — defer any backslash.
            !pat.contains('\\')
        }
        Tool::Ugrep => {
            // BRE: only `. * [ ] ^ $` share semantics with RE2; `+ ? ( ) { } |`
            // are literal in BRE but special in RE2, and `\` flips meaning.
            !pat.chars().any(|c| {
                matches!(c, '+' | '?' | '(' | ')' | '{' | '}' | '|' | '\\')
            })
        }
    }
}

impl Opts {
    fn to_req(&self, mode: Mode) -> SearchReq {
        // grep prints `./` for a "." path arg; rg/grep do, ugrep does not.
        let path_prefix = if matches!(self.tool, Tool::Rg | Tool::Fff)
            && self.paths.first().map(|p| p == ".").unwrap_or(false)
        {
            "./".to_string()
        } else {
            String::new()
        };
        SearchReq {
            pattern: effective_pattern(self, mode),
            dir: self.paths.first().cloned(),
            line_numbers: self.line_numbers,
            files_only: self.files_only,
            count: self.count,
            mode,
            ignore_case: self.ignore_case,
            hidden: self.hidden,
            path_prefix,
        }
    }
}

/// Run an fff-eligible search: warm daemon first, else cold-scan + lazily spawn
/// a daemon. Returns the process exit code.
fn run_search(o: &Opts, mode: Mode) -> i32 {
    let req = o.to_req(mode);
    let daemon_enabled = std::env::var_os("RG_FFF_NO_DAEMON").is_none();
    let debug = std::env::var_os("RG_FFF_DEBUG").is_some();
    let root = std::env::current_dir()
        .ok()
        .and_then(|c| std::fs::canonicalize(c).ok());

    if daemon_enabled {
        if let Some(root) = &root {
            if let Some((out, code)) = daemon::query(root, &req) {
                if debug {
                    eprintln!("rg-fff: daemon hit");
                }
                let mut w = std::io::stdout().lock();
                let _ = w.write_all(out.as_bytes());
                let _ = w.flush();
                return code;
            }
        }
    }

    let shared = SharedFilePicker::default();
    let frecency = SharedFrecency::default();
    if FilePicker::new_with_shared_state(
        shared.clone(),
        frecency.clone(),
        FilePickerOptions {
            base_path: ".".into(),
            mode: FFFMode::Ai,
            ..Default::default()
        },
    )
    .is_err()
    {
        if o.no_fallback {
            std::process::exit(2);
        }
        fallback(o.tool, &strip_custom(&o.raw), o.claude_bin.as_deref());
    }
    shared.wait_for_scan(Duration::from_secs(15));
    {
        let guard = match shared.read() {
            Ok(g) => g,
            Err(_) => {
                fallback(o.tool, &strip_custom(&o.raw), o.claude_bin.as_deref())
            }
        };
        let picker = match guard.as_ref() {
            Some(p) => p,
            None => {
                fallback(o.tool, &strip_custom(&o.raw), o.claude_bin.as_deref())
            }
        };
        // None => fff can't serve faithfully (e.g. a regex its engine rejects).
        let (out, code) = match format_results(picker, &req) {
            Some(r) => {
                if debug {
                    eprintln!("rg-fff: fff served (cold)");
                }
                r
            }
            None => {
                if debug {
                    eprintln!("rg-fff: fff defer -> fallback");
                }
                fallback(o.tool, &strip_custom(&o.raw), o.claude_bin.as_deref())
            }
        };
        let mut w = std::io::stdout().lock();
        let _ = w.write_all(out.as_bytes());
        let _ = w.flush();
        if daemon_enabled {
            if let Some(root) = &root {
                daemon::spawn_detached(root);
            }
        }
        code
    }
}

/// Grep `picker` per `req` and render tool-compatible output. Shared verbatim by
/// the cold path and the daemon. Returns None when fff can't serve faithfully.
pub fn format_results(
    picker: &FilePicker,
    req: &SearchReq,
) -> Option<(String, i32)> {
    let gmode = match req.mode {
        Mode::Plain => GrepMode::PlainText,
        Mode::Regex => GrepMode::Regex,
        Mode::Fuzzy => GrepMode::Fuzzy,
    };
    let is_fuzzy = matches!(req.mode, Mode::Fuzzy);
    let is_regex = matches!(req.mode, Mode::Regex);
    // -i is baked into the pattern as (?i) for Regex; Plain is case-sensitive;
    // only Fuzzy still relies on smart_case for case-insensitivity.
    let smart = is_fuzzy && req.ignore_case;

    // Directory scoping + path echoing. grep prints join(pathArg, relPath); fff
    // returns cwd-relative paths. So scope by the CANONICAL dir (leading "./" and
    // trailing "/" stripped), and re-prepend the "./" grep emits when the path
    // arg is "." or "./...".
    //  * Plain/Fuzzy go through fff's DSL ("dir/ " is a path constraint, the
    //    simple pattern stays literal).
    //  * Regex MUST bypass the DSL (it misreads `obj.method` as a filename, drops
    //    `|`/`^`/`\b`), so we build the query directly and scope by post-filter.
    // Canonical dir for scoping ("." and trailing "/" -> ""); "./..."/absolute
    // args never reach here (deferred in search_mode). out_prefix is precomputed
    // per-tool in to_req (rg echoes "./" for a "." arg; ugrep does not).
    let arg = req.dir.as_deref().unwrap_or("");
    let canonical = {
        let c = arg.trim_end_matches('/');
        if c == "." {
            ""
        } else {
            c
        }
    };
    let out_prefix = req.path_prefix.as_str();
    let dir_constraint: Option<String> = if canonical.is_empty() {
        None
    } else {
        Some(format!("{canonical}/"))
    };
    // Dir scoping is ALWAYS the anchored post-filter (relative_path starts_with
    // "canonical/"), never fff's DSL "dir/" constraint — that matches the segment
    // (e.g. "src") ANYWHERE in a path (tools/x/src/…), diverging from grep's
    // root-anchored path arg. So the query carries only the pattern.
    let post_filter: Option<&str> = dir_constraint.as_deref();

    let parser = QueryParser::new(AiGrepConfig);
    let dsl_query: String = req.pattern.clone();
    let parsed: FFFQuery = if is_regex {
        FFFQuery {
            raw_query: &req.pattern,
            constraints: Vec::new(),
            fuzzy_query: FuzzyQuery::Text(&req.pattern),
            location: None,
        }
    } else {
        parser.parse(&dsl_query)
    };

    let keep = |path: &str| -> bool {
        // regex dir-scoping (plain/fuzzy already scope via the DSL constraint)
        if let Some(p) = post_filter {
            if !path.starts_with(p) {
                return false;
            }
        }
        // hidden-file handling: unless --hidden, skip dotfiles like the tool does
        // — but only relative to the search root, so an explicit hidden dir arg
        // (e.g. `grep X .github`) is still searched.
        if req.hidden {
            return true;
        }
        let rel = dir_constraint
            .as_deref()
            .and_then(|c| path.strip_prefix(c))
            .unwrap_or(path);
        !rel.split('/').any(|s| s.starts_with('.'))
    };

    if is_regex {
        // fff's grep_text() strips a leading backslash when it reads as a
        // constraint-escape; if that (or anything) would alter our exact regex,
        // the search would diverge — defer precisely, only when it actually does.
        if parsed.grep_text() != req.pattern {
            return None;
        }
        // Preflight: if fff's engine can't compile the pattern it SILENTLY falls
        // back to literal matching (regex_fallback_error set) -> defer.
        let probe = picker.grep(
            &parsed,
            &grep_opts(gmode, 0, req.files_only, smart),
        );
        if probe.regex_fallback_error.is_some() {
            return None;
        }
    }

    let mut out = String::new();
    if is_fuzzy {
        let _ = writeln!(
            out,
            "# fff: approximate (fuzzy) matches, ranked by relevance — not exact"
        );
    }

    if req.count {
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut file_offset = 0usize;
        loop {
            let opts = grep_opts(gmode, file_offset, false, smart);
            let r = picker.grep(&parsed, &opts);
            for m in &r.matches {
                let f = r.files[m.file_index];
                let path = f.relative_path(picker);
                if keep(&path) {
                    *counts.entry(path).or_insert(0) += 1;
                }
            }
            if r.next_file_offset == 0 {
                break;
            }
            file_offset = r.next_file_offset;
        }
        let any = !counts.is_empty();
        for (f, c) in &counts {
            let _ = writeln!(out, "{out_prefix}{f}:{c}");
        }
        return Some((out, if any { 0 } else { 1 }));
    }

    let mut any = false;
    let mut file_offset = 0usize;
    loop {
        let opts = grep_opts(gmode, file_offset, req.files_only, smart);
        let result = picker.grep(&parsed, &opts);
        if req.files_only {
            for f in &result.files {
                let path = f.relative_path(picker);
                if keep(&path) {
                    let _ = writeln!(out, "{out_prefix}{path}");
                    any = true;
                }
            }
        } else {
            for m in &result.matches {
                let f = result.files[m.file_index];
                let path = f.relative_path(picker);
                if !keep(&path) {
                    continue;
                }
                // fff truncates line_content to 512 bytes (MAX_LINE_DISPLAY_LEN,
                // backed up to a char boundary -> [509,512]) and lossily replaces
                // invalid UTF-8 with U+FFFD. grep/rg print the raw, full line. For
                // exact (non-fuzzy) modes, a possibly-truncated or lossy line can't
                // be reproduced byte-for-byte -> defer the whole query so the model
                // gets the complete line from the real tool, never a 512B stub.
                if !is_fuzzy
                    && (m.line_content.len() >= 509
                        || m.line_content.contains('\u{FFFD}'))
                {
                    return None;
                }
                if req.line_numbers {
                    let _ = writeln!(
                        out,
                        "{}{}:{}:{}",
                        out_prefix, path, m.line_number, m.line_content
                    );
                } else {
                    let _ = writeln!(
                        out,
                        "{}{}:{}",
                        out_prefix, path, m.line_content
                    );
                }
                any = true;
            }
        }
        if is_fuzzy || result.next_file_offset == 0 {
            break;
        }
        file_offset = result.next_file_offset;
    }
    Some((out, if any { 0 } else { 1 }))
}

fn grep_opts(
    mode: GrepMode,
    file_offset: usize,
    files_only: bool,
    smart_case: bool,
) -> GrepSearchOptions {
    GrepSearchOptions {
        max_file_size: 10 * 1024 * 1024,
        max_matches_per_file: if files_only { 1 } else { 1_000_000 },
        smart_case,
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
fn fallback(tool: Tool, args: &[String], claude_bin: Option<&str>) -> ! {
    use std::os::unix::process::CommandExt;

    let claude = claude_bin
        .map(String::from)
        .filter(|p| Path::new(p).exists())
        .or_else(|| {
            std::env::var("CLAUDE_CODE_EXECPATH")
                .ok()
                .filter(|p| Path::new(p).exists())
        })
        .or_else(|| {
            let h = std::env::var("HOME").ok()?;
            let p = format!("{h}/.local/bin/claude");
            Path::new(&p).exists().then_some(p)
        });

    let a0 = tool.embedded_argv0();
    if let Some(bin) = claude {
        let mut cmd = Command::new(&bin);
        if tool == Tool::Rg && !args.iter().any(|a| a == "--no-config") {
            cmd.arg("--no-config");
        }
        cmd.args(args);
        cmd.arg0(a0);
        let err = cmd.exec();
        eprintln!("rg-fff: failed to exec embedded {a0}: {err}");
    }
    let sys = match tool {
        Tool::Bfs => "find",
        Tool::Ugrep => "grep",
        _ => "rg",
    };
    let err = Command::new(sys).args(args).exec();
    eprintln!("rg-fff: failed to exec {sys}: {err}");
    std::process::exit(2);
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build an Opts for eligibility tests. recursive defaults true (so the ugrep
    // -r gate doesn't mask other checks); ere mirrors the real default.
    fn opts(tool: Tool, pat: &str, paths: &[&str]) -> Opts {
        Opts {
            tool,
            raw: vec![],
            pattern: Some(pat.to_string()),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            ignore_case: false,
            line_numbers: false,
            files_only: false,
            count: false,
            recursive: true,
            fuzzy: false,
            ere: matches!(tool, Tool::Rg | Tool::Fff),
            hidden: false,
            no_fallback: false,
            claude_bin: None,
            force_fallback: false,
        }
    }

    #[test]
    fn regex_meta_is_dialect_keyed() {
        assert!(has_regex_meta("foo.bar", false)); // . is BRE meta
        assert!(!has_regex_meta("a|b", false)); // | literal in BRE
        assert!(has_regex_meta("a|b", true)); // | special in ERE
        assert!(!has_regex_meta("foo()", false)); // () literal in BRE
        assert!(has_regex_meta("foo()", true));
        assert!(!has_regex_meta("plain_id", false));
    }

    #[test]
    fn dialect_gate_matches_each_tool() {
        // rg/fff share fff's engine -> any pattern maps 1:1
        assert!(regex_dialect_ok("a(b|c)+\\d", &opts(Tool::Rg, "x", &[])));
        // ugrep BRE: + ? ( ) { } | \ diverge
        assert!(regex_dialect_ok("foo.*bar", &opts(Tool::Ugrep, "x", &[])));
        assert!(!regex_dialect_ok("foo+", &opts(Tool::Ugrep, "x", &[])));
        assert!(!regex_dialect_ok("a|b", &opts(Tool::Ugrep, "x", &[])));
        assert!(!regex_dialect_ok("\\d", &opts(Tool::Ugrep, "x", &[])));
        // ugrep -E: ERE, but POSIX escapes diverge from RE2 -> defer backslash
        let mut e = opts(Tool::Ugrep, "x", &[]);
        e.ere = true;
        assert!(regex_dialect_ok("a|b(c)+", &e));
        assert!(!regex_dialect_ok("\\d+", &e));
    }

    #[test]
    fn newline_matchers_detected() {
        for p in ["\\s+", "a[^x]b", "a\\nb", "(?s).", "[[:space:]]"] {
            assert!(can_match_newline(p), "{p} should be newline-matching");
        }
        for p in ["\\w+", "\\d+", "foo.bar", "[A-Z][a-z]+", "import.*from"] {
            assert!(!can_match_newline(p), "{p} should NOT match newline");
        }
    }

    #[test]
    fn regex_servable_defers_pathological() {
        // empty-matchers (match every line) -> defer
        for p in ["x?", "foo|", "a*", "(ab)?"] {
            assert!(!regex_servable(p), "{p} matches empty -> defer");
        }
        // newline-matchers -> defer
        assert!(!regex_servable("\\s+"));
        // uncompilable -> defer
        assert!(!regex_servable("(unclosed"));
        assert!(!regex_servable("a["));
        // genuinely servable
        for p in ["foo.bar", "\\d+", "[A-Z]\\w+", "import.*from", "Grep(Match|Result)"] {
            assert!(regex_servable(p), "{p} should be servable");
        }
    }

    #[test]
    fn search_mode_routes_correctly() {
        use Mode::*;
        // literal -> Plain; regex (dialect-ok) -> Regex; fuzzy -> Fuzzy
        assert!(matches!(search_mode(&opts(Tool::Ugrep, "showDiff", &["src"])), Some(Plain)));
        assert!(matches!(search_mode(&opts(Tool::Ugrep, "foo.bar", &["src"])), Some(Regex)));
        assert!(matches!(search_mode(&opts(Tool::Rg, "a\\d+", &["src"])), Some(Regex)));
        let mut f = opts(Tool::Ugrep, "showDiff", &["src"]);
        f.fuzzy = true;
        assert!(matches!(search_mode(&f), Some(Fuzzy)));
        // -i (any case) routes to Regex (served via a (?i) prefix)
        let mut lo = opts(Tool::Ugrep, "showdiff", &["src"]);
        lo.ignore_case = true;
        assert!(matches!(search_mode(&lo), Some(Regex)));
        let mut up = opts(Tool::Ugrep, "ShowDiff", &["src"]);
        up.ignore_case = true;
        assert!(matches!(search_mode(&up), Some(Regex)));
    }

    #[test]
    fn ci_pattern_escapes_literal_but_not_regex() {
        // "a+b": literal in BRE (escape the +) but a regex in ERE (keep the +).
        let mut lit = opts(Tool::Ugrep, "a+b", &["src"]);
        lit.ignore_case = true;
        assert_eq!(ci_regex_pattern(&lit), "(?i)a\\+b");
        let mut re = opts(Tool::Rg, "a+b", &["src"]);
        re.ignore_case = true;
        assert_eq!(ci_regex_pattern(&re), "(?i)a+b");
    }

    #[test]
    fn search_mode_defers_unsafe() {
        // BRE regex with an ERE-only metachar -> dialect defer
        assert!(search_mode(&opts(Tool::Ugrep, "foo.bar+", &["src"])).is_none());
        // empty-matcher / newline regex -> defer
        assert!(search_mode(&opts(Tool::Rg, "x?", &["src"])).is_none());
        assert!(search_mode(&opts(Tool::Rg, "a\\s+b", &["src"])).is_none());
        // DSL operator in pattern (plain) -> defer
        assert!(search_mode(&opts(Tool::Ugrep, "a b", &["src"])).is_none());
        // non-ascii -> defer
        assert!(search_mode(&opts(Tool::Ugrep, "café", &["src"])).is_none());
        // ugrep without -r -> defer
        let mut nr = opts(Tool::Ugrep, "showDiff", &["src"]);
        nr.recursive = false;
        assert!(search_mode(&nr).is_none());
        // multiple paths / ./ arg / absolute arg -> defer
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["src", "tools"])).is_none());
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["./src"])).is_none());
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["/tmp"])).is_none());
        // force_fallback / short literal -> defer
        let mut ff = opts(Tool::Ugrep, "showDiff", &["src"]);
        ff.force_fallback = true;
        assert!(search_mode(&ff).is_none());
        assert!(search_mode(&opts(Tool::Ugrep, "ab", &["src"])).is_none());
    }

    #[test]
    fn path_prefix_is_per_tool() {
        // rg echoes "./" for a "." arg; ugrep does not
        assert_eq!(opts(Tool::Rg, "x", &["."]).to_req(Mode::Regex).path_prefix, "./");
        assert_eq!(opts(Tool::Ugrep, "x", &["."]).to_req(Mode::Plain).path_prefix, "");
        assert_eq!(opts(Tool::Rg, "x", &["src"]).to_req(Mode::Plain).path_prefix, "");
    }
}
