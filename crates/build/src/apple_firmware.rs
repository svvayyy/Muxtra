//! Renames Apple's Wi-Fi firmware, as macOS ships it in
//! /usr/share/firmware/wifi, to the names Linux's brcmfmac driver asks for
//! on T2 Macs, like `brcmfmac4364b3-pcie.apple,bali-HRPN-u-7.7-X3.txt`.
//!
//! The firmware is Apple's and is never part of Muxtra. `muxtra firmware`
//! copies it from the Mac's own macOS, and this runs on that copy.
//!
//! A port of the renaming in the t2linux project's firmware.sh, which is
//! based on the Asahi Linux installer (both MIT licensed).

use std::collections::BTreeMap;
use std::rc::Rc;

/// Chip folders used by T2 Macs. Others (for Apple Silicon) are skipped.
const CHIP_FOLDERS: &[&str] = &[
    "C-4355__s-C1",
    "C-4364__s-B2",
    "C-4364__s-B3",
    "C-4377__s-B3",
];

/// The chip folders to copy from macOS.
pub fn chip_folders() -> &'static [&'static str] {
    CHIP_FOLDERS
}

/// macOS file extensions and what Linux calls them.
const EXTENSIONS: &[(&str, &str)] = &[
    ("trx", "bin"),
    ("txt", "txt"),
    ("clmb", "clm_blob"),
    ("txcb", "txcap_blob"),
];

/// Name parts, in the order they appear in a Linux name: chip, stepping,
/// platform, module, vendor, module version, antenna.
const DIMS: &[&str] = &["C", "s", "P", "M", "V", "m", "A"];

#[derive(Debug, Default, PartialEq)]
struct Node {
    file: Option<Rc<Vec<u8>>>,
    leaves: BTreeMap<String, Node>,
}

