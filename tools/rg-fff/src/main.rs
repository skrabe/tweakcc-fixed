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
    ere: bool,             // -E / egrep / rg — extended-regex dialect (≈ RE2)
    hidden: bool,          // --hidden — search dotfiles (rg skips by default)
    before_context: usize, // -B / -C
    after_context: usize,  // -A / -C
    include_exts: Vec<String>, // -g/--glob/--include "*.ext" -> keep only these
    // extensions (e.g. ".ts"). Only simple extension include globs are served;
    // any other glob (exclude, path glob, char class, brace, **) sets
    // force_fallback in parse so we never silently ignore a glob.
    fff_first: bool,       // RG_FFF_FIRST: serve fff RE2 (the model's intended
    // dialect) instead of mirroring CC's shell ugrep -G BRE — captures the
    // \w/\d/+/(/| regexes the model writes. Correctness gates (servable/newline/
    // non-ascii/long-line/path/pipe) still apply; only the dialect gate relaxes.
    no_fallback: bool,
    claude_bin: Option<String>,
    force_fallback: bool,
}

impl Opts {
    /// The regex dialect to interpret the pattern in. fff-first treats every
    /// tool's pattern as ERE/RE2 (what the model intends + the Grep tool
    /// advertises); byte-equiv mode honors the tool's real dialect.
    fn eff_ere(&self) -> bool {
        self.ere || self.fff_first
    }
}

/// The minimal, serializable request shared by the cold path and the daemon.
pub struct SearchReq {
    pub pattern: String,
    pub dir_prefixes: Vec<String>, // canonical "app/","lib/" scopes; empty = cwd
    pub line_numbers: bool,
    pub files_only: bool,
    pub count: bool,
    pub mode: Mode,
    pub ignore_case: bool,
    pub hidden: bool,            // include dotfiles (else filtered to match the tool)
    pub before_context: usize,   // -B / -C
    pub after_context: usize,    // -A / -C
    pub sep_between_files: bool, // rg prints `--` across files; ugrep does not
    pub include_exts: Vec<String>, // -g/--include "*.ext" -> keep only these
    pub path_prefix: String,     // "./" iff the tool echoes it for this path arg
}

