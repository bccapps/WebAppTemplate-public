// VXFramework
//
// Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
// SPDX-License-Identifier: MIT
//
// Licensed under the MIT License. See LICENSE in the project root.

//! Managed processes: spawning in their own group, no-orphan safety nets (Unix sentinel, Windows Job Object),
//! signal handling and ordered shutdown.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_secs(6);

/// A started process (the server or a sidecar).
pub struct Managed {
    pub name: String,
    pub label: String,
    pub child: Child,
}

/// Tauri state: every running process, in start order (sidecars first, server last).
pub struct Processes(pub Mutex<Vec<Managed>>);

/// What to run.
pub struct SpawnSpec {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: BTreeMap<String, String>,
    pub log: File,
}

/// Set by the signal handler (SIGTERM/SIGINT/SIGHUP); a watcher thread then requests a normal exit, which
/// stops the processes (otherwise they would be orphaned).
pub static SIGNALED: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_signal(_sig: libc::c_int) {
    SIGNALED.store(true, Ordering::SeqCst);
}

pub fn install_signal_handlers() {
    #[cfg(unix)]
    unsafe {
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
    }
}

pub fn spawn_process(spec: SpawnSpec) -> Result<Child, String> {
    let log_err = spec.log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&spec.command);
    cmd.args(&spec.args)
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(spec.log))
        .stderr(Stdio::from(log_err));
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    detach_group(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("{}: {e}", spec.command))?;
    protect_from_orphaning(&child);
    Ok(child)
}

fn detach_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group, so the process and its children can be signalled at once
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(any(unix, windows)))]
    let _ = cmd;
}

fn protect_from_orphaning(child: &Child) {
    #[cfg(unix)]
    spawn_sentinel(std::process::id(), child.id());
    #[cfg(windows)]
    winjob::attach(child);
    #[cfg(not(any(unix, windows)))]
    let _ = child;
}

/// Safety net (Unix): an independent process watches the shell and, if it vanishes without a normal
/// shutdown (SIGKILL, crash), stops the whole process group. Exits on its own once the group is gone.
#[cfg(unix)]
fn spawn_sentinel(shell_pid: u32, group: u32) {
    use std::os::unix::process::CommandExt;
    const SCRIPT: &str = r#"
while kill -0 "$1" 2>/dev/null; do
  kill -s 0 -- "-$2" 2>/dev/null || exit 0
  sleep 1
done
kill -s 0 -- "-$2" 2>/dev/null || exit 0
kill -s TERM -- "-$2" 2>/dev/null
sleep 6
kill -s KILL -- "-$2" 2>/dev/null
"#;
    let _ = Command::new("/bin/sh")
        .args(["-c", SCRIPT, "desktop-sentinel", &shell_pid.to_string(), &group.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
}

/// Windows: the processes go into one Job Object with KILL_ON_JOB_CLOSE. If the shell dies (crash, task kill)
/// Windows closes the job and kills the whole tree, the equivalent of the Unix sentinel.
#[cfg(windows)]
mod winjob {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::atomic::{AtomicIsize, Ordering};

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // Kept for the whole process lifetime: Windows closing it triggers the tree shutdown.
    static JOB: AtomicIsize = AtomicIsize::new(0);

    unsafe fn create_job() -> Option<HANDLE> {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        (ok != 0).then_some(job)
    }

    pub fn attach(child: &Child) {
        unsafe {
            if JOB.load(Ordering::SeqCst) == 0 {
                if let Some(job) = create_job() {
                    JOB.store(job as isize, Ordering::SeqCst);
                }
            }
            let job = JOB.load(Ordering::SeqCst);
            if job != 0 {
                // On failure we fall back to taskkill on normal shutdown.
                AssignProcessToJobObject(job as HANDLE, child.as_raw_handle() as HANDLE);
            }
        }
    }
}

/// Stops every process, last started first. Unix: TERM to each group, a grace period, then KILL to the
/// groups (also sweeps stragglers). Windows: `taskkill /T /F`.
pub fn stop_all(mut list: Vec<Managed>) {
    list.reverse();
    #[cfg(unix)]
    stop_unix(&mut list);
    #[cfg(windows)]
    stop_windows(&mut list);
}

#[cfg(unix)]
fn stop_unix(list: &mut [Managed]) {
    for m in list.iter() {
        unsafe { libc::kill(-(m.child.id() as i32), libc::SIGTERM) };
    }
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline && !list.iter_mut().all(|m| matches!(m.child.try_wait(), Ok(Some(_)))) {
        thread::sleep(Duration::from_millis(100));
    }
    for m in list.iter_mut() {
        unsafe { libc::kill(-(m.child.id() as i32), libc::SIGKILL) };
        let _ = m.child.wait();
    }
}

#[cfg(windows)]
fn stop_windows(list: &mut [Managed]) {
    for m in list.iter_mut() {
        let _ = m.child.try_wait();
        let _ = Command::new("taskkill").args(["/PID", &m.child.id().to_string(), "/T", "/F"]).output();
        let _ = m.child.wait();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::OpenOptions;

    fn sleeper(log: &std::path::Path) -> Managed {
        let file = OpenOptions::new().create(true).append(true).open(log).unwrap();
        let spec = SpawnSpec {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 30 & wait".into()],
            cwd: None,
            env: BTreeMap::from([("DESKTOP_TEST".to_string(), "1".to_string())]),
            log: file,
        };
        Managed { name: "t".into(), label: "t".into(), child: spawn_process(spec).unwrap() }
    }

    fn group_alive(pid: u32) -> bool {
        unsafe { libc::kill(-(pid as i32), 0) == 0 }
    }

    #[test]
    fn stop_all_terminates_the_whole_process_group() {
        let log = std::env::temp_dir().join(format!("desktop-shell-proc-{}.log", std::process::id()));
        let m = sleeper(&log);
        let pid = m.child.id();
        assert!(group_alive(pid));
        let started = Instant::now();
        stop_all(vec![m]);
        assert!(started.elapsed() < Duration::from_secs(5));
        let deadline = Instant::now() + Duration::from_secs(2);
        while group_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        assert!(!group_alive(pid));
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn spawn_reports_a_missing_command() {
        let file = File::create(std::env::temp_dir().join(format!("desktop-shell-miss-{}.log", std::process::id()))).unwrap();
        let spec = SpawnSpec { command: "/no/such/binary".into(), args: vec![], cwd: None, env: BTreeMap::new(), log: file };
        assert!(spawn_process(spec).unwrap_err().contains("/no/such/binary"));
    }
}
