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
        .expect("usage: replace-data <container> <database>");
    let database = args
        .next()
        .expect("usage: replace-data <container> <database>");

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

    match dai_sectioned::replace_data(&mut file, size, &data) {
        Ok(generation) => println!("{}", generation),
        Err(error) => {
            eprintln!("{}", error);
            std::process::exit(1);
        }
    }
}
