fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../device-panel/Resources/AppIcon.png");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    #[cfg(windows)]
    windows_resources();
    #[cfg(not(windows))]
    panic!("Windows desktop resources require a Windows build host");
}

#[cfg(windows)]
fn windows_resources() {
    use std::{fs, io::Cursor, path::PathBuf};

    let output = PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output directory"));
    let artwork = image::load_from_memory(include_bytes!("../device-panel/Resources/AppIcon.png"))
        .expect("approved application artwork");
    let sizes = [16u32, 24, 32, 48, 64, 128, 256];
    let images: Vec<_> = sizes
        .iter()
        .map(|&size| {
            let mut png = Cursor::new(Vec::new());
            artwork
                .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
                .write_to(&mut png, image::ImageFormat::Png)
                .expect("encode Windows icon size");
            png.into_inner()
        })
        .collect();
    // ICO directory followed by PNG entries; 0 denotes a 256-pixel dimension.
    let mut icon = vec![0, 0, 1, 0];
    icon.extend_from_slice(&(sizes.len() as u16).to_le_bytes());
    let mut offset = (6 + 16 * sizes.len()) as u32;
    for (&size, png) in sizes.iter().zip(&images) {
        icon.extend_from_slice(&[size as u8, size as u8, 0, 0]);
        icon.extend_from_slice(&1u16.to_le_bytes());
        icon.extend_from_slice(&32u16.to_le_bytes());
        icon.extend_from_slice(&(png.len() as u32).to_le_bytes());
        icon.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }
    for png in images {
        icon.extend_from_slice(&png);
    }
    let icon_path = output.join("AppIcon.ico");
    fs::write(&icon_path, icon).expect("write Windows icon");
    let version = ["MAJOR", "MINOR", "PATCH"]
        .map(|part| std::env::var(format!("CARGO_PKG_VERSION_{part}")).unwrap())
        .join(",");
    let display_version = std::env::var("CARGO_PKG_VERSION").unwrap();
    let resource = output.join("app.rc");
    // GPUI Windows loads application icon resource ID 1 for the window class.
    // The same resource supplies Explorer, taskbar and Alt-Tab branding.
    fs::write(
        &resource,
        format!(
            r#"#pragma code_page(65001)
1 ICON "{}"
1 VERSIONINFO
FILEVERSION {},0
PRODUCTVERSION {},0
FILEOS 0x40004
FILETYPE 1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "FileDescription", "界舟 · Harness Dock\0"
      VALUE "ProductName", "界舟 · Harness Dock\0"
      VALUE "FileVersion", "{}\0"
      VALUE "ProductVersion", "{}\0"
      VALUE "OriginalFilename", "HarnessDock.exe\0"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
            icon_path.to_string_lossy().replace('\\', "/"),
            version,
            version,
            display_version,
            display_version,
        ),
    )
    .expect("write Windows resources");
    embed_resource::compile_for(&resource, &["harness-dock-panel"], embed_resource::NONE)
        .manifest_required()
        .expect("embed Windows application icon and version");
}
