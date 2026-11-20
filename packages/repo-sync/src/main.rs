//! Binary entry point; all behaviour lives in the library so tests can drive
//! the same code the client runs.

use std::io::Write;
use std::process::ExitCode;

use retaindb_repo::{cli, store::Store};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let store = match Store::from_env() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(1);
        }
    };
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let code = cli::run(&args, &mut stdin, &mut stdout, &store);
    let _ = stdout.flush();
    ExitCode::from(code as u8)
}
