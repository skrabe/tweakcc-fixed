use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;

use super::{Flavor, Viewer};

fn positive_count(value: &[u8], flavor: Flavor) -> bool {
    let value = value.strip_prefix(b"+").unwrap_or(value);
    let digits = value.iter().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 || !value[..digits].iter().any(|b| *b != b'0') {
        return false;
    }
    let suffix = &value[digits..];
    suffix.is_empty()
        || flavor.gnu_syntax()
            && (suffix == b"b"
                || suffix == b"kB"
                || matches!(
                    suffix.first(),
                    Some(b'K' | b'M' | b'G' | b'T' | b'P' | b'E' | b'Z' | b'Y' | b'R' | b'Q')
                ) && matches!(&suffix[1..], b"" | b"B" | b"iB"))
}

pub(super) fn operands(
    viewer: Viewer,
    flavor: Flavor,
    args: &[OsString],
    permute: bool,
) -> Option<Vec<OsString>> {
    let mut files = Vec::new();
    let mut options = true;
    let mut explicit_script = false;
    let mut index = 0;
    while index < args.len() {
        let bytes = args[index].as_bytes();
        if options && bytes == b"--" {
            options = false;
        } else if options
            && index == 0
            && matches!(viewer, Viewer::Head | Viewer::Tail)
            && bytes.starts_with(b"-")
            && bytes.len() > 1
            && bytes[1..].iter().all(u8::is_ascii_digit)
        {
            if !positive_count(&bytes[1..], flavor) {
                return None;
            }
        } else if options
            && index == 0
            && viewer == Viewer::Tail
            && bytes.starts_with(b"+")
            && bytes.len() > 1
            && bytes[1..].iter().all(u8::is_ascii_digit)
        {
            if !positive_count(bytes, flavor) {
                return None;
            }
        } else if options && bytes.starts_with(b"--") {
            if !flavor.gnu_syntax() {
                return None;
            }
            let (name, attached) = bytes
                .iter()
                .position(|b| *b == b'=')
                .map_or((bytes, None), |i| (&bytes[..i], Some(&bytes[i + 1..])));
            let value_option = match viewer {
                Viewer::Head | Viewer::Tail => matches!(name, b"--lines" | b"--bytes"),
                Viewer::Sed => matches!(name, b"--expression" | b"--file" | b"--line-length"),
                Viewer::Cat => false,
            };
            if value_option {
                let value = if let Some(value) = attached {
                    value
                } else {
                    index += 1;
                    args.get(index)?.as_bytes()
                };
                if viewer == Viewer::Sed {
                    if name == b"--line-length" {
                        if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
                            return None;
                        }
                    } else {
                        explicit_script = true;
                    }
                } else if !positive_count(value, flavor) {
                    return None;
                }
            } else {
                if attached.is_some() {
                    return None;
                }
                let accepted = match viewer {
                    Viewer::Cat => matches!(
                        name,
                        b"--show-all"
                            | b"--number"
                            | b"--number-nonblank"
                            | b"--squeeze-blank"
                            | b"--show-ends"
                            | b"--show-tabs"
                            | b"--show-nonprinting"
                    ),
                    Viewer::Head | Viewer::Tail => matches!(
                        name,
                        b"--quiet" | b"--silent" | b"--verbose" | b"--zero-terminated"
                    ),
                    Viewer::Sed => matches!(
                        name,
                        b"--quiet"
                            | b"--silent"
                            | b"--regexp-extended"
                            | b"--unbuffered"
                            | b"--separate"
                            | b"--sandbox"
                            | b"--posix"
                            | b"--binary"
                            | b"--null-data"
                            | b"--debug"
                    ),
                };
                if !accepted {
                    return None;
                }
            }
        } else if options && bytes.starts_with(b"-") && bytes.len() > 1 {
            let mut short = 1;
            while short < bytes.len() {
                let flag = bytes[short];
                let value_option = match viewer {
                    Viewer::Head | Viewer::Tail => matches!(flag, b'n' | b'c'),
                    Viewer::Sed => {
                        matches!(flag, b'e' | b'f') || flag == b'l' && flavor.gnu_syntax()
                    }
                    Viewer::Cat => false,
                };
                if value_option {
                    let value = if short + 1 < bytes.len() {
                        &bytes[short + 1..]
                    } else {
                        index += 1;
                        args.get(index)?.as_bytes()
                    };
                    if viewer == Viewer::Sed {
                        if flag == b'l' {
                            if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
                                return None;
                            }
                        } else {
                            explicit_script = true;
                        }
                    } else if !positive_count(value, flavor) {
                        return None;
                    }
                    break;
                }
                let accepted = match viewer {
                    Viewer::Cat => {
                        b"benstuv".contains(&flag) || flavor.gnu_syntax() && b"AET".contains(&flag)
                    }
                    Viewer::Head | Viewer::Tail => {
                        b"qv".contains(&flag) || flavor.gnu_syntax() && flag == b'z'
                    }
                    Viewer::Sed => {
                        b"nEu".contains(&flag)
                            || flavor.gnu_syntax() && b"rsbz".contains(&flag)
                            || flavor == Flavor::Bsd && b"alr".contains(&flag)
                    }
                };
                if !accepted {
                    return None;
                }
                short += 1;
            }
        } else {
            files.push(args[index].clone());
            if !permute {
                options = false;
            }
        }
        index += 1;
    }
    if viewer == Viewer::Sed {
        if !explicit_script {
            if files.is_empty() {
                return None;
            }
            files.remove(0);
        }
        if files.len() != 1 {
            return None;
        }
    }
    files.retain(|file| file != "-");
    (!files.is_empty()).then_some(files)
}