/// Append a one-line decision record to `$RG_FFF_LOG` for adoption testing:
/// `ts<TAB>tool<TAB>decision<TAB>nlines<TAB>pattern`. No-op (and error-swallowing)
/// when the env var is unset, so it's zero-cost in normal use and can never break
/// a search. `nlines` = served result lines, or -1 when unknown (fallback).
fn log_decision(tool: Tool, pattern: &Option<String>, decision: &str, nlines: i64) {
    let path = match std::env::var("RG_FFF_LOG") {
        Ok(p) if !p.is_empty() => p,
        _ => return,
    };
    let pat: String = pattern
        .as_deref()
        .unwrap_or("")
        .replace(['\t', '\n', '\r'], " ")
        .chars()
        .take(160)
        .collect();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = tool.embedded_argv0();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{ts}\t{t}\t{decision}\t{nlines}\t{pat}");
    }
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
    log_decision(opts.tool, &opts.pattern, "fallback-ineligible", -1);
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
        before_context: 0,
        after_context: 0,
        include_exts: Vec::new(),
        // fff-first (serve RE2 = the model's intended dialect) is the MAINSTREAM
        // production default: when this wrapper is installed the feature is on and
        // the user wants fff to be the search. RG_FFF_FIRST=0 opts back into the
        // conservative byte-equiv (mirror ugrep -G BRE) mode.
        fff_first: std::env::var("RG_FFF_FIRST").as_deref() != Ok("0"),
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
            // No-ops for fff: -G/-E dialect handled elsewhere, --ignore-files/-I
            // are fff defaults, --no-config only affects rg's own config file
            // (fff reads none). NB: --no-ignore / --include-dir are NOT here — they
            // change file inclusion in ways fff can't replicate, so they fall
            // through to `other` -> force_fallback (defer), never silently ignored.
            "-G" | "--basic-regexp" | "--ignore-files" | "-I" | "--no-config" => {}
            "-E" | "--extended-regexp" => o.ere = true,
            // -A/-B/-C N (space form) — context. A non-numeric value -> defer.
            "-A" | "--after-context" | "-B" | "--before-context" | "-C"
            | "--context" => {
                match raw.get(i + 1).and_then(|v| v.parse::<usize>().ok()) {
                    Some(n) => {
                        i += 1;
                        if a == "-A" || a == "--after-context" {
                            o.after_context = n;
                        } else if a == "-B" || a == "--before-context" {
                            o.before_context = n;
                        } else {
                            o.before_context = n;
                            o.after_context = n;
                        }
                    }
                    None => o.force_fallback = true,
                }
            }
            // capability gaps fff can't faithfully serve -> defer.
            "-P" | "--perl-regexp" | "-o" | "--only-matching" | "-v"
            | "--invert-match" | "-x" | "--line-regexp" | "-w"
            | "--word-regexp" | "-z" | "--null-data" | "-U" | "--multiline"
            | "--multiline-dotall" | "-f" | "--file" | "-m" | "--max-count"
            | "-t" | "--type" => {
                o.force_fallback = true;
                if matches!(
                    a.as_str(),
                    "-f" | "--file" | "-m" | "--max-count" | "-t" | "--type"
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
            // include globs (space form): serve simple "*.ext", defer the rest.
            "-g" | "--glob" | "--include" => {
                if let Some(g) = raw.get(i + 1) {
                    classify_glob(g, &mut o);
                    i += 1;
                }
            }
            // exclude globs -> defer (can't serve byte-exactly yet).
            "--exclude" => {
                o.force_fallback = true;
                if i + 1 < raw.len() {
                    i += 1;
                }
            }
            // VCS dir excludes -> no-op (fff already honors .gitignore).
            "--exclude-dir" => {
                if i + 1 < raw.len() {
                    i += 1;
                }
            }
            other => {
                if let Some(cb) = other.strip_prefix("--fff-claude-bin=") {
                    o.claude_bin = Some(cb.to_string());
                } else if other.strip_prefix("--exclude-dir=").is_some() {
                    // CC VCS excludes — fff honors ignores
                } else if let Some(g) = other
                    .strip_prefix("--include=")
                    .or_else(|| other.strip_prefix("--glob="))
                {
                    classify_glob(g, &mut o); // include glob (= form)
                } else if other.starts_with("--exclude=") {
                    o.force_fallback = true; // exclude glob -> defer
                } else if other.starts_with("--color=") {
                } else if let Some(n) = attached_ctx(other, "-A")
                    .or_else(|| attached_ctx(other, "--after-context="))
                {
                    o.after_context = n; // -A3 / --after-context=3
                } else if let Some(n) = attached_ctx(other, "-B")
                    .or_else(|| attached_ctx(other, "--before-context="))
                {
                    o.before_context = n;
                } else if let Some(n) = attached_ctx(other, "-C")
                    .or_else(|| attached_ctx(other, "--context="))
                {
                    o.before_context = n;
                    o.after_context = n;
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

/// Classify a glob arg. Only a simple include extension glob ("*.ts") is served
/// (its extension is recorded for the post-filter, byte-identical to rg `-g`/grep
/// `--include` on an extension); ANY other glob — exclude (`!`-prefixed), path
/// glob (`/`), char class `[`, brace `{`, `**`, or non-`*.ext` — sets
/// force_fallback so the search defers rather than silently ignore the glob.
fn classify_glob(g: &str, o: &mut Opts) {
    if let Some(ext) = g.strip_prefix("*.") {
        if !ext.is_empty()
            && ext.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            o.include_exts.push(format!(".{ext}"));
            return;
        }
    }
    o.force_fallback = true;
}

/// Parse an attached context value: `-A3` / `--after-context=3` -> Some(3).
/// Returns None when the prefix doesn't apply or the value isn't a usize.
fn attached_ctx(s: &str, prefix: &str) -> Option<usize> {
    s.strip_prefix(prefix)
        .filter(|r| !r.is_empty())
        .and_then(|r| r.parse::<usize>().ok())
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
    // path target: cwd (no path), or one-or-more RELATIVE DIRECTORIES under cwd
    // (e.g. `app lib scripts`). A file arg, an absolute arg, or a `./…` arg
    // defers (their path echoing is tool-specific/uncertain), as does mixing "."
    // with other dirs in a multi-path search (overlap -> possible double-report).
    let all_rel_dirs = !o.paths.is_empty()
        && o.paths.iter().all(|p| {
            Path::new(p).is_dir()
                && !p.starts_with('/')
                && (p == "." || !p.starts_with("./"))
        });
    let dot_overlap = o.paths.len() > 1 && o.paths.iter().any(|p| p == ".");
    let path_ok = o.paths.is_empty() || (all_rel_dirs && !dot_overlap);
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
    let is_regex_orig = has_regex_meta(pat, o.eff_ere());
    // A literal PHRASE with DSL operators (space/`:`/`/`/`!`) can't go through
    // fff's DSL parser, but it CAN be served as an escaped literal via the
    // DSL-bypassing regex path (byte-identical to a literal grep). Route it there.
    if o.ignore_case || is_regex_orig || has_dsl_operator(pat) {
        // Regex mode bypasses the DSL (raw pattern as the needle), so DSL operators
        // in the pattern are fine. -i is served here via a (?i) prefix built in
        // effective_pattern. The dialect gate applies only to a genuine regex
        // original — an escaped -i literal carries no dialect risk. fff-first
        // skips the dialect gate entirely: it serves fff's RE2 (the dialect the
        // model intends + the Grep tool advertises), so the \w/\d/+/(/| regexes
        // ugrep -G would treat as BRE-literal are served as real regex. The
        // regex_servable gate below still guarantees RE2-faithfulness.
        if is_regex_orig && !o.fff_first && !regex_dialect_ok(pat, o) {
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

/// The actual needle fff runs for a given mode: a `(?i)` regex for case-
/// insensitive Regex searches, otherwise the raw pattern. (Plain/Fuzzy handle
/// `-i` via smart_case; only Regex needs the inline flag.)
fn effective_pattern(o: &Opts, mode: Mode) -> String {
    let pat = o.pattern.clone().unwrap_or_default();
    if !matches!(mode, Mode::Regex) {
        return pat;
    }
    // In Regex mode: a genuine regex passes through raw; a LITERAL (no metas for
    // the active dialect) is regex-escaped so it matches exactly. This lets us
    // serve literal PHRASES the DSL can't (spaces/`:`/`/`/`!`) by routing them
    // through the DSL-bypassing regex path as an escaped literal — byte-identical
    // to a literal grep. `-i` adds the inline (?i) flag on top.
    let body = if has_regex_meta(&pat, o.eff_ere()) {
        pat
    } else {
        regex::escape(&pat)
    };
    if o.ignore_case {
        format!("(?i){body}")
    } else {
        body
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
    // or are pathological for the post-filter. Check every path (multi-path).
    // ',' is also excluded: dir prefixes are comma-joined on the daemon wire.
    o.paths
        .iter()
        .any(|p| p.chars().any(|c| matches!(c, ' ' | '\t' | ':' | '!' | ',')))
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
        // Context only applies to content output (not -l files-only, not -c
        // count, not fuzzy discovery).
        let ctx = !self.files_only
            && !self.count
            && !matches!(mode, Mode::Fuzzy);
        // Canonical "dir/" scope prefixes. "." / "" -> none (whole cwd). Multiple
        // relative dirs ("app","lib") -> multiple prefixes; keep iff under any.
        let dir_prefixes: Vec<String> = self
            .paths
            .iter()
            .filter_map(|p| {
                let c = p.trim_end_matches('/');
                if c == "." || c.is_empty() {
                    None
                } else {
                    Some(format!("{c}/"))
                }
            })
            .collect();
        SearchReq {
            pattern: effective_pattern(self, mode),
            dir_prefixes,
            line_numbers: self.line_numbers,
            files_only: self.files_only,
            count: self.count,
            mode,
            ignore_case: self.ignore_case,
            hidden: self.hidden,
            before_context: if ctx { self.before_context } else { 0 },
            after_context: if ctx { self.after_context } else { 0 },
            sep_between_files: matches!(self.tool, Tool::Rg | Tool::Fff),
            include_exts: self.include_exts.clone(),
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
                log_decision(
                    o.tool,
                    &o.pattern,
                    "served-daemon",
                    out.lines().count() as i64,
                );
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
                log_decision(
                    o.tool,
                    &o.pattern,
                    "served-cold",
                    r.0.lines().count() as i64,
                );
                r
            }
            None => {
                if debug {
                    eprintln!("rg-fff: fff defer -> fallback");
                }
                log_decision(o.tool, &o.pattern, "fallback-defer", -1);
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

/// Trailing marker for a line fff truncated at its 512 B display cap. fff (and
/// OpenCode) cut silently; we append this so the model knows the line was cut and
/// can Read the file for the rest. ASCII-only + parser-safe (trailing text in the
/// `path:line:text` shape; a -c count still counts the line once, unaffected).
const TRUNC_MARK: &str =
    " [...rg-fff: line truncated at ~512B; Read the file for the full line]";

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
    let out_prefix = req.path_prefix.as_str();
    // Dir scoping is ALWAYS the anchored post-filter (relative_path starts_with a
    // "dir/" prefix), never fff's DSL "dir/" constraint — that matches the segment
    // (e.g. "src") ANYWHERE in a path (tools/x/src/…), diverging from grep's
    // root-anchored path arg. `req.dir_prefixes` holds the canonical "app/","lib/"
    // prefixes (empty = whole cwd / "." arg); multi-path keeps a result iff it's
    // under ANY prefix. So the query carries only the pattern.
    let dir_prefixes = &req.dir_prefixes;

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
        // -g/--include "*.ext" filter: keep only the requested extensions. Path
        // ends-with is byte-identical to rg's `-g '*.ts'` (path glob) and grep's
        // `--include=*.ts` (basename glob) for extension globs (the ext is at the
        // path tail either way). Non-extension globs never reach here (deferred).
        if !req.include_exts.is_empty()
            && !req.include_exts.iter().any(|e| path.ends_with(e.as_str()))
        {
            return false;
        }
        // dir scoping: keep iff under ANY requested dir prefix (empty = whole cwd)
        if !dir_prefixes.is_empty()
            && !dir_prefixes.iter().any(|p| path.starts_with(p.as_str()))
        {
            return false;
        }
        // hidden-file handling: unless --hidden, skip dotfiles like the tool does
        // — but only relative to the matching search root, so an explicit hidden
        // dir arg (e.g. `grep X .github`) is still searched.
        if req.hidden {
            return true;
        }
        let rel = dir_prefixes
            .iter()
            .find_map(|p| path.strip_prefix(p.as_str()))
            .unwrap_or(path);
        !rel.split('/').any(|s| s.starts_with('.'))
    };

    if is_regex {
        // fff's grep_text() strips a leading backslash when it reads as a
        // constraint-escape; if that (or anything) would alter our exact regex,
        // the search would diverge — defer precisely, only when it actually does.
        if parsed.grep_text() != req.pattern {
            if std::env::var_os("RG_FFF_DEBUG").is_some() {
                eprintln!(
                    "rg-fff: regex defer: grep_text {:?} != pattern {:?}",
                    parsed.grep_text(),
                    req.pattern
                );
            }
            return None;
        }
        // Preflight: if fff's engine can't compile the pattern it SILENTLY falls
        // back to literal matching (regex_fallback_error set) -> defer.
        let probe = picker.grep(
            &parsed,
            &grep_opts(gmode, 0, req.files_only, smart),
        );
        if let Some(e) = &probe.regex_fallback_error {
            if std::env::var_os("RG_FFF_DEBUG").is_some() {
                eprintln!("rg-fff: regex defer: regex_fallback_error: {e}");
            }
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

    // -A/-B/-C context: collect every (match + context) line per file, merge
    // overlapping windows by line number, then emit with grep's separators.
    // (to_req zeroes context for -l/-c/fuzzy, so this is content mode only.)
    if req.before_context > 0 || req.after_context > 0 {
        // Per line: U+FFFD (non-UTF-8) -> defer the whole query (None); a >=509 B
        // line gets the truncation marker; otherwise pass through unchanged.
        let mark = |s: &str| -> Option<String> {
            if s.contains('\u{FFFD}') {
                return None;
            }
            Some(if s.len() >= 509 {
                format!("{s}{TRUNC_MARK}")
            } else {
                s.to_string()
            })
        };
        // path -> (line_no -> (is_match, content)); BTreeMap keeps line order.
        let mut per_file: BTreeMap<String, BTreeMap<u64, (bool, String)>> =
            BTreeMap::new();
        let mut file_offset = 0usize;
        loop {
            let opts = GrepSearchOptions {
                before_context: req.before_context,
                after_context: req.after_context,
                ..grep_opts(gmode, file_offset, false, smart)
            };
            let result = picker.grep(&parsed, &opts);
            for m in &result.matches {
                let f = result.files[m.file_index];
                let path = f.relative_path(picker);
                if !keep(&path) {
                    continue;
                }
                let mln = match mark(&m.line_content) {
                    Some(x) => x,
                    None => return None, // non-UTF-8 -> defer
                };
                let fmap = per_file.entry(path).or_default();
                let ln = m.line_number;
                // fff returns only the context lines that exist, so the first
                // before-context line sits at ln - context_before.len().
                let blen = m.context_before.len() as u64;
                for (i, c) in m.context_before.iter().enumerate() {
                    let cm = match mark(c) {
                        Some(x) => x,
                        None => return None,
                    };
                    fmap.entry(ln - blen + i as u64).or_insert((false, cm));
                }
                // The match line wins over any context tag for the same line.
                fmap.insert(ln, (true, mln));
                for (i, c) in m.context_after.iter().enumerate() {
                    let cm = match mark(c) {
                        Some(x) => x,
                        None => return None,
                    };
                    fmap.entry(ln + 1 + i as u64).or_insert((false, cm));
                }
            }
            if result.next_file_offset == 0 {
                break;
            }
            file_offset = result.next_file_offset;
        }
        let mut any = false;
        let mut first_group = true;
        for (path, lines) in &per_file {
            let mut prev: Option<u64> = None;
            for (&ln, (is_match, content)) in lines {
                let new_group = prev.map(|p| ln > p + 1).unwrap_or(true);
                if new_group && !first_group {
                    // within-file gap -> always `--`; across files -> only rg.
                    let cross_file = prev.is_none();
                    if !cross_file || req.sep_between_files {
                        let _ = writeln!(out, "--");
                    }
                }
                let sep = if *is_match { ':' } else { '-' };
                if req.line_numbers {
                    let _ =
                        writeln!(out, "{out_prefix}{path}{sep}{ln}{sep}{content}");
                } else {
                    let _ = writeln!(out, "{out_prefix}{path}{sep}{content}");
                }
                prev = Some(ln);
                first_group = false;
                any = true;
            }
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
                // fff caps line_content at 512 B (MAX_LINE_DISPLAY_LEN, backed up
                // to a char boundary -> [509,512]) and lossily replaces invalid
                // UTF-8 with U+FFFD. A 512-byte preview is the right thing for an
                // agent (a full minified line is context-noise) — so serve it with
                // an explicit marker (parser-safe trailing text) rather than the
                // silent cut fff/OpenCode emit. Non-UTF-8 (U+FFFD) still defers:
                // raw bytes can't be represented as a String.
                if !is_fuzzy && m.line_content.contains('\u{FFFD}') {
                    return None;
                }
                let mark = if m.line_content.len() >= 509 {
                    TRUNC_MARK
                } else {
                    ""
                };
                if req.line_numbers {
                    let _ = writeln!(
                        out,
                        "{}{}:{}:{}{}",
                        out_prefix, path, m.line_number, m.line_content, mark
                    );
                } else {
                    let _ = writeln!(
                        out,
                        "{}{}:{}{}",
                        out_prefix, path, m.line_content, mark
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
            before_context: 0,
            after_context: 0,
            include_exts: Vec::new(),
            fff_first: false,
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
        // a literal PHRASE (DSL operators) routes to Regex as an escaped literal
        assert!(matches!(search_mode(&opts(Tool::Ugrep, "export const", &["src"])), Some(Regex)));
        assert!(matches!(search_mode(&opts(Tool::Ugrep, "key: value", &["src"])), Some(Regex)));
        // MULTI-PATH: several relative dirs serve; to_req builds the prefixes.
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["src", "target"])).is_some());
        let mp = opts(Tool::Ugrep, "showDiff", &["src", "target"]).to_req(Plain);
        assert_eq!(mp.dir_prefixes, vec!["src/", "target/"]);
        // single "." -> no prefixes (whole cwd)
        assert!(opts(Tool::Rg, "showDiff", &["."]).to_req(Plain).dir_prefixes.is_empty());
        // -i (any case) routes to Regex (served via a (?i) prefix)
        let mut lo = opts(Tool::Ugrep, "showdiff", &["src"]);
        lo.ignore_case = true;
        assert!(matches!(search_mode(&lo), Some(Regex)));
        let mut up = opts(Tool::Ugrep, "ShowDiff", &["src"]);
        up.ignore_case = true;
        assert!(matches!(search_mode(&up), Some(Regex)));
    }

    fn p(tool: Tool, args: &[&str]) -> Opts {
        let mut o = parse(tool, args.iter().map(|s| s.to_string()).collect());
        o.fff_first = false; // deterministic: parse-tests don't depend on the env default
        o
    }

    #[test]
    fn context_flags_parse_all_forms() {
        // space form
        assert_eq!(p(Tool::Ugrep, &["-A", "3", "foo", "src"]).after_context, 3);
        assert_eq!(p(Tool::Ugrep, &["-B", "2", "foo", "src"]).before_context, 2);
        let c = p(Tool::Ugrep, &["-C", "1", "foo", "src"]);
        assert_eq!((c.before_context, c.after_context), (1, 1));
        // attached + long=
        assert_eq!(p(Tool::Ugrep, &["-A3", "foo", "src"]).after_context, 3);
        let c2 = p(Tool::Ugrep, &["-C2", "foo", "src"]);
        assert_eq!((c2.before_context, c2.after_context), (2, 2));
        assert_eq!(
            p(Tool::Ugrep, &["--after-context=4", "foo", "src"]).after_context,
            4
        );
        // non-numeric value -> defer, pattern unconsumed by the flag
        let bad = p(Tool::Ugrep, &["-A", "foo", "src"]);
        assert!(bad.force_fallback);
    }

    #[test]
    fn glob_parsing_serves_extensions_defers_rest() {
        // simple extension include globs -> recorded, served
        assert_eq!(
            p(Tool::Rg, &["-g", "*.ts", "x", "src"]).include_exts,
            vec![".ts"]
        );
        let multi = p(Tool::Rg, &["-g", "*.ts", "-g", "*.tsx", "x", "src"]);
        assert_eq!(multi.include_exts, vec![".ts", ".tsx"]);
        assert!(!multi.force_fallback);
        assert_eq!(
            p(Tool::Ugrep, &["--include=*.json", "x", "src"]).include_exts,
            vec![".json"]
        );
        assert_eq!(
            p(Tool::Rg, &["--glob=*.rs", "x", "src"]).include_exts,
            vec![".rs"]
        );
        // anything beyond a simple extension glob -> defer (never silently ignore)
        for g in ["!node_modules", "src/*.ts", "*.{ts,tsx}", "*.[jt]s", "**/*.ts", "test_*"] {
            assert!(p(Tool::Rg, &["-g", g, "x", "src"]).force_fallback, "{g} should defer");
        }
        // exclude globs defer
        assert!(p(Tool::Ugrep, &["--exclude=*.min.js", "x", "src"]).force_fallback);
        assert!(p(Tool::Ugrep, &["--exclude", "*.min.js", "x", "src"]).force_fallback);
    }

    #[test]
    fn ignore_flags_handled_correctly() {
        // --no-ignore changes file inclusion fff can't replicate -> defer
        assert!(p(Tool::Rg, &["--no-ignore", "x", "."]).force_fallback);
        assert!(p(Tool::Ugrep, &["--include-dir", "y", "x", "src"]).force_fallback);
        // --no-config only affects rg's own config -> no-op, still servable
        let nc = p(Tool::Rg, &["--no-config", "showDiff", "src"]);
        assert!(!nc.force_fallback);
        // --exclude-dir (VCS) is a no-op (fff honors .gitignore)
        let ed = p(Tool::Ugrep, &["--exclude-dir", ".git", "showDiff", "src"]);
        assert!(!ed.force_fallback);
    }

    #[test]
    fn attached_ctx_only_parses_numbers() {
        assert_eq!(attached_ctx("-A3", "-A"), Some(3));
        assert_eq!(attached_ctx("-A", "-A"), None);
        assert_eq!(attached_ctx("-Axyz", "-A"), None);
        assert_eq!(attached_ctx("--context=5", "--context="), Some(5));
    }

    #[test]
    fn context_zeroed_for_non_content_modes() {
        let mut o = opts(Tool::Ugrep, "showDiff", &["src"]);
        o.after_context = 3;
        // -l files-only and -c count drop context
        o.files_only = true;
        assert_eq!(o.to_req(Mode::Plain).after_context, 0);
        o.files_only = false;
        o.count = true;
        assert_eq!(o.to_req(Mode::Plain).after_context, 0);
        // content mode keeps it; rg gets cross-file `--`, ugrep does not
        o.count = false;
        assert_eq!(o.to_req(Mode::Plain).after_context, 3);
        assert!(!o.to_req(Mode::Plain).sep_between_files);
        let mut r = opts(Tool::Rg, "showDiff", &["src"]);
        r.after_context = 1;
        assert!(r.to_req(Mode::Regex).sep_between_files);
    }

    #[test]
    fn fff_first_serves_re2_for_ugrep_but_keeps_correctness_gates() {
        use Mode::*;
        // "fn_a+b": byte-equiv ugrep sees no BRE meta -> literal Plain; fff-first
        // sees ERE '+' -> RE2 Regex (the model's intent).
        let mut p = opts(Tool::Ugrep, "fn_a+b", &["src"]);
        assert!(matches!(search_mode(&p), Some(Plain)));
        p.fff_first = true;
        assert!(matches!(search_mode(&p), Some(Regex)));
        // alternation/groups: literal in BRE, regex in fff-first
        let mut alt = opts(Tool::Ugrep, "Grep(Match|Result)", &["src"]);
        assert!(matches!(search_mode(&alt), Some(Plain)));
        alt.fff_first = true;
        assert!(matches!(search_mode(&alt), Some(Regex)));
        // CORRECTNESS GATES STILL APPLY in fff-first:
        // \s can match the newline -> defer
        let mut ws = opts(Tool::Ugrep, "fn\\s+x", &["src"]);
        ws.fff_first = true;
        assert!(search_mode(&ws).is_none());
        // empty-matching (a* matches the empty string) -> defer
        let mut em = opts(Tool::Ugrep, "a*", &["src"]);
        em.fff_first = true;
        assert!(search_mode(&em).is_none());
        // non-ascii -> defer; ugrep without -r -> defer (unchanged by fff-first)
        let mut na = opts(Tool::Ugrep, "café+", &["src"]);
        na.fff_first = true;
        assert!(search_mode(&na).is_none());
        let mut nr = opts(Tool::Ugrep, "a+b", &["src"]);
        nr.fff_first = true;
        nr.recursive = false;
        assert!(search_mode(&nr).is_none());
    }

    #[test]
    fn effective_pattern_escapes_literal_but_not_regex() {
        // "a+b": literal in BRE (escape the +) but a regex in ERE (keep the +).
        let mut lit = opts(Tool::Ugrep, "a+b", &["src"]);
        lit.ignore_case = true;
        assert_eq!(effective_pattern(&lit, Mode::Regex), "(?i)a\\+b");
        let mut re = opts(Tool::Rg, "a+b", &["src"]);
        re.ignore_case = true;
        assert_eq!(effective_pattern(&re, Mode::Regex), "(?i)a+b");
        // a literal PHRASE (no regex meta, no -i) is escaped so it matches exactly
        let phrase = opts(Tool::Ugrep, "export const", &["src"]);
        assert_eq!(effective_pattern(&phrase, Mode::Regex), "export const");
        // a phrase containing a regex-special char that is NOT a meta for the
        // dialect is escaped (BRE: + is literal -> escape it)
        let p2 = opts(Tool::Ugrep, "a+ b", &["src"]);
        assert_eq!(effective_pattern(&p2, Mode::Regex), "a\\+ b");
    }

    #[test]
    fn search_mode_defers_unsafe() {
        // BRE regex with an ERE-only metachar -> dialect defer
        assert!(search_mode(&opts(Tool::Ugrep, "foo.bar+", &["src"])).is_none());
        // empty-matcher / newline regex -> defer
        assert!(search_mode(&opts(Tool::Rg, "x?", &["src"])).is_none());
        assert!(search_mode(&opts(Tool::Rg, "a\\s+b", &["src"])).is_none());
        // non-ascii -> defer
        assert!(search_mode(&opts(Tool::Ugrep, "café", &["src"])).is_none());
        // ugrep without -r -> defer
        let mut nr = opts(Tool::Ugrep, "showDiff", &["src"]);
        nr.recursive = false;
        assert!(search_mode(&nr).is_none());
        // a non-existent / non-dir path, ./ arg, or absolute arg -> defer
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["src", "nope_xyz"])).is_none());
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["./src"])).is_none());
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &["/tmp"])).is_none());
        // "." mixed into a multi-path search -> defer (overlap/double-report)
        assert!(search_mode(&opts(Tool::Ugrep, "showDiff", &[".", "src"])).is_none());
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
