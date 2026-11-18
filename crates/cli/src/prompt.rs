//! Questions for a person at the keyboard. Never used when there is none.

use std::io::{self, BufRead, IsTerminal, Write};

/// True when a person can answer questions: both input and output are a terminal.
pub fn someone_is_here() -> bool {
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

/// Asks for a line of text. An empty answer picks the default.
pub fn ask(question: &str, default: Option<&str>) -> io::Result<String> {
    loop {
        match default {
            Some(d) => print!("{question} [{d}]: "),
            None => print!("{question}: "),
        }
        io::stdout().flush()?;
        let mut line = String::new();
        if io::stdin().lock().read_line(&mut line)? == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "no answer"));
        }
        let answer = line.trim();
        if !answer.is_empty() {
            return Ok(answer.to_string());
        }
        if let Some(d) = default {
            return Ok(d.to_string());
        }
    }
}

/// Asks for a new password without showing it. Enter on the first prompt
/// skips (when `optional`). Asks twice to catch typos.
pub fn new_password(question: &str, optional: bool) -> io::Result<Option<String>> {
    loop {
        let first = rpassword::prompt_password(format!("{question}: "))?;
        if first.is_empty() {
            if optional {
                return Ok(None);
            }
            println!("The password cannot be empty.");
            continue;
        }
        let again = rpassword::prompt_password("Type it again: ")?;
        if first == again {
            return Ok(Some(first));
        }
        println!("Those did not match. Try again.");
    }
}

/// Reads one password from piped input, for `--password-stdin`.
pub fn password_from_stdin() -> io::Result<String> {
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line)?;
    let password = line.trim_end_matches(['\n', '\r']).to_string();
    if password.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "--password-stdin got an empty password",
        ));
    }
    Ok(password)
}
