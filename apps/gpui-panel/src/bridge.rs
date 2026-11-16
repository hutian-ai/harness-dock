use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Bridge {
    pub resources: PathBuf,
    pub single_server: bool,
}
impl Bridge {
    pub fn help_url(&self) -> Option<String> {
        let path = self
            .resources
            .join("ConnectionHelp.html")
            .canonicalize()
            .ok()?;
        gpui_kit::http_client::Url::from_file_path(path)
            .ok()
            .map(Into::into)
    }
    pub fn installed() -> Result<Self, String> {
        let exe = std::env::current_exe().map_err(|_| "helper_unavailable")?;
        #[cfg(target_os = "macos")]
        let resources = exe
            .parent()
            .ok_or("helper_unavailable")?
            .join("../Resources");
        #[cfg(not(target_os = "macos"))]
        let resources = exe.parent().ok_or("helper_unavailable")?.join("resources");
        Ok(Self {
            resources,
            single_server: true,
        })
    }
    /// Only the packaged helper receives requests. No shell, provider processes or SDK connection in the UI.
    pub fn call(&self, operation: &str, config: &str, fields: Value) -> Result<Value, String> {
        let runtime = self.resources.join(if cfg!(windows) {
            "daemon/runtime/node.exe"
        } else {
            "daemon/runtime/node"
        });
        let helper = self.resources.join("daemon/dist/panel-cli.js");
        let mut request = fields.as_object().cloned().unwrap_or_default();
        request.insert("operation".into(), json!(operation));
        request.insert("config".into(), json!(config));
        if self.single_server {
            request.insert("singleServer".into(), json!(true));
        }
        let input = serde_json::to_vec(&request).map_err(|_| "invalid_panel_request")?;
        if input.len() > 32_768 {
            return Err("invalid_panel_request".into());
        }
        let allowed = [
            "HOME",
            "PATH",
            "SHELL",
            "TMPDIR",
            "TEMP",
            "TMP",
            "LANG",
            "LC_ALL",
            "CODEX_HOME",
            "CODEX_CLI_PATH",
            "DSH_HOME",
            "NVM_DIR",
            "SYSTEMROOT",
            "COMSPEC",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "PATHEXT",
            "WINDIR",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
        ];
        let env: HashMap<_, _> = std::env::vars_os()
            .filter(|(key, _)| allowed.contains(&key.to_string_lossy().to_uppercase().as_str()))
            .collect();
        let mut command = Command::new(runtime);
        command
            .arg(&helper)
            .current_dir(helper.parent().ok_or("helper_unavailable")?)
            .env_clear()
            .envs(env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|_| "helper_unavailable")?;
        if child
            .stdin
            .take()
            .ok_or("helper_unavailable")?
            .write_all(&input)
            .is_err()
        {
            let _ = child.wait();
            return Err("management_failed".into());
        }
        let output = child.stdout.take().ok_or("helper_unavailable")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            output.take(262_145).read_to_end(&mut bytes).map(|_| bytes)
        });
        let read_only = [
            "status",
            "test-status",
            "pairing",
            "invitation",
            "doctor",
            "provider-details",
            "log-location",
            "preferences",
        ]
        .contains(&operation);
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if child.try_wait().map_err(|_| "management_failed")?.is_some() {
                break;
            }
            // A UI deadline never interrupts installation, maintenance, or a submitted test.
            if read_only && Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("helper_timeout".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let bytes = reader
            .join()
            .map_err(|_| "management_failed")?
            .map_err(|_| "management_failed")?;
        if bytes.len() > 262_144 {
            return Err("management_failed".into());
        }
        let response: Value = serde_json::from_slice(&bytes).map_err(|_| "management_failed")?;
        if response["ok"] != true {
            return Err(response["error"]
                .as_str()
                .unwrap_or("management_failed")
                .to_owned());
        }
        response
            .get("value")
            .cloned()
            .ok_or_else(|| "management_failed".into())
    }
}

