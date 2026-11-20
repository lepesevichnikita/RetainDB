//! Command-line surface: four subcommands, no hidden state.
//!
//! ```text
//! retaindb-repo enroll --root <abs path>
//! retaindb-repo hook --client <claude|codex|hermes>
//! retaindb-repo sync --root <abs path>
//! retaindb-repo status --root <abs path>
//! ```

use std::io::{Read, Write};
use std::path::PathBuf;

use crate::enrollment;
use crate::git::ProcessGit;
use crate::hint::Client;
use crate::hook::{self, Outcome};
use crate::status;
use crate::store::{Store, StoreError};
use crate::sync::{self, SyncOptions};

/// Help text shown for usage errors and `--help`.
pub const USAGE: &str = "\
usage:
  retaindb-repo enroll --root <abs path>
  retaindb-repo hook --client <claude|codex|hermes>
  retaindb-repo sync --root <abs path>
  retaindb-repo status --root <abs path>";

/// Exit codes: `0` success/fail-open, `1` operation failed, `2` bad usage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exit {
    Ok,
    Failed,
    Usage,
}

impl Exit {
    /// Process exit status.
    pub fn code(self) -> i32 {
        match self {
            Self::Ok => 0,
            Self::Failed => 1,
            Self::Usage => 2,
        }
    }
}

/// Run one command. `stdin` feeds `hook`; nothing else reads it.
pub fn run(args: &[String], stdin: &mut dyn Read, out: &mut dyn Write, store: &Store) -> i32 {
    match dispatch(args, stdin, out, store) {
        Ok(()) => Exit::Ok.code(),
        Err(Failure::Usage(message)) => {
            eprintln!("error: {message}\n{USAGE}");
            Exit::Usage.code()
        }
        Err(Failure::Operation(message)) => {
            eprintln!("error: {message}");
            Exit::Failed.code()
        }
    }
}

enum Failure {
    Usage(String),
    Operation(String),
}

fn dispatch(
    args: &[String],
    stdin: &mut dyn Read,
    out: &mut dyn Write,
    store: &Store,
) -> Result<(), Failure> {
    let (command, rest) = match args.split_first() {
        Some(split) => split,
        None => return Err(Failure::Usage("missing subcommand".to_string())),
    };
    match command.as_str() {
        "enroll" => enroll(rest, out, store),
        "hook" => hook_command(rest, stdin, store),
        "sync" => sync_command(rest, out, store),
        "status" => status_command(rest, out, store),
        "-h" | "--help" => write_lines(out, &[USAGE.to_string()]),
        other => Err(Failure::Usage(format!("unknown subcommand {other}"))),
    }
}

fn enroll(rest: &[String], out: &mut dyn Write, store: &Store) -> Result<(), Failure> {
    check_flags(rest, &["--root"])?;
    let root = flag_value(rest, "--root")?;
    let record = enrollment::enroll(store, &PathBuf::from(&root)).map_err(operation)?;
    write_lines(
        out,
        &[
            format!("root={}", record.root.display()),
            format!("enrollment_id={}", record.enrollment_id),
        ],
    )
}

fn hook_command(rest: &[String], stdin: &mut dyn Read, store: &Store) -> Result<(), Failure> {
    // The hook is the one place where usage errors also fail open: a broken
    // hook registration must never block the client's tool call. The payload is
    // still drained, or the client's write fails with `EPIPE`.
    let Ok(client) = resolve_client(rest) else {
        hook::drain(stdin);
        eprintln!("note: hook event ignored: unrecognised --client argument");
        return Ok(());
    };
    match hook::handle(client, stdin, store) {
        Outcome::Enqueued(_) => Ok(()),
        Outcome::Ignored(reason) => {
            eprintln!("note: hook event ignored: {reason}");
            Ok(())
        }
        Outcome::Unavailable(reason) => {
            eprintln!("warning: hint dropped: {reason}");
            Ok(())
        }
    }
}

fn resolve_client(rest: &[String]) -> Result<Client, Failure> {
    check_flags(rest, &["--client"])?;
    let raw = flag_value(rest, "--client")?;
    Client::parse(&raw).ok_or_else(|| {
        Failure::Usage(format!(
            "unknown client {raw}; expected claude, codex or hermes"
        ))
    })
}

fn sync_command(rest: &[String], out: &mut dyn Write, store: &Store) -> Result<(), Failure> {
    check_flags(rest, &["--root"])?;
    let root = PathBuf::from(flag_value(rest, "--root")?);
    let outcome =
        sync::run(&root, store, &ProcessGit, &SyncOptions::default()).map_err(operation)?;
    write_lines(
        out,
        &[
            format!("generation={}", outcome.generation),
            format!("upserts={}", outcome.upserts),
            format!("tombstones={}", outcome.tombstones),
            format!("skipped={}", outcome.skipped),
            format!("hashed={}", outcome.hashed),
            format!("hashed_paths={}", outcome.hashed_paths.join(",")),
        ],
    )
}

fn status_command(rest: &[String], out: &mut dyn Write, store: &Store) -> Result<(), Failure> {
    check_flags(rest, &["--root"])?;
    let requested = PathBuf::from(flag_value(rest, "--root")?);
    let report = status::report(store).map_err(operation)?;
    if !report.matches(&requested) {
        return Err(Failure::Operation(format!(
            "{} is not the enrolled root {}",
            requested.display(),
            report.root.display()
        )));
    }
    write_lines(out, &report.lines())
}

fn operation(error: impl std::fmt::Display) -> Failure {
    Failure::Operation(error.to_string())
}

fn write_lines(out: &mut dyn Write, lines: &[String]) -> Result<(), Failure> {
    for line in lines {
        writeln!(out, "{line}").map_err(|error| Failure::Operation(error.to_string()))?;
    }
    Ok(())
}

fn check_flags(rest: &[String], known: &[&str]) -> Result<(), Failure> {
    let mut index = 0;
    while index < rest.len() {
        let flag = &rest[index];
        if !known.contains(&flag.as_str()) {
            return Err(Failure::Usage(format!("unexpected argument {flag}")));
        }
        if index + 1 >= rest.len() {
            return Err(Failure::Usage(format!("{flag} needs a value")));
        }
        index += 2;
    }
    Ok(())
}

fn flag_value(rest: &[String], name: &str) -> Result<String, Failure> {
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        if arg == name {
            return iter
                .next()
                .cloned()
                .ok_or_else(|| Failure::Usage(format!("{name} needs a value")));
        }
    }
    Err(Failure::Usage(format!("missing {name}")))
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Self::Operation(error.to_string())
    }
}
