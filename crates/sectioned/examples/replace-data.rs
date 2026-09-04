//! Replaces a container's database from the command line.
//!
//! Exists so the TypeScript test suite can drive the real Rust writer and then
//! read the result with the real TypeScript verifier. Two implementations of a
//! format that have never been pointed at each other's output are two formats.
//!
//! Usage: replace-data <container.dai> <database.sqlite>

use std::fs::OpenOptions;

fn main() {
    let mut args = std::env::args().skip(1);
    let container = args
        .next()
        .expect("usage: replace-data <container> <database> [expected-generation]");
    let database = args
        .next()
        .expect("usage: replace-data <container> <database> [expected-generation]");
    // Optional, so the round-trip test can drive both the guarded and unguarded
    // writes through the same binary the desktop calls.
    let expected: Option<u64> = args.next().and_then(|value| value.parse().ok());

    let data = std::fs::read(&database).expect("failed to read the database");

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&container)
        .expect("failed to open the container");
    let size = file
        .metadata()
        .expect("failed to measure the container")
        .len();

    let outcome = match expected {
        Some(generation) => {
            dai_sectioned::replace_data_if_unchanged(&mut file, size, &data, generation)
        }
        None => dai_sectioned::replace_data(&mut file, size, &data),
    };

    match outcome {
        Ok(generation) => println!("{}", generation),
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
