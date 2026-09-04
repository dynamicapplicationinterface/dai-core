//! Saving a `.dai` by writing the database and nothing else.
//!
//! The sectioned layout exists for this. A container's manifest carries the
//! publisher's signature over the application; the database is not signed,
//! because a container holds no private key and could never re-sign after a
//! save. So a save must leave the manifest and the payload byte-identical, or
//! the signature it carries stops describing the file it is in.
//!
//! The viewer form cannot do that — saving one rewrites the whole document. The
//! host does it here with positioned writes: the data section is last, so it
//! can grow or shrink by moving only the end of the file, and every byte before
//! its offset is untouched.
//!
//! ## Crash behaviour
//!
//! An in-place write cannot be atomic; that is the trade for not copying a file
//! that may be hundreds of megabytes on every save. What it can be is *ordered*.
//! The data is written and flushed before the section table and footer are
//! touched, so a crash in the middle leaves a file whose recorded digest does
//! not match its contents. Verification reports a damaged database, which is
//! the truth. The failure this ordering rules out is the dangerous one: a file
//! that reports itself intact while holding a half-written database.
//!
//! Everything here works against `Read + Write + Seek` rather than `File`, so
//! the tests exercise the code an actual save runs against a buffer in memory.

use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};

pub const MAGIC: [u8; 4] = [0x44, 0x41, 0x49, 0x00];
pub const FOOTER_MAGIC: [u8; 4] = [0x00, 0x49, 0x41, 0x44];
pub const FORMAT_VERSION: u16 = 2;

const HEADER_BYTES: u64 = 12;
const TOC_ENTRY_BYTES: u64 = 56;
const FOOTER_BYTES: u64 = 64;
const ALIGNMENT: u64 = 4096;
const SECTION_DATA: u8 = 3;

/// A container with more sections than this is not one we wrote. The bound
/// exists so a corrupt count cannot make the host allocate against a number it
/// read out of a damaged file.
const MAX_SECTIONS: u32 = 16;

/// The first bytes of every SQLite file, including an empty one.
const SQLITE_HEADER: &[u8] = b"SQLite format 3\0";

fn align(value: u64) -> u64 {
    value.div_ceil(ALIGNMENT) * ALIGNMENT
}

/// Changing the length of a file, which `Seek` does not cover.
///
/// Implemented for `std::fs::File` and, in the tests, for an in-memory buffer.
pub trait Resize {
    fn resize(&mut self, length: u64) -> std::io::Result<()>;
    fn sync(&mut self) -> std::io::Result<()>;
}

impl Resize for std::fs::File {
    fn resize(&mut self, length: u64) -> std::io::Result<()> {
        self.set_len(length)
    }

    fn sync(&mut self) -> std::io::Result<()> {
        self.sync_all()
    }
}

#[derive(Debug, Clone, Copy)]
struct Entry {
    id: u8,
    offset: u64,
    length: u64,
    /// Where this entry's own record begins, so its digest can be rewritten.
    at: u64,
}

fn read_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn read_u64(bytes: &[u8], at: usize) -> u64 {
    let mut buffer = [0u8; 8];
    buffer.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(buffer)
}

fn read_exact_at<F: Read + Seek>(file: &mut F, at: u64, length: usize) -> Result<Vec<u8>, String> {
    let mut buffer = vec![0u8; length];
    file.seek(SeekFrom::Start(at))
        .map_err(|e| format!("Failed to seek to {}: {}", at, e))?;
    file.read_exact(&mut buffer)
        .map_err(|e| format!("Failed to read {} bytes at {}: {}", length, at, e))?;
    Ok(buffer)
}

fn write_all_at<F: Write + Seek>(file: &mut F, at: u64, bytes: &[u8]) -> Result<(), String> {
    file.seek(SeekFrom::Start(at))
        .map_err(|e| format!("Failed to seek to {}: {}", at, e))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write {} bytes at {}: {}", bytes.len(), at, e))
}

