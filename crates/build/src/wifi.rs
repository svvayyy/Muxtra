//! Saved Wi-Fi networks: the WPA key Muxtra stores instead of a password,
//! and the files iwd (the Wi-Fi manager on the Mac) reads them from.

use std::fmt;

/// One saved network. `psk` is the 64-hex-digit WPA key derived from the
/// password, never the password itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Network {
    pub ssid: String,
    pub psk: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WifiError(pub String);

impl fmt::Display for WifiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for WifiError {}

/// Checks a network name: 1 to 32 bytes, as Wi-Fi allows.
pub fn check_ssid(ssid: &str) -> Result<(), WifiError> {
    if ssid.is_empty() || ssid.len() > 32 {
        return Err(WifiError(format!(
            "\"{ssid}\" is not a usable Wi-Fi network name. Names are 1 to 32 characters."
        )));
    }
    Ok(())
}

/// The WPA key for a network: PBKDF2-HMAC-SHA1 of the password, salted with
/// the network name, 4096 rounds, 32 bytes (IEEE 802.11i). A 64-digit hex
/// key is accepted as is.
pub fn psk(ssid: &str, password: &str) -> Result<String, WifiError> {
    check_ssid(ssid)?;
    if password.len() == 64 && password.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(password.to_ascii_lowercase());
    }
    if !(8..=63).contains(&password.len()) || !password.is_ascii() {
        return Err(WifiError(
            "Wi-Fi passwords are 8 to 63 characters. Check it and try again.".to_string(),
        ));
    }
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password.as_bytes(), ssid.as_bytes(), 4096, &mut key);
    Ok(key.iter().map(|b| format!("{b:02x}")).collect())
}

/// iwd's file name for a network: the name itself when it only uses
/// letters, digits, spaces, `-` and `_`, otherwise `=` plus the name in hex.
pub fn iwd_file(ssid: &str) -> String {
    let plain = ssid
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_');
    if plain {
        format!("{ssid}.psk")
    } else {
        let hex: String = ssid.bytes().map(|b| format!("{b:02x}")).collect();
        format!("={hex}.psk")
    }
}

/// The contents of an iwd `.psk` file.
pub fn iwd_config(network: &Network) -> String {
    format!("[Security]\nPreSharedKey={}\n", network.psk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ieee_test_vector() {
        // IEEE 802.11i-2004, Annex H.4: passphrase "password", SSID "IEEE".
        assert_eq!(
            psk("IEEE", "password").unwrap(),
            "f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e"
        );
    }

    #[test]
    fn password_rules() {
        assert!(psk("home", "short").unwrap_err().0.contains("8 to 63"));
        assert!(psk("home", &"x".repeat(64)).is_err());
        let raw = "A".repeat(64);
        assert_eq!(psk("home", &raw).unwrap(), "a".repeat(64));
        assert!(psk("", "password123").is_err());
        assert!(psk(&"n".repeat(33), "password123").is_err());
    }

    #[test]
    fn iwd_file_names() {
        assert_eq!(iwd_file("briarplace"), "briarplace.psk");
        assert_eq!(iwd_file("My Home-5G_2"), "My Home-5G_2.psk");
        assert_eq!(iwd_file("Joe's Wi-Fi"), "=4a6f6527732057692d4669.psk");
    }
}
