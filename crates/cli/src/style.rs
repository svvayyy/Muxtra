//! Colors for terminal output, in the Muxtra space palette.
//!
//! Colors only appear when a person is looking: output to an agent, a pipe
//! or a file is always plain text, and `NO_COLOR` turns them off everywhere.
//! On light terminal backgrounds the palette switches to deeper shades so it
//! stays readable. `MUXTRA_THEME=light` or `dark` overrides the guess, and
//! `FORCE_COLOR=1` turns colors on even without a terminal.

use std::io::IsTerminal;
use std::sync::OnceLock;

/// What a piece of text means. Each role has one color.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// Your values: a Mac model, a name, a module, a field in an error.
    Value,
    /// Starters and the next step.
    Accent,
    /// Heads-ups worth noticing.
    Warn,
    /// Success.
    Ok,
    /// Errors.
    Err,
    /// Explanations.
    Dim,
    /// Commands you can type.
    Cmd,
    /// Ordinary text in the terminal's own color.
    Plain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Theme {
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Depth {
    TrueColor,
    Ansi256,
}

/// How to paint one output stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Painter {
    colors: Option<(Theme, Depth)>,
}

impl Painter {
    pub const PLAIN: Painter = Painter { colors: None };

    /// Wraps text in the color for its role, or returns it unchanged.
    pub fn paint(&self, role: Role, text: &str) -> String {
        let Some((theme, depth)) = self.colors.filter(|_| role != Role::Plain) else {
            return text.to_string();
        };
        let (r, g, b) = rgb(theme, role);
        let color = match depth {
            Depth::TrueColor => format!("38;2;{r};{g};{b}"),
            Depth::Ansi256 => format!("38;5;{}", nearest_256(r, g, b)),
        };
        let bold = if role == Role::Cmd { "1;" } else { "" };
        format!("\x1b[{bold}{color}m{text}\x1b[0m")
    }

    /// Paints a sentence in one role, with `backticked` commands in the
    /// command color. Plain output keeps the backticks so agents still see
    /// exactly what to type.
    pub fn rich(&self, base: Role, text: &str) -> String {
        if self.colors.is_none() {
            return text.to_string();
        }
        text.split('`')
            .enumerate()
            .filter(|(_, part)| !part.is_empty())
            .map(|(i, part)| {
                let role = if i % 2 == 1 { Role::Cmd } else { base };
                self.paint(role, part)
            })
            .collect()
    }

    /// A label padded to line up in a column, painted as an explanation.
    pub fn label(&self, text: &str) -> String {
        self.paint(Role::Dim, &format!("{text:<9}"))
    }
}

/// The palette. Dark terminals get light pastels, light terminals get
/// deeper shades of the same hues.
fn rgb(theme: Theme, role: Role) -> (u8, u8, u8) {
    match (theme, role) {
        (Theme::Dark, Role::Value) => (0x8f, 0xd0, 0xf5),
        (Theme::Dark, Role::Accent) => (0xb9, 0xb4, 0xf5),
        (Theme::Dark, Role::Warn) => (0xf6, 0xc8, 0x7a),
        (Theme::Dark, Role::Ok) => (0x8f, 0xe3, 0xbf),
        (Theme::Dark, Role::Err) => (0xf5, 0x9c, 0x9c),
        (Theme::Dark, Role::Dim) => (0x80, 0x88, 0x99),
        (Theme::Dark, Role::Cmd) => (0xf4, 0xf6, 0xfa),
        (Theme::Light, Role::Value) => (0x1f, 0x6f, 0xa8),
        (Theme::Light, Role::Accent) => (0x5b, 0x4f, 0xc4),
        (Theme::Light, Role::Warn) => (0x9a, 0x64, 0x00),
        (Theme::Light, Role::Ok) => (0x1d, 0x7a, 0x52),
        (Theme::Light, Role::Err) => (0xb4, 0x2d, 0x2d),
        (Theme::Light, Role::Dim) => (0x6b, 0x72, 0x80),
        (Theme::Light, Role::Cmd) => (0x11, 0x18, 0x27),
        (_, Role::Plain) => unreachable!("plain text is never painted"),
    }
}

/// Painter for standard output.
pub fn out() -> &'static Painter {
    static OUT: OnceLock<Painter> = OnceLock::new();
    OUT.get_or_init(|| decide(std::io::stdout().is_terminal(), &Env::from_process()))
}

/// Painter for error output.
pub fn err() -> &'static Painter {
    static ERR: OnceLock<Painter> = OnceLock::new();
    ERR.get_or_init(|| decide(std::io::stderr().is_terminal(), &Env::from_process()))
}

/// The environment variables that affect colors.
#[derive(Default)]
struct Env {
    no_color: Option<String>,
    force_color: Option<String>,
    term: Option<String>,
    colorterm: Option<String>,
    theme: Option<String>,
    colorfgbg: Option<String>,
}

