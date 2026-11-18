//! Disk layouts for `muxtra poof`: reads the partition table of a built
//! image, fits a new one to the size of the target drive, and writes GPT
//! headers. Pure functions: the CLI does the actual reading and writing.
//!
//! Layout on every drive, in order:
//!   muxtra-efi (512 MiB), muxtra-root-a, muxtra-root-b (only if it fits),
//!   muxtra-home (the rest; it grows to fill at first boot).

use std::fmt;

/// Bytes per sector. USB sticks and Mac drives all report 512 to the OS.
pub const SECTOR: u64 = 512;
const ALIGN: u64 = 2048; // 1 MiB, in sectors
const ENTRIES: u64 = 128;
const ENTRY_SIZE: u64 = 128;
/// Sectors used by the partition entry array (128 x 128 bytes).
const ENTRY_SECTORS: u64 = ENTRIES * ENTRY_SIZE / SECTOR;

pub const ESP_TYPE: &str = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B";
pub const ROOT_X86_64_TYPE: &str = "4F68BCE3-E8CD-4DB1-96E7-FBCAF984B709";
pub const HOME_TYPE: &str = "933AC7E1-2EB4-4F13-B844-0E14E2AEF915";

/// Smallest home partition worth having, beyond the image's own.
const HOME_SPARE: u64 = 256 * 1024 * 1024;

/// One partition, in sectors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub name: String,
    pub type_guid: [u8; 16],
    pub first: u64,
    /// Inclusive.
    pub last: u64,
}

impl Part {
    pub fn sectors(&self) -> u64 {
        self.last - self.first + 1
    }
    pub fn bytes(&self) -> u64 {
        self.sectors() * SECTOR
    }
    pub fn offset(&self) -> u64 {
        self.first * SECTOR
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskError(pub String);

impl fmt::Display for DiskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DiskError {}

/// Reads the primary GPT from the start of an image (at least 34 sectors).
pub fn read_gpt(head: &[u8]) -> Result<Vec<Part>, DiskError> {
    let bad = |why: &str| DiskError(format!("The image's partition table is not valid: {why}."));
    if head.len() < (2 + ENTRY_SECTORS) as usize * SECTOR as usize {
        return Err(bad("too short"));
    }
    let h = &head[SECTOR as usize..2 * SECTOR as usize];
    if &h[0..8] != b"EFI PART" {
        return Err(bad("no GPT signature"));
    }
    let entries_lba = u64::from_le_bytes(h[72..80].try_into().unwrap());
    let count = u32::from_le_bytes(h[80..84].try_into().unwrap()) as usize;
    let size = u32::from_le_bytes(h[84..88].try_into().unwrap()) as usize;
    if size != ENTRY_SIZE as usize || entries_lba != 2 {
        return Err(bad("unexpected entry layout"));
    }
    let mut parts = Vec::new();
    for i in 0..count.min(ENTRIES as usize) {
        let at = entries_lba as usize * SECTOR as usize + i * size;
        let e = head
            .get(at..at + size)
            .ok_or_else(|| bad("entries cut off"))?;
        let type_guid: [u8; 16] = e[0..16].try_into().unwrap();
        if type_guid == [0; 16] {
            continue;
        }
        let first = u64::from_le_bytes(e[32..40].try_into().unwrap());
        let last = u64::from_le_bytes(e[40..48].try_into().unwrap());
        let name_units: Vec<u16> = e[56..128]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        parts.push(Part {
            name: String::from_utf16_lossy(&name_units),
            type_guid,
            first,
            last,
        });
    }
    Ok(parts)
}

/// What to copy from the image to the drive: (image part, drive part).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    pub parts: Vec<Part>,
    pub copies: Vec<(Part, Part)>,
    /// False when the drive is too small for a second system slot.
    pub has_slot_b: bool,
}

fn align_up(lba: u64) -> u64 {
    lba.div_ceil(ALIGN) * ALIGN
}

fn find<'a>(parts: &'a [Part], name: &str) -> Result<&'a Part, DiskError> {
    parts.iter().find(|p| p.name == name).ok_or_else(|| {
        DiskError(format!(
            "The image has no {name} partition. Rebuild it with `muxtra build`."
        ))
    })
}

/// Puts a partition at the next 1 MiB boundary and moves `next` past it.
fn place(next: &mut u64, name: &str, type_guid: [u8; 16], sectors: u64) -> Part {
    let first = align_up(*next);
    let part = Part {
        name: name.to_string(),
        type_guid,
        first,
        last: first + sectors - 1,
    };
    *next = part.last + 1;
    part
}