pub fn default_config() -> String {
    if cfg!(windows) {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
            .join("HarnessDock/.local/device/config.json")
            .to_string_lossy()
            .into()
    } else {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".harness-dock/.local/device/config.json")
            .to_string_lossy()
            .into()
    }
}
pub fn default_workdir() -> String {
    PathBuf::from(
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    )
    .to_string_lossy()
    .into()
}
pub fn message(code: &str) -> &'static str {
    match code {
        "server_change_requires_disconnect" => {
            "请先断开当前服务器，再接入或恢复另一份配置。不会启动并行连接。"
        }
        "panel_selection_changed" => "当前服务器选择已变更，正在读取最新状态。",
        "connection_change_busy" => {
            "连接变更尚未结束或结果待核对，请等待原操作后刷新。不会自动重试。"
        }
        "connection_lock_legacy" => {
            "检测到旧版连接操作锁。请先核对旧 helper 已退出及原操作结果，再由维护者检查并归档旧锁；重新打开客户端不会解除。"
        }
        "connection_recovery_pending" => "已保存原接入信息，请先继续原接入，不领取新的邀请。",
        "connection_recovery_unavailable" => "没有找到可继续的原接入记录，请先向管理员核实原邀请。",
        "connection_local_preflight_failed" => {
            "本地执行目录或 CA 证书检查未通过，尚未领取邀请。请修正后重新核对。"
        }
        "pairing_changed" => "配对文件在核对后发生变化。请重新选择文件并核对服务器，再确认接入。",
        "server_disconnect_unconfirmed" => {
            "旧后台是否退出尚未确认。不会接入新服务器，请刷新原连接状态。"
        }
        "autostart_preference_unconfirmed" => "自动连接偏好尚未确认，请刷新后检查开关状态。",
        "autostart_file_modified" | "autostart_registration_without_owned_file" => {
            "无法确认现有登录启动项的归属，请通过原安装入口处理。"
        }
        "autostart_requires_macos_user_login" => "登录后自动连接需要在 macOS 用户登录会话中设置。",
        "windows_autostart_not_available" => "Windows 登录自动启动尚未提供。",
        "provider_details_unsupported" => {
            "当前连接服务版本尚不支持读取模型信息，请在设备空闲时更新后台。"
        }
        "provider_details_failed" => {
            "未能读取原生模型信息，请检查 Harness 的安装、登录与网络后重试。"
        }
        "device_busy" => "设备正在执行任务，请稍后再维护。",
        "unresolved_execution" => "有执行结果待核对，请回到原调用方确认后再维护。",
        "setup_identity_conflict" => {
            "这里已有另一份设备身份，原配置已保留。请选择原设备或新的私有目录。"
        }
        "invalid_invitation" => "邀请链接无效，请复制管理员提供的完整链接。",
        "invitation_expired" | "invitation_unavailable" => {
            "邀请已过期、已领取或已撤销，请领取新邀请。"
        }
        "invitation_claim_unconfirmed" => "邀请领取结果待确认。请刷新原设备，不要重复提交。",
        "device_config_is_not_pairing" => {
            "这是本机设备配置，不是配对文件。请使用服务器管理员导出的 device-pairing.json 或邀请链接。"
        }
        "invalid_device_pairing" | "pairing_required" => {
            "无法识别此配对文件。请重新获取服务器管理员导出的配对文件或邀请链接。"
        }
        "helper_unavailable" => {
            if cfg!(windows) {
                "应用运行文件不完整，请将 HarnessDock.exe 与完整的 resources 目录放在一起。"
            } else {
                "应用运行文件不完整，请使用完整的 Harness Dock.app。"
            }
        }
        "helper_timeout" => "读取状态超时，请刷新确认；不会自动重试写操作。",
        "self_test_unsupported" => "当前连接服务不支持此测试。请先运行连接诊断。",
        "self_test_storage_unavailable" | "invalid_panel_preferences" => {
            "无法安全保存本地记录，请检查私有目录权限后刷新。"
        }
        "self_test_id_conflict" => "已有待确认的测试记录，请先核对原记录，不会重发。",
        "device_not_running" => "设备后台尚未启动。",
        "device_not_installed" => {
            "这是源码或自定义安装的设备，请使用原入口维护，或显式使用此应用管理。"
        }
        "installation_config_mismatch" | "installation_inspection_unavailable" => {
            "后台安装位置尚未确认，请通过原入口维护。"
        }
        "installation_busy" => "另一个安装操作尚未结束，请稍后刷新。",
        "installation_lock_legacy" => {
            "检测到旧版安装操作锁。请先核对旧 helper 已退出、原安装版本与设备身份，再由维护者检查并归档旧锁；等待或重开不会解除。"
        }
        "installation_recovery_unavailable" => {
            "现有目录没有可核实的安装记录，原目录已保留。请通过原安装入口维护。"
        }
        "installation_identity_conflict" => {
            "未完成安装的设备身份或运行包与本次不同。请使用原配置和原候选包继续，不覆盖原目录。"
        }
        "admission_recovery_unsupported" => {
            "当前系统无法读取启动标识，不能安全恢复接收新任务。请继续核对原执行。"
        }
        "admission_recovery_changed" => "原任务集合或恢复检查点已变化，请刷新后重新核对。",
        "admission_recovery_restart_required" => {
            "请先自行重启这台电脑，再重新打开客户端核对恢复条件。"
        }
        "admission_recovery_failed" => {
            "恢复接收任务尚未确认，请先刷新原设备状态，不要重复提交恢复操作。"
        }
        "legacy_lock_recovery_unsupported" => {
            "当前系统无法核实原操作的重启证据，请保留原锁并联系维护者。"
        }
        "legacy_lock_restart_required" => "旧操作锁的检查点已保存，请自行重启这台电脑后再核对。",
        "legacy_lock_changed" => "原操作锁或检查点已变化，请刷新后重新核对，不会归档变更后的锁。",
        "no_previous_release" => "没有可回滚的上一版本。",
        "activation_failed_previous_restored" => "新版本启动失败，已确认恢复上一版本。",
        "activation_failed_recovery_unconfirmed" => {
            "版本切换结果待核对，请刷新核对状态，必要时查看本机日志。"
        }
        "release_integrity_mismatch"
        | "release_platform_mismatch"
        | "incompatible_release_format" => "运行包校验未通过，原安装已保留。",
        "file_not_found" => "所选文件不存在，请重新选择。",
        _ => "操作未确认完成。请刷新设备状态；若问题持续，可查看本机日志。不要重复提交任务。",
    }
}