impl Env {
    fn from_process() -> Env {
        let var = |k: &str| std::env::var(k).ok();
        Env {
            no_color: var("NO_COLOR"),
            force_color: var("FORCE_COLOR"),
            term: var("TERM"),
            colorterm: var("COLORTERM"),
            theme: var("MUXTRA_THEME"),
            colorfgbg: var("COLORFGBG"),
        }
    }
}

fn set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.is_empty())
}

fn decide(is_terminal: bool, env: &Env) -> Painter {
    let forced = set(&env.force_color) && env.force_color.as_deref() != Some("0");
    let dumb = env.term.as_deref() == Some("dumb");
    if set(&env.no_color) || (!forced && (!is_terminal || dumb)) {
        return Painter::PLAIN;
    }
    let depth = match env.colorterm.as_deref() {
        Some("truecolor") | Some("24bit") => Depth::TrueColor,
        _ => Depth::Ansi256,
    };
    let theme = match env.theme.as_deref() {
        Some("light") => Theme::Light,
        Some("dark") => Theme::Dark,
        _ => env
            .colorfgbg
            .as_deref()
            .and_then(theme_from_colorfgbg)
            .or_else(|| if is_terminal { ask_terminal() } else { None })
            .unwrap_or(Theme::Dark),
    };
    Painter {
        colors: Some((theme, depth)),
    }
}

/// `COLORFGBG` looks like "15;0": foreground;background as palette indexes.
fn theme_from_colorfgbg(value: &str) -> Option<Theme> {
    let bg: u8 = value.rsplit(';').next()?.parse().ok()?;
    Some(if matches!(bg, 7 | 15) {
        Theme::Light
    } else {
        Theme::Dark
    })
}

/// Asks the terminal for its background color (OSC 11). Gives up quickly
/// and quietly if the terminal does not answer.
#[cfg(unix)]
fn ask_terminal() -> Option<Theme> {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;

    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/tty")
        .ok()?;
    let fd = tty.as_raw_fd();
    // SAFETY: termios and poll calls on a file descriptor we own. The
    // original terminal settings are always restored before returning.
    unsafe {
        let mut original: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(fd, &mut original) != 0 {
            return None;
        }
        let mut raw = original;
        libc::cfmakeraw(&mut raw);
        if libc::tcsetattr(fd, libc::TCSANOW, &raw) != 0 {
            return None;
        }
        let mut reply = Vec::new();
        let asked = tty
            .write_all(b"\x1b]11;?\x07")
            .and_then(|_| tty.flush())
            .is_ok();
        if asked {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
            let mut buf = [0u8; 64];
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                let mut pfd = libc::pollfd {
                    fd,
                    events: libc::POLLIN,
                    revents: 0,
                };
                if libc::poll(&mut pfd, 1, left.as_millis() as libc::c_int) <= 0 {
                    break;
                }
                match tty.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => reply.extend_from_slice(&buf[..n]),
                }
                if reply.ends_with(b"\x07") || reply.ends_with(b"\x1b\\") {
                    break;
                }
            }
        }
        libc::tcsetattr(fd, libc::TCSANOW, &original);
        theme_from_reply(&String::from_utf8_lossy(&reply))
    }
}

#[cfg(not(unix))]
fn ask_terminal() -> Option<Theme> {
    None
}

/// Reads a reply like "\x1b]11;rgb:1e1e/1e1e/1e1e\x07".
fn theme_from_reply(reply: &str) -> Option<Theme> {
    let rgb = reply.split("rgb:").nth(1)?;
    let rgb = rgb.trim_end_matches(['\x07', '\\', '\x1b']);
    let mut parts = rgb.split('/').map(|hex| {
        let hex = hex.trim_end_matches(['\x07', '\\', '\x1b']);
        let max = 16f32.powi(hex.len() as i32) - 1.0;
        u32::from_str_radix(hex, 16).ok().map(|v| v as f32 / max)
    });
    let (r, g, b) = (parts.next()??, parts.next()??, parts.next()??);
    let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    Some(if luminance > 0.5 {
        Theme::Light
    } else {
        Theme::Dark
    })
}