/// Fits the image's partitions onto a drive of `disk_bytes`.
pub fn fit(image: &[Part], disk_bytes: u64) -> Result<Layout, DiskError> {
    let esp = find(image, "muxtra-efi")?;
    let root = find(image, "muxtra-root-a")?;
    let home = find(image, "muxtra-home")?;
    let total = disk_bytes / SECTOR;
    let last_usable = total.saturating_sub(2 + ENTRY_SECTORS);

    let mut next = ALIGN;
    let new_esp = place(&mut next, "muxtra-efi", esp.type_guid, esp.sectors());
    let new_root = place(&mut next, "muxtra-root-a", root.type_guid, root.sectors());

    let home_min = home.sectors() + HOME_SPARE / SECTOR;
    let need_without_b = align_up(next) + home_min;
    if need_without_b > last_usable {
        let need = (need_without_b + 2 + ENTRY_SECTORS) * SECTOR;
        return Err(DiskError(format!(
            "This drive is too small. Muxtra needs at least {:.1} GB, and this one has {:.1} GB.",
            need as f64 / 1e9,
            disk_bytes as f64 / 1e9
        )));
    }
    let has_slot_b = align_up(next) + root.sectors() + ALIGN + home_min <= last_usable;
    let mut parts = vec![new_esp.clone(), new_root.clone()];
    if has_slot_b {
        parts.push(place(
            &mut next,
            "muxtra-root-b",
            root.type_guid,
            root.sectors(),
        ));
    }
    let home_first = align_up(next);
    // Home takes the rest, ending on a 1 MiB boundary.
    let home_last = (last_usable + 1) / ALIGN * ALIGN - 1;
    let new_home = Part {
        name: "muxtra-home".to_string(),
        type_guid: home.type_guid,
        first: home_first,
        last: home_last,
    };
    parts.push(new_home.clone());

    Ok(Layout {
        parts,
        copies: vec![
            (esp.clone(), new_esp),
            (root.clone(), new_root),
            (home.clone(), new_home),
        ],
        has_slot_b,
    })
}

/// GUID text like "C12A7328-F81F-11D2-BA4B-00A0C93EC93B" in GPT byte order
/// (the first three groups are little-endian).
pub fn guid(text: &str) -> [u8; 16] {
    let hex: String = text.chars().filter(|c| *c != '-').collect();
    let b: Vec<u8> = (0..16)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&[b[3], b[2], b[1], b[0]]);
    out[4..6].copy_from_slice(&[b[5], b[4]]);
    out[6..8].copy_from_slice(&[b[7], b[6]]);
    out[8..16].copy_from_slice(&b[8..16]);
    out
}

/// A random version 4 GUID from 16 random bytes.
pub fn random_guid(mut bytes: [u8; 16]) -> [u8; 16] {
    bytes[7] = (bytes[7] & 0x0f) | 0x40; // version 4 (byte order as stored)
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    bytes
}

/// The protective MBR, primary GPT (sectors 0 to 33) and backup GPT (the
/// last 33 sectors) for `parts` on a drive of `total_sectors`.
pub struct Tables {
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
    /// Byte offset of `tail` on the drive.
    pub tail_offset: u64,
}

/// `random` supplies 16 random bytes per GUID needed (disk + each partition).
pub fn tables(parts: &[Part], total_sectors: u64, mut random: impl FnMut() -> [u8; 16]) -> Tables {
    let last_lba = total_sectors - 1;
    let backup_entries = last_lba - ENTRY_SECTORS;
    let first_usable = 2 + ENTRY_SECTORS;
    let last_usable = backup_entries - 1;

    let mut entries = vec![0u8; (ENTRIES * ENTRY_SIZE) as usize];
    for (i, p) in parts.iter().enumerate() {
        let e = &mut entries[i * ENTRY_SIZE as usize..(i + 1) * ENTRY_SIZE as usize];
        e[0..16].copy_from_slice(&p.type_guid);
        e[16..32].copy_from_slice(&random_guid(random()));
        e[32..40].copy_from_slice(&p.first.to_le_bytes());
        e[40..48].copy_from_slice(&p.last.to_le_bytes());
        for (j, unit) in p.name.encode_utf16().take(36).enumerate() {
            e[56 + j * 2..58 + j * 2].copy_from_slice(&unit.to_le_bytes());
        }
    }
    let entries_crc = crc32(&entries);
    let disk_guid = random_guid(random());

    let header = |current: u64, backup: u64, entries_lba: u64| {
        let mut h = vec![0u8; SECTOR as usize];
        h[0..8].copy_from_slice(b"EFI PART");
        h[8..12].copy_from_slice(&0x0001_0000u32.to_le_bytes());
        h[12..16].copy_from_slice(&92u32.to_le_bytes());
        h[24..32].copy_from_slice(&current.to_le_bytes());
        h[32..40].copy_from_slice(&backup.to_le_bytes());
        h[40..48].copy_from_slice(&first_usable.to_le_bytes());
        h[48..56].copy_from_slice(&last_usable.to_le_bytes());
        h[56..72].copy_from_slice(&disk_guid);
        h[72..80].copy_from_slice(&entries_lba.to_le_bytes());
        h[80..84].copy_from_slice(&(ENTRIES as u32).to_le_bytes());
        h[84..88].copy_from_slice(&(ENTRY_SIZE as u32).to_le_bytes());
        h[88..92].copy_from_slice(&entries_crc.to_le_bytes());
        let crc = crc32(&h[0..92]);
        h[16..20].copy_from_slice(&crc.to_le_bytes());
        h
    };

    let mut mbr = vec![0u8; SECTOR as usize];
    let p = &mut mbr[446..462];
    p[1..4].copy_from_slice(&[0x00, 0x02, 0x00]);
    p[4] = 0xEE;
    p[5..8].copy_from_slice(&[0xFF, 0xFF, 0xFF]);
    p[8..12].copy_from_slice(&1u32.to_le_bytes());
    p[12..16].copy_from_slice(&(last_lba.min(u32::MAX as u64) as u32).to_le_bytes());
    mbr[510] = 0x55;
    mbr[511] = 0xAA;

    let mut head = mbr;
    head.extend(header(1, last_lba, 2));
    head.extend(&entries);
    let mut tail = entries;
    tail.extend(header(last_lba, 1, backup_entries));
    Tables {
        head,
        tail,
        tail_offset: backup_entries * SECTOR,
    }
}

