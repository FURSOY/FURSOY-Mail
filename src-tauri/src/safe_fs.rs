use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn temporary_path(path: &Path) -> io::Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing parent directory"))?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing file name"))?
        .to_string_lossy();
    let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(parent.join(format!(".{name}.{}.{}.tmp", std::process::id(), sequence)))
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(io::Error::other)
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

pub fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn atomic_write_new(path: &Path, contents: &[u8]) -> io::Result<()> {
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        drop(file);

        // Linking publishes the fully-written file without replacing a file
        // that may have appeared after the caller selected its name.
        fs::hard_link(&temporary, path)?;
        let _ = fs::remove_file(&temporary);
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{atomic_write, atomic_write_new};
    use std::fs;

    fn test_directory(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "fursoy-mail-{name}-{}-{}",
            std::process::id(),
            super::TEMP_FILE_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    #[test]
    fn atomic_write_replaces_complete_file() {
        let directory = test_directory("replace");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("settings.json");
        fs::write(&path, b"old").expect("seed file");

        atomic_write(&path, b"new complete value").expect("replace file");

        assert_eq!(fs::read(&path).expect("read result"), b"new complete value");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn atomic_write_new_never_overwrites_existing_file() {
        let directory = test_directory("create");
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("attachment.txt");
        fs::write(&path, b"existing").expect("seed file");

        assert!(atomic_write_new(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).expect("read result"), b"existing");
        let _ = fs::remove_dir_all(directory);
    }
}