fn digest(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// True when a file begins with the container magic.
///
/// The form is decided by the leading bytes and never by the extension, because
/// an extension is a claim made by whoever named the file.
pub fn looks_sectioned(head: &[u8]) -> bool {
    head.len() >= MAGIC.len() && head[..MAGIC.len()] == MAGIC
}

fn read_table<F: Read + Seek>(file: &mut F, size: u64) -> Result<Vec<Entry>, String> {
    if size < HEADER_BYTES + FOOTER_BYTES {
        return Err("Too short to be a container.".into());
    }

    let header = read_exact_at(file, 0, HEADER_BYTES as usize)?;
    if !looks_sectioned(&header) {
        return Err("Not a DAI container: the leading magic is wrong.".into());
    }

    let version = read_u16(&header, 4);
    if version != FORMAT_VERSION {
        return Err(format!(
            "This container is format version {}, and this host writes version {}.",
            version, FORMAT_VERSION
        ));
    }

    let count = read_u32(&header, 8);
    if count == 0 || count > MAX_SECTIONS {
        return Err(format!("A section count of {} is not credible.", count));
    }

    let table = read_exact_at(
        file,
        HEADER_BYTES,
        (TOC_ENTRY_BYTES * u64::from(count)) as usize,
    )?;

    let mut entries = Vec::with_capacity(count as usize);
    for index in 0..u64::from(count) {
        let at = (index * TOC_ENTRY_BYTES) as usize;
        let entry = Entry {
            id: table[at],
            offset: read_u64(&table, at + 4),
            length: read_u64(&table, at + 12),
            at: HEADER_BYTES + index * TOC_ENTRY_BYTES,
        };

        // A section claiming to live past the end of the file is the shape a
        // truncated download takes, and reading it would panic rather than
        // explain itself.
        if entry.offset.saturating_add(entry.length) > size {
            return Err(format!(
                "Section {} claims bytes past the end of the file.",
                entry.id
            ));
        }

        entries.push(entry);
    }

    Ok(entries)
}

/// Overwrites the database section, leaving the manifest and payload untouched.
///
/// Returns the generation the file now carries. `size` is the file's current
/// length, which the caller already knows.
pub fn replace_data<F: Read + Write + Seek + Resize>(
    file: &mut F,
    size: u64,
    data: &[u8],
) -> Result<u64, String> {
    write_data(file, size, data, None)
}

/**
 * The same write, refusing when the file has moved on without us.
 *
 * Two windows on one document is the case nobody has a lock for. A lock would
 * be the complete answer and needs a mechanism that works across processes on
 * three operating systems; this is the half that needs nothing, because the
 * footer already records how many times the file has been saved.
 *
 * A host that read generation 7 and asks to write on top of 7 gets to write. A
 * host that read 7 while another window has since written 8 is told, and the
 * work it is holding is still in memory to be dealt with — which is a great
 * deal better than the last writer silently winning.
 */
pub fn replace_data_if_unchanged<F: Read + Write + Seek + Resize>(
    file: &mut F,
    size: u64,
    data: &[u8],
    expected_generation: u64,
) -> Result<u64, String> {
    write_data(file, size, data, Some(expected_generation))
}

fn write_data<F: Read + Write + Seek + Resize>(
    file: &mut F,
    size: u64,
    data: &[u8],
    expected_generation: Option<u64>,
) -> Result<u64, String> {
    if data.len() < SQLITE_HEADER.len() || &data[..SQLITE_HEADER.len()] != SQLITE_HEADER {
        // The same guard the viewer-form save applies to HTML: refuse to
        // overwrite somebody's only copy of their data with something that is
        // plainly not a database.
        return Err(
            "The container sent something that is not a SQLite database; refusing to overwrite."
                .into(),
        );
    }

    let entries = read_table(file, size)?;

    let data_entry = *entries
        .iter()
        .find(|entry| entry.id == SECTION_DATA)
        .ok_or("This container has no data section, so there is nothing to save into.")?;

    // Only the last section can change length without moving another one. Every
    // container this project writes puts the database last; one that does not
    // is either from a future layout or damaged, and the honest answer is to
    // refuse rather than to relocate sections the signature covers.
    if entries.iter().any(|entry| entry.offset > data_entry.offset) {
        return Err(
            "The database is not the last section, so it cannot be replaced in place.".into(),
        );
    }

    let footer = read_exact_at(file, size - FOOTER_BYTES, FOOTER_BYTES as usize)?;
    if footer[60..64] != FOOTER_MAGIC {
        return Err("The footer is missing or damaged; refusing to save over it.".into());
    }
    let current = read_u64(&footer, 0);
    if let Some(expected) = expected_generation {
        if current != expected {
            return Err(format!(
                "This document has been saved somewhere else since it was opened here                  (it is now at save {}, and this window last saw {}). Writing would                  discard that work.",
                current, expected
            ));
        }
    }
    let generation = current.saturating_add(1);

    let length = data.len() as u64;
    let padded = align(length);
    let end = data_entry.offset + padded;

    // Data first, then the metadata that vouches for it. A crash between the
    // two leaves a digest that does not match, which verification reports; the
    // reverse order would leave a file that claims to be intact.
    write_all_at(file, data_entry.offset, data)?;
    if padded > length {
        // Zeroed rather than left alone: the tail of a larger previous database
        // would otherwise travel inside a file whose owner believes they
        // deleted those rows.
        let padding = vec![0u8; (padded - length) as usize];
        write_all_at(file, data_entry.offset + length, &padding)?;
    }
    file.resize(end + FOOTER_BYTES)
        .map_err(|e| format!("Failed to resize the container: {}", e))?;
    file.sync()
        .map_err(|e| format!("Failed to flush the database to disk: {}", e))?;

    let sum = digest(data);

    // The table entry: the length and the digest. The offset does not move.
    write_all_at(file, data_entry.at + 12, &length.to_le_bytes())?;
    write_all_at(file, data_entry.at + 20, &sum)?;

    let mut new_footer = [0u8; FOOTER_BYTES as usize];
    new_footer[..8].copy_from_slice(&generation.to_le_bytes());
    new_footer[8..40].copy_from_slice(&sum);
    new_footer[60..64].copy_from_slice(&FOOTER_MAGIC);
    write_all_at(file, end, &new_footer)?;

    file.sync()
        .map_err(|e| format!("Failed to flush the container to disk: {}", e))?;

    Ok(generation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    impl Resize for Cursor<Vec<u8>> {
        fn resize(&mut self, length: u64) -> std::io::Result<()> {
            self.get_mut().resize(length as usize, 0);
            Ok(())
        }

        fn sync(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn database(fill: u8, length: usize) -> Vec<u8> {
        let mut bytes = SQLITE_HEADER.to_vec();
        bytes.resize(length.max(SQLITE_HEADER.len()), fill);
        bytes
    }

    /// Builds a container the way the TypeScript writer does.
    fn container(manifest: &[u8], payload: &[u8], data: &[u8]) -> Vec<u8> {
        let bodies: [(u8, &[u8]); 3] = [(1, manifest), (2, payload), (3, data)];
        let mut cursor = align(HEADER_BYTES + TOC_ENTRY_BYTES * 3);

        let mut placed = Vec::new();
        for (id, bytes) in bodies {
            placed.push((id, bytes, cursor));
            cursor += align(bytes.len() as u64);
        }

        let mut file = vec![0u8; (cursor + FOOTER_BYTES) as usize];
        file[..4].copy_from_slice(&MAGIC);
        file[4..6].copy_from_slice(&FORMAT_VERSION.to_le_bytes());
        file[8..12].copy_from_slice(&3u32.to_le_bytes());

        for (index, (id, bytes, offset)) in placed.iter().enumerate() {
            let at = (HEADER_BYTES + index as u64 * TOC_ENTRY_BYTES) as usize;
            let start = *offset as usize;
            file[at] = *id;
            file[at + 4..at + 12].copy_from_slice(&offset.to_le_bytes());
            file[at + 12..at + 20].copy_from_slice(&(bytes.len() as u64).to_le_bytes());
            file[at + 20..at + 52].copy_from_slice(&digest(bytes));
            file[start..start + bytes.len()].copy_from_slice(bytes);
        }

        let footer = cursor as usize;
        file[footer..footer + 8].copy_from_slice(&7u64.to_le_bytes());
        file[footer + 8..footer + 40].copy_from_slice(&digest(data));
        file[footer + 60..footer + 64].copy_from_slice(&FOOTER_MAGIC);
        file
    }

    fn data_offset(file: &[u8]) -> usize {
        read_u64(file, (HEADER_BYTES + TOC_ENTRY_BYTES * 2 + 4) as usize) as usize
    }

    fn save(bytes: Vec<u8>, data: &[u8]) -> Result<(u64, Vec<u8>), String> {
        let size = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);
        let generation = replace_data(&mut cursor, size, data)?;
        Ok((generation, cursor.into_inner()))
    }

    #[test]
    fn leaves_the_manifest_and_payload_byte_identical() {
        // The property the layout exists for: the publisher's signature covers
        // the manifest, and a save must not disturb a byte of it.
        let original = container(b"{\"manifestVersion\":1}", b"PK-payload", &database(1, 100));
        let before = original.clone();
        let (_, after) = save(original, &database(2, 200)).unwrap();

        let metadata_end = align(HEADER_BYTES + TOC_ENTRY_BYTES * 3) as usize;
        let end = data_offset(&after);
        assert_eq!(before[metadata_end..end], after[metadata_end..end]);
    }

    #[test]
    fn records_the_new_database_in_the_table_and_the_footer() {
        let data = database(9, 5000);
        let (generation, after) =
            save(container(b"manifest", b"payload", &database(1, 100)), &data).unwrap();

        let entry = (HEADER_BYTES + TOC_ENTRY_BYTES * 2) as usize;
        assert_eq!(read_u64(&after, entry + 12), data.len() as u64);
        assert_eq!(after[entry + 20..entry + 52], digest(&data));

        let footer = after.len() - FOOTER_BYTES as usize;
        assert_eq!(read_u64(&after, footer), generation);
        assert_eq!(after[footer + 8..footer + 40], digest(&data));
        assert_eq!(after[footer + 60..footer + 64], FOOTER_MAGIC);
    }

    #[test]
    fn advances_the_generation_so_a_rollback_is_visible() {
        let (generation, _) =
            save(container(b"m", b"p", &database(1, 10)), &database(2, 10)).unwrap();
        // The fixture is written at generation 7.
        assert_eq!(generation, 8);
    }

    #[test]
    fn the_saved_database_reads_back_exactly() {
        let data = database(3, 9000);
        let (_, after) = save(container(b"m", b"p", &database(1, 10)), &data).unwrap();
        let start = data_offset(&after);
        assert_eq!(&after[start..start + data.len()], &data[..]);
    }

    #[test]
    fn shrinks_the_file_when_the_database_shrinks() {
        let large = save(container(b"m", b"p", &database(1, 10)), &database(2, 40_000))
            .unwrap()
            .1;
        let small = save(large.clone(), &database(3, 100)).unwrap().1;
        assert!(small.len() < large.len());
    }

    #[test]
    fn pads_away_the_tail_of_a_larger_database() {
        let large = save(container(b"m", b"p", &database(1, 10)), &database(0xab, 8000))
            .unwrap()
            .1;
        let small = save(large, &database(0x01, 20)).unwrap().1;
        assert!(!small.windows(8).any(|window| window == [0xab; 8]));
    }

    #[test]
    fn refuses_something_that_is_not_a_database() {
        let error = save(container(b"m", b"p", &database(1, 10)), b"<html>").unwrap_err();
        assert!(error.contains("not a SQLite database"), "{}", error);
    }

    #[test]
    fn refuses_a_file_that_is_not_a_container() {
        let error = save(vec![0u8; 4096], &database(1, 10)).unwrap_err();
        assert!(error.contains("magic"), "{}", error);
    }

    #[test]
    fn refuses_a_future_format_version() {
        let mut bytes = container(b"m", b"p", &database(1, 10));
        bytes[4..6].copy_from_slice(&99u16.to_le_bytes());
        let error = save(bytes, &database(2, 10)).unwrap_err();
        assert!(error.contains("version"), "{}", error);
    }

    #[test]
    fn refuses_a_container_with_no_data_section() {
        let mut bytes = container(b"m", b"p", &database(1, 10));
        // Two sections instead of three: the database is simply not there.
        bytes[8..12].copy_from_slice(&2u32.to_le_bytes());
        let error = save(bytes, &database(2, 10)).unwrap_err();
        assert!(error.contains("no data section"), "{}", error);
    }

    #[test]
    fn refuses_a_section_reaching_past_the_end() {
        let mut bytes = container(b"m", b"p", &database(1, 10));
        let at = (HEADER_BYTES + TOC_ENTRY_BYTES * 2 + 12) as usize;
        bytes[at..at + 8].copy_from_slice(&u64::MAX.to_le_bytes());
        let error = save(bytes, &database(2, 10)).unwrap_err();
        assert!(error.contains("past the end"), "{}", error);
    }

    #[test]
    fn writes_when_the_file_is_where_it_was_left() {
        let bytes = container(b"m", b"p", &database(1, 10));
        let size = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);
        // The fixture is written at generation 7.
        let generation = replace_data_if_unchanged(&mut cursor, size, &database(2, 10), 7).unwrap();
        assert_eq!(generation, 8);
    }

    #[test]
    fn refuses_when_another_window_has_saved_since() {
        /*
         * The case nobody has a lock for. Without this the last writer wins and
         * says nothing, which is the version of this bug that costs somebody an
         * afternoon of work they watched being saved.
         */
        let bytes = container(b"m", b"p", &database(1, 10));
        let size = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);

        let error = replace_data_if_unchanged(&mut cursor, size, &database(2, 10), 6).unwrap_err();
        assert!(error.contains("saved somewhere else"), "{}", error);
        assert!(error.contains("now at save 7"), "{}", error);
    }

    #[test]
    fn leaves_the_file_untouched_when_it_refuses() {
        // A refusal that had already written half the database would be worse
        // than the overwrite it was trying to prevent.
        let bytes = container(b"m", b"p", &database(0xaa, 200));
        let before = bytes.clone();
        let size = bytes.len() as u64;
        let mut cursor = Cursor::new(bytes);

        let _ = replace_data_if_unchanged(&mut cursor, size, &database(0xbb, 200), 6).unwrap_err();
        assert_eq!(cursor.into_inner(), before);
    }

    #[test]
    fn refuses_a_damaged_footer() {
        let mut bytes = container(b"m", b"p", &database(1, 10));
        let footer = bytes.len() - 4;
        bytes[footer..].copy_from_slice(&[0, 0, 0, 0]);
        let error = save(bytes, &database(2, 10)).unwrap_err();
        assert!(error.contains("footer"), "{}", error);
    }
}