/// CRC-32 (IEEE), as GPT uses.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn image_parts() -> Vec<Part> {
        // The layout builder.sh makes on a 10 GiB image.
        let mut next = ALIGN;
        let esp = place(
            &mut next,
            "muxtra-efi",
            guid(ESP_TYPE),
            (512 << 20) / SECTOR,
        );
        let a = place(
            &mut next,
            "muxtra-root-a",
            guid(ROOT_X86_64_TYPE),
            4 * GIB / SECTOR,
        );
        let b = place(
            &mut next,
            "muxtra-root-b",
            guid(ROOT_X86_64_TYPE),
            4 * GIB / SECTOR,
        );
        let home_sectors = (10 * GIB - (1 << 20)) / SECTOR - next;
        let home = place(&mut next, "muxtra-home", guid(HOME_TYPE), home_sectors);
        vec![esp, a, b, home]
    }

    fn counter() -> impl FnMut() -> [u8; 16] {
        let mut n = 0u8;
        move || {
            n += 1;
            [n; 16]
        }
    }

    #[test]
    fn crc32_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn guid_byte_order() {
        assert_eq!(
            guid(ESP_TYPE),
            [
                0x28, 0x73, 0x2A, 0xC1, 0x1F, 0xF8, 0xD2, 0x11, 0xBA, 0x4B, 0x00, 0xA0, 0xC9, 0x3E,
                0xC9, 0x3B
            ]
        );
    }

    #[test]
    fn tables_round_trip() {
        let parts = image_parts();
        let total = 10 * GIB / SECTOR;
        let t = tables(&parts, total, counter());
        assert_eq!(t.head.len(), 34 * SECTOR as usize);
        assert_eq!(t.tail.len(), 33 * SECTOR as usize);
        assert_eq!(t.tail_offset, (total - 33) * SECTOR);
        assert_eq!(&t.head[510..512], &[0x55, 0xAA]);
        let read = read_gpt(&t.head).unwrap();
        assert_eq!(read, parts);
        // The backup header points back at the primary.
        let backup = &t.tail[t.tail.len() - SECTOR as usize..];
        assert_eq!(&backup[0..8], b"EFI PART");
        assert_eq!(u64::from_le_bytes(backup[32..40].try_into().unwrap()), 1);
    }

    #[test]
    fn eight_gb_stick_skips_slot_b() {
        let stick = 7_800_000_000; // what an "8 GB" stick really holds
        let l = fit(&image_parts(), stick).unwrap();
        assert!(!l.has_slot_b);
        let names: Vec<&str> = l.parts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["muxtra-efi", "muxtra-root-a", "muxtra-home"]);
        let home = l.parts.last().unwrap();
        assert!(home.last * SECTOR < stick);
        assert!(home.bytes() >= image_parts()[3].bytes());
    }

    #[test]
    fn big_drive_gets_both_slots_and_a_big_home() {
        let l = fit(&image_parts(), 500 * 1_000_000_000).unwrap();
        assert!(l.has_slot_b);
        assert_eq!(l.parts.len(), 4);
        assert!(l.parts[3].bytes() > 400 * GIB);
        for w in l.parts.windows(2) {
            assert!(w[0].last < w[1].first, "partitions overlap");
        }
        for p in &l.parts {
            assert_eq!(p.first % ALIGN, 0, "{} is not 1 MiB aligned", p.name);
        }
        // Copies keep each partition's exact size, except home which grows.
        for (from, to) in &l.copies {
            assert!(to.bytes() >= from.bytes());
        }
    }

    #[test]
    fn tiny_drive_is_refused_in_plain_english() {
        let err = fit(&image_parts(), 4_000_000_000).unwrap_err();
        assert!(err.0.contains("too small"), "{err}");
    }

    #[test]
    fn missing_partition_is_explained() {
        let mut parts = image_parts();
        parts.retain(|p| p.name != "muxtra-home");
        assert!(
            fit(&parts, 64 * GIB)
                .unwrap_err()
                .0
                .contains("muxtra build")
        );
    }
}