/// Closest color in the xterm 256-color palette, for terminals without
/// 24-bit color (such as Apple's Terminal).
fn nearest_256(r: u8, g: u8, b: u8) -> u8 {
    const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
    let level = |c: u8| {
        LEVELS
            .iter()
            .enumerate()
            .min_by_key(|(_, l)| (c as i32 - **l as i32).abs())
            .map(|(i, _)| i as u8)
            .unwrap()
    };
    let distance = |(cr, cg, cb): (u8, u8, u8)| {
        let d = |x: u8, y: u8| (x as i32 - y as i32).pow(2);
        d(cr, r) + d(cg, g) + d(cb, b)
    };
    let (ri, gi, bi) = (level(r), level(g), level(b));
    let cube = (
        LEVELS[ri as usize],
        LEVELS[gi as usize],
        LEVELS[bi as usize],
    );
    let cube_index = 16 + 36 * ri + 6 * gi + bi;
    let gray_step = ((r as u32 + g as u32 + b as u32) / 3).saturating_sub(3) / 10;
    let gray_step = gray_step.min(23) as u8;
    let gray_value = 8 + 10 * gray_step;
    let gray = (gray_value, gray_value, gray_value);
    if distance(gray) < distance(cube) {
        232 + gray_step
    } else {
        cube_index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Env {
        let get = |k: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.to_string())
        };
        Env {
            no_color: get("NO_COLOR"),
            force_color: get("FORCE_COLOR"),
            term: get("TERM"),
            colorterm: get("COLORTERM"),
            theme: get("MUXTRA_THEME"),
            colorfgbg: get("COLORFGBG"),
        }
    }

    #[test]
    fn plain_without_a_terminal() {
        assert_eq!(decide(false, &env(&[])), Painter::PLAIN);
        assert_eq!(Painter::PLAIN.paint(Role::Value, "iMac14,4"), "iMac14,4");
    }

    #[test]
    fn no_color_wins() {
        let e = env(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")]);
        assert_eq!(decide(true, &e), Painter::PLAIN);
        // An empty NO_COLOR does not count, per no-color.org.
        let e = env(&[("NO_COLOR", ""), ("MUXTRA_THEME", "dark")]);
        assert_ne!(decide(true, &e), Painter::PLAIN);
    }

    #[test]
    fn dumb_terminals_stay_plain() {
        assert_eq!(decide(true, &env(&[("TERM", "dumb")])), Painter::PLAIN);
    }

    #[test]
    fn force_color_and_themes() {
        let dark = decide(
            false,
            &env(&[("FORCE_COLOR", "1"), ("COLORTERM", "truecolor")]),
        );
        assert_eq!(
            dark.paint(Role::Value, "x"),
            "\x1b[38;2;143;208;245mx\x1b[0m"
        );
        let light = decide(
            false,
            &env(&[
                ("FORCE_COLOR", "1"),
                ("COLORTERM", "truecolor"),
                ("MUXTRA_THEME", "light"),
            ]),
        );
        assert_eq!(
            light.paint(Role::Value, "x"),
            "\x1b[38;2;31;111;168mx\x1b[0m"
        );
        assert!(light.paint(Role::Cmd, "x").starts_with("\x1b[1;"));
        assert_eq!(decide(false, &env(&[("FORCE_COLOR", "0")])), Painter::PLAIN);
    }

    #[test]
    fn falls_back_to_256_colors() {
        let p = decide(
            false,
            &env(&[("FORCE_COLOR", "1"), ("MUXTRA_THEME", "dark")]),
        );
        assert!(p.paint(Role::Ok, "x").starts_with("\x1b[38;5;"));
    }

    #[test]
    fn rich_text_highlights_commands() {
        let plain = Painter::PLAIN.rich(Role::Dim, "run `muxtra passwd` yourself");
        assert_eq!(plain, "run `muxtra passwd` yourself");
        let p = decide(
            false,
            &env(&[
                ("FORCE_COLOR", "1"),
                ("COLORTERM", "truecolor"),
                ("MUXTRA_THEME", "dark"),
            ]),
        );
        let colored = p.rich(Role::Dim, "run `muxtra passwd` yourself");
        assert!(!colored.contains('`'), "{colored:?}");
        assert!(
            colored.contains("\x1b[1;38;2;244;246;250mmuxtra passwd\x1b[0m"),
            "{colored:?}"
        );
    }

    #[test]
    fn colorfgbg() {
        assert_eq!(theme_from_colorfgbg("15;0"), Some(Theme::Dark));
        assert_eq!(theme_from_colorfgbg("0;15"), Some(Theme::Light));
        assert_eq!(theme_from_colorfgbg("0;default;15"), Some(Theme::Light));
        assert_eq!(theme_from_colorfgbg("nonsense"), None);
    }

    #[test]
    fn terminal_replies() {
        assert_eq!(
            theme_from_reply("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"),
            Some(Theme::Dark)
        );
        assert_eq!(
            theme_from_reply("\x1b]11;rgb:ffff/ffff/ffff\x1b\\"),
            Some(Theme::Light)
        );
        assert_eq!(
            theme_from_reply("\x1b]11;rgb:fa/f8/f0\x07"),
            Some(Theme::Light)
        );
        assert_eq!(theme_from_reply(""), None);
    }

    #[test]
    fn nearest_256_colors() {
        assert_eq!(nearest_256(0, 0, 0), 16);
        assert_eq!(nearest_256(255, 255, 255), 231);
        assert_eq!(nearest_256(0x80, 0x80, 0x80), 244);
        // Ice blue lands on a light blue, not a gray.
        let ice = nearest_256(0x8f, 0xd0, 0xf5);
        assert!((16..232).contains(&ice), "{ice}");
    }
}
