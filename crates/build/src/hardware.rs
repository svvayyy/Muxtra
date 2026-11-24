//! What Muxtra knows about each Intel Mac model: what it is, and what the
//! image needs for its hardware (firmware packages, drivers to load early).
//!
//! Unknown models still build. They get the parts every Intel Mac shares.

/// Apple's security chip, which changes how keyboards, Touch Bars and
/// booting work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Chip {
    None,
    T1,
    T2,
}

/// One Mac model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mac {
    pub model: &'static str,
    /// What people call it.
    pub name: &'static str,
    pub chip: Chip,
    /// Extra Debian packages (mostly firmware).
    pub packages: &'static [&'static str],
    /// Drivers loaded early, so the built-in keyboard works at the login prompt.
    pub early_modules: &'static [&'static str],
    /// Why Thunderbolt networking cannot work on this model, if it cannot.
    pub no_thunderbolt: Option<&'static str>,
}

/// Every Intel Mac gets these.
pub const COMMON_PACKAGES: &[&str] = &["intel-microcode", "firmware-brcm80211"];

/// Broadcom's own Wi-Fi driver (`wl`), for the BCM4360 that the open
/// drivers do not support. Built against the image's kernel at build time.
const BROADCOM_WL: &[&str] = &["broadcom-sta-dkms", "linux-headers-amd64"];

/// T2 Macs: the AMD graphics firmware, and DKMS with kernel headers to build
/// t2bce (keyboard, trackpad, camera and audio go through the T2 chip).
const T2_PACKAGES: &[&str] = &["firmware-amd-graphics", "dkms", "linux-headers-amd64"];

/// Kernel options the t2linux project recommends for T2 Macs.
pub const T2_KERNEL_ARGS: &[&str] = &["intel_iommu=on", "iommu=pt", "pcie_ports=compat"];

/// t2bce, the T2 driver stack, pinned to one tested commit and checked
/// against this SHA-256 of GitHub's tarball for it.
pub const T2BCE_COMMIT: &str = "a973d53c8278e9db5ff8314b816d6880309ed39e";
pub const T2BCE_SHA256: &str = "ff76afc42deca06a899675e5747bd0d27c325d98ce001f0e98b8222869161d82";

/// SPI keyboard and trackpad on 2015-2017 MacBooks and MacBook Pros.
const SPI_INPUT: &[&str] = &["intel_lpss_pci", "spi_pxa2xx_platform", "applespi"];

const KNOWN: &[Mac] = &[
    Mac {
        model: "iMac14,4",
        name: "21.5-inch iMac, Mid 2014",
        chip: Chip::None,
        // BCM4360 Wi-Fi, and firmware for the BCM57766 Ethernet port.
        packages: &[BROADCOM_WL[0], BROADCOM_WL[1], "firmware-misc-nonfree"],
        early_modules: &[],
        // Thunderbolt 2 "Redwood Ridge" (8086:1568), which Linux's
        // Thunderbolt driver does not support.
        no_thunderbolt: Some("its Thunderbolt 2 chip has no Linux driver"),
    },
    Mac {
        model: "MacBookPro13,3",
        name: "15-inch MacBook Pro, 2016",
        chip: Chip::T1,
        packages: &["firmware-amd-graphics"],
        early_modules: SPI_INPUT,
        no_thunderbolt: None,
    },
    Mac {
        model: "MacBookPro14,3",
        name: "15-inch MacBook Pro, 2017",
        chip: Chip::T1,
        packages: &["firmware-amd-graphics"],
        early_modules: SPI_INPUT,
        no_thunderbolt: None,
    },
    Mac {
        model: "MacBookPro15,1",
        name: "15-inch MacBook Pro, 2018 or 2019",
        chip: Chip::T2,
        packages: T2_PACKAGES,
        early_modules: &[],
        no_thunderbolt: None,
    },
    Mac {
        model: "MacBookPro16,1",
        name: "16-inch MacBook Pro, 2019",
        chip: Chip::T2,
        packages: T2_PACKAGES,
        early_modules: &[],
        no_thunderbolt: None,
    },
];

/// What Muxtra knows about a model, if anything.
pub fn lookup(model: &str) -> Option<&'static Mac> {
    KNOWN.iter().find(|m| m.model == model)
}

/// All packages a model needs, common ones first.
pub fn packages(model: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = COMMON_PACKAGES.to_vec();
    if let Some(mac) = lookup(model) {
        out.extend(
            mac.packages
                .iter()
                .filter(|p| !out.contains(p))
                .collect::<Vec<_>>(),
        );
    }
    out
}

/// Why Thunderbolt networking cannot work on a model, if Muxtra knows it
/// cannot. Unknown models are assumed to work.
pub fn no_thunderbolt(model: &str) -> Option<&'static str> {
    lookup(model).and_then(|m| m.no_thunderbolt)
}

/// True for Macs with Apple's T2 chip: their Wi-Fi needs Apple's firmware
/// from macOS, and their keyboard and trackpad need t2bce.
pub fn is_t2(model: &str) -> bool {
    lookup(model).is_some_and(|m| m.chip == Chip::T2)
}

/// Drivers to load early for a model.
pub fn early_modules(model: &str) -> &'static [&'static str] {
    lookup(model).map_or(&[], |m| m.early_modules)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_and_unknown_models() {
        let silo = lookup("MacBookPro13,3").unwrap();
        assert_eq!(silo.chip, Chip::T1);
        assert!(packages("MacBookPro13,3").contains(&"firmware-amd-graphics"));
        assert!(early_modules("MacBookPro13,3").contains(&"applespi"));
        assert_eq!(packages("Macmini8,1"), COMMON_PACKAGES);
        let imac = packages("iMac14,4");
        assert!(imac.contains(&"broadcom-sta-dkms") && imac.contains(&"linux-headers-amd64"));
        assert!(no_thunderbolt("iMac14,4").is_some());
        assert!(no_thunderbolt("MacBookPro13,3").is_none());
        assert!(no_thunderbolt("Macmini8,1").is_none());
        assert!(is_t2("MacBookPro16,1") && !is_t2("MacBookPro13,3") && !is_t2("Macmini8,1"));
        assert!(packages("MacBookPro16,1").contains(&"dkms"));
        assert!(early_modules("Macmini8,1").is_empty());
        assert!(lookup("Macmini8,1").is_none());
    }

    #[test]
    fn every_model_id_is_valid() {
        for mac in KNOWN {
            assert!(muxtra_manifest::is_mac_model(mac.model), "{}", mac.model);
        }
    }
}