/// Turns macOS firmware files (path relative to the `wifi` folder, and
/// contents) into Linux firmware files (name and contents).
pub fn linux_files(files: &[(String, Vec<u8>)]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut root = Node::default();
    for (path, data) in files {
        // Only files directly inside a T2 chip folder.
        let Some((folder, name)) = path.split_once('/') else {
            continue;
        };
        if !CHIP_FOLDERS.contains(&folder) || name.contains('/') {
            continue;
        }
        let Some((_, ext)) = name.rsplit_once('.') else {
            continue;
        };
        if !EXTENSIONS.iter().any(|(mac, _)| *mac == ext) {
            continue;
        }
        let name = if ext == "txt" {
            name.to_string()
        } else {
            format!("P-{name}")
        };
        let id_path = format!("{folder}_{}", &name[..name.len() - ext.len() - 1]);
        let mut props: BTreeMap<&str, String> = BTreeMap::new();
        for part in id_path.split('_').filter(|p| !p.is_empty()) {
            let (k, v) = part
                .split_once('-')
                .ok_or_else(|| format!("Unexpected Wi-Fi firmware name: {path}"))?;
            match (k, v.split_once('-')) {
                ("P", Some((platform, antenna))) => {
                    props.insert("P", platform.to_string());
                    props.insert("A", antenna.to_string());
                }
                _ => {
                    props.insert(k, v.to_string());
                }
            }
        }
        let mut ident = vec![ext.to_string()];
        for dim in DIMS {
            if let Some(v) = props.remove(dim) {
                ident.push(v);
            }
        }
        if !props.is_empty() {
            return Err(format!("Unexpected parts in Wi-Fi firmware name: {path}"));
        }
        let data = if ext == "txt" {
            clean_nvram(data)?
        } else {
            data.clone()
        };
        let mut node = &mut root;
        for k in ident {
            node = node.leaves.entry(k).or_default();
        }
        node.file = Some(Rc::new(data));
    }
    prune(&mut root, 0);

    let mut out = Vec::new();
    walk(&root, &mut Vec::new(), &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Packs Linux firmware files into a plain tar archive for the builder.
pub fn archive(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in files {
        let mut header = [0u8; 512];
        header[..name.len().min(100)].copy_from_slice(&name.as_bytes()[..name.len().min(100)]);
        header[100..108].copy_from_slice(b"0000644\0");
        header[108..116].copy_from_slice(b"0000000\0");
        header[116..124].copy_from_slice(b"0000000\0");
        header[124..136].copy_from_slice(format!("{:011o}\0", data.len()).as_bytes());
        header[136..148].copy_from_slice(b"00000000000\0");
        header[156] = b'0';
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].copy_from_slice(b"        ");
        let sum: u32 = header.iter().map(|b| u32::from(*b)).sum();
        header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    out.resize(out.len() + 1024, 0);
    out
}

/// A short fingerprint of the packed firmware, so a change rebuilds.
pub fn digest(archive: &[u8]) -> String {
    // FNV-1a, 64 bit. Only used to notice changes, not for security.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in archive {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Where every more specific file is the same, keeps just the general one.
fn prune(node: &mut Node, depth: usize) {
    for leaf in node.leaves.values_mut() {
        prune(leaf, depth + 1);
    }
    if node.file.is_none() && depth > 3 {
        let mut leaves = node.leaves.values();
        if let Some(first) = leaves.next()
            && leaves.all(|l| l == first)
        {
            node.file = first.file.clone();
        }
    }
    if let Some(file) = &node.file
        && node.leaves.values().all(|l| l.file.as_ref() == Some(file))
    {
        node.leaves.clear();
    }
}

fn walk(node: &Node, ident: &mut Vec<String>, out: &mut Vec<(String, Vec<u8>)>) {
    if let Some(file) = &node.file
        && ident.len() >= 3
    {
        let (ext, chip, rev) = (&ident[0], &ident[1], ident[2].to_lowercase());
        let ext = EXTENSIONS
            .iter()
            .find(|(mac, _)| mac == ext)
            .map(|(_, linux)| *linux)
            .unwrap_or("bin");
        let rest = if ident.len() > 3 {
            format!(",{}", ident[3..].join("-"))
        } else {
            String::new()
        };
        out.push((
            format!("brcmfmac{chip}{rev}-pcie.apple{rest}.{ext}"),
            file.as_ref().clone(),
        ));
    }
    for (k, leaf) in &node.leaves {
        ident.push(k.clone());
        walk(leaf, ident, out);
        ident.pop();
    }
}

/// Linux does not like spaces around the keys in Apple's NVRAM files.
fn clean_nvram(data: &[u8]) -> Result<Vec<u8>, String> {
    let text =
        std::str::from_utf8(data).map_err(|_| "A Wi-Fi NVRAM file is not text.".to_string())?;
    let mut out = String::new();
    for line in text.split('\n').filter(|l| !l.is_empty()) {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| "A Wi-Fi NVRAM file has a line without =.".to_string())?;
        out.push_str(key.trim());
        out.push('=');
        out.push_str(value);
        out.push('\n');
    }
    Ok(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, data: &str) -> (String, Vec<u8>) {
        (path.to_string(), data.as_bytes().to_vec())
    }

    #[test]
    fn names_follow_linux() {
        let files = vec![
            f("C-4364__s-B3/bali-X3.trx", "fw-x3"),
            f("C-4364__s-B3/bali-X2.trx", "fw-x2"),
            f("C-4364__s-B3/bali.clmb", "clm"),
            f(
                "C-4364__s-B3/P-bali-X3_M-HRPN_V-u__m-7.7.txt",
                " a =1\nb=2\n",
            ),
            f("C-4378__s-B1/other.trx", "apple silicon"),
            f("C-4364__s-B3/perf/bali.trx", "skipped"),
            f("C-4364__s-B3/notes.plist", "skipped"),
        ];
        let out = linux_files(&files).unwrap();
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "brcmfmac4364b3-pcie.apple,bali-X2.bin",
                "brcmfmac4364b3-pcie.apple,bali-X3.bin",
                "brcmfmac4364b3-pcie.apple,bali.txt",
                "brcmfmac4364b3-pcie.apple,bali.clm_blob",
            ]
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
        );
        let txt = out.iter().find(|(n, _)| n.ends_with(".txt")).unwrap();
        assert_eq!(txt.1, b"a=1\nb=2\n");
    }

    #[test]
    fn archive_is_a_valid_tar() {
        let files = vec![(
            "brcmfmac4364b3-pcie.apple,bali.bin".to_string(),
            b"abc".to_vec(),
        )];
        let tar = archive(&files);
        assert_eq!(tar.len(), 512 + 512 + 1024);
        assert_eq!(&tar[..34], b"brcmfmac4364b3-pcie.apple,bali.bin");
        assert_eq!(&tar[257..262], b"ustar");
        assert_eq!(&tar[512..515], b"abc");
        let sum: u32 = tar[..512]
            .iter()
            .enumerate()
            .map(|(i, b)| {
                if (148..156).contains(&i) {
                    32
                } else {
                    u32::from(*b)
                }
            })
            .sum();
        let stored = std::str::from_utf8(&tar[148..154]).unwrap();
        assert_eq!(u32::from_str_radix(stored, 8).unwrap(), sum);
        assert_ne!(digest(&tar), digest(&archive(&[])));
    }

    #[test]
    fn identical_variants_collapse_to_one_general_file() {
        let files = vec![
            f("C-4364__s-B3/P-bali_M-HRPN_V-u__m-7.7.txt", "x=1\n"),
            f("C-4364__s-B3/P-bali_M-HRPN_V-m__m-7.9.txt", "x=1\n"),
        ];
        let out = linux_files(&files).unwrap();
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["brcmfmac4364b3-pcie.apple,bali.txt"]);
        // Different vendors keep their own files.
        let files = vec![
            f("C-4364__s-B3/P-bali_M-HRPN_V-u__m-7.7.txt", "x=1\n"),
            f("C-4364__s-B3/P-bali_M-HRPN_V-m__m-7.9.txt", "x=2\n"),
        ];
        let out = linux_files(&files).unwrap();
        let names: Vec<&str> = out.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "brcmfmac4364b3-pcie.apple,bali-HRPN-m.txt",
                "brcmfmac4364b3-pcie.apple,bali-HRPN-u.txt"
            ]
        );
    }
}
