use crate::bridge::{self, Bridge};
use crate::theme::Appearance;
use gpui_kit::component::input::{InputEvent, InputState};
mod diagnostics;
mod presentation;
#[cfg_attr(target_os = "macos", path = "panel/tray_menu.rs")]
pub mod tray;
mod ui;
mod view;
use gpui_kit::*;
use presentation::{ActivityState, ConnectionState};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Instant;

#[derive(Clone)]
pub struct Pending {
    pub id: String,
    pub provider: String,
}
#[derive(Clone)]
enum Reply {
    Boot,
    State,
    Preview,
    Pairing(String),
    Select(String),
    Checks,
    LogLocation,
    Disconnected,
}
#[derive(Clone, PartialEq)]
pub enum Page {
    Home,
    Provider(String),
    Settings,
    Connect,
    Usage,
    Execution(String),
}

#[derive(Clone)]
struct ActionFence {
    config: String,
    node_id: String,
    daemon_id: String,
    provider: String,
    preview: Option<Value>,
}

enum UserAction {
    Confirmed { op: &'static str, fields: Value },
    Picked { kind: &'static str, path: String },
    Invitation(String),
    EndConnectionReview,
}

struct DeferredAction {
    fence: ActionFence,
    action: UserAction,
}

pub(super) struct DeviceAttention {
    pub title: &'static str,
    pub detail: &'static str,
    pub warning: bool,
}

pub struct Panel {
    pub bridge: Bridge,
    pub config: String,
    pub persist: bool,
    pub state: Value,
    pub busy: bool,
    active_operation: Option<&'static str>,
    pub mutating: bool,
    pub visible: bool,
    pub tray_visible: bool,
    pub pending: Option<Pending>,
    pub refreshed: Instant,
    pub stale: bool,
    page: Page,
    execution_filter: usize,
    execution_limit: usize,
    #[cfg(target_os = "macos")]
    overview_scroll: ScrollHandle,
    #[cfg(target_os = "macos")]
    settings_scroll: ScrollHandle,
    #[cfg(target_os = "macos")]
    detail_scroll: ScrollHandle,
    provider: String,
    notice: Option<String>,
    error: Option<String>,
    preview: Option<Value>,
    invitation: Option<String>,
    pairing: Option<String>,
    workdir: String,
    ca: Option<String>,
    checks: Vec<Value>,
    checked_at: Option<String>,
    diagnostic_details: bool,
    input: Entity<InputState>,
    focus: FocusHandle,
    pub appearance: Appearance,
    advanced: bool,
    connect_tls: bool,
    error_operation: Option<&'static str>,
    connect_unconfirmed: bool,
    uncertain_invitation: Option<String>,
    interaction_pending: bool,
    deferred: Option<DeferredAction>,
}
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_owned()
}
fn yes(v: &Value, key: &str) -> bool {
    v[key] == true
}
fn confirmation(v: &Value, p: &Pending) -> bool {
    (v["acceptedSelfTestId"] == p.id
        && v["acceptedSelfTestProvider"].as_str().unwrap_or("codex") == p.provider)
        || (v["selfTestReceipt"]["id"] == p.id
            && v["selfTestReceipt"]["provider"].as_str().unwrap_or("codex") == p.provider
            && v["selfTestReceipt"]["found"].is_boolean())
        || v["selfTests"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|r| r["id"] == p.id && r["provider"].as_str().unwrap_or("codex") == p.provider)
        })
        || (v["selfTest"]["id"] == p.id
            && v["selfTest"]["provider"].as_str().unwrap_or("codex") == p.provider)
}
impl Panel {
    pub fn new(
        bridge: Bridge,
        config: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        #[cfg(not(target_os = "macos"))]
        window.set_window_title("界舟 · Harness Dock");
        let persist = config.is_none();
        let mut bridge = bridge;
        bridge.single_server = persist;
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("粘贴邀请链接"));
        cx.subscribe(&input, |this, _, event, cx| {
            if matches!(event, InputEvent::Change) {
                this.preview = None;
                this.invitation = None;
                this.pairing = None;
                if !this.connect_unconfirmed {
                    this.error = None;
                    this.error_operation = None;
                }
                cx.notify();
            } else if matches!(
                event,
                InputEvent::PressEnter {
                    secondary: false,
                    shift: false
                }
            ) && matches!(this.page, Page::Home | Page::Connect)
                && this.preview.is_none()
                && !yes(&this.state, "configured")
                && !this.busy
                && !this.blocked()
                && !this.connect_unconfirmed
                && !this.input.read(cx).value().trim().is_empty()
            {
                this.preview_input(cx);
            }
        })
        .detach();
        Self {
            bridge,
            config: config.unwrap_or_else(bridge::default_config),
            persist,
            state: Value::Null,
            busy: false,
            active_operation: None,
            mutating: false,
            visible: true,
            tray_visible: false,
            pending: None,
            refreshed: Instant::now(),
            stale: true,
            page: Page::Home,
            execution_filter: 0,
            execution_limit: 10,
            #[cfg(target_os = "macos")]
            overview_scroll: ScrollHandle::new(),
            #[cfg(target_os = "macos")]
            settings_scroll: ScrollHandle::new(),
            #[cfg(target_os = "macos")]
            detail_scroll: ScrollHandle::new(),
            provider: String::new(),
            notice: None,
            error: None,
            preview: None,
            invitation: None,
            pairing: None,
            workdir: bridge::default_workdir(),
            ca: None,
            checks: vec![],
            checked_at: None,
            diagnostic_details: false,
            input,
            focus: cx.focus_handle(),
            appearance: Appearance::System,
            advanced: false,
            connect_tls: false,
            error_operation: None,
            connect_unconfirmed: false,
            uncertain_invitation: None,
            interaction_pending: false,
            deferred: None,
        }
    }
    pub fn bootstrap(&mut self, cx: &mut Context<Self>) {
        self.request("preferences", json!({}), Reply::Boot, None, cx);
    }
    fn tests(&self) -> Vec<&Value> {
        let mut tests: Vec<_> = self.state["selfTests"]
            .as_array()
            .map(|a| a.iter().collect())
            .unwrap_or_default();
        if self.state["selfTest"].is_object()
            && !tests
                .iter()
                .any(|t| t["id"] == self.state["selfTest"]["id"])
        {
            tests.push(&self.state["selfTest"]);
        }
        tests
    }
    fn test_running(&self) -> bool {
        self.tests()
            .iter()
            .any(|t| t["state"] == "running" || t["phase"] != "finished")
    }
    fn blocked(&self) -> bool {
        self.stale
            || self.pending.is_some()
            || self.test_running()
            || (yes(&self.state, "configured") && !ActivityState::read(&self.state).idle())
    }
    fn managed(&self) -> bool {
        yes(&self.state, "managed") && !yes(&self.state, "externalInstallation")
    }
    fn server_online(&self) -> bool {
        self.connection_state() == ConnectionState::Connected
    }
    fn connection_state(&self) -> ConnectionState {
        ConnectionState::read(&self.state, self.stale, self.connect_unconfirmed)
    }
    pub fn connection_destination(&self) -> Page {
        let can_resume = self.state["connectionRecovery"].is_object();
        if !self.stale
            && self.state["configured"] == false
            && (!self.connect_unconfirmed || can_resume)
        {
            Page::Connect
        } else {
            Page::Home
        }
    }
    fn can_resume_service(&self) -> bool {
        !self.stale && self.managed() && !yes(&self.state, "running") && !self.connect_unconfirmed
    }
    fn can_adopt_connection(&self) -> bool {
        // A first installation may have no execution store. The helper still checks
        // the original owner and store before installation; unknown is not idle.
        self.persist
            && !self.stale
            && !self.connect_unconfirmed
            && yes(&self.state, "configured")
            && !self.managed()
            && !yes(&self.state, "externalInstallation")
            && self.pending.is_none()
            && !self.test_running()
            && !matches!(ActivityState::read(&self.state),
                ActivityState::Known { active, unresolved } if active > 0 || unresolved > 0)
    }
    fn can_recover_admission(&self) -> bool {
        self.can_prepare_recovery()
            && !self.connect_unconfirmed
            && self.managed()
            && yes(&self.state, "running")
            && yes(&self.state["admissionRecovery"], "supported")
    }
    fn can_prepare_recovery(&self) -> bool {
        let activity = ActivityState::read(&self.state);
        // An interrupted first installation may have a legacy lock but no execution
        // store yet. Only its helper-verified lock recovery can use this offline
        // exception; admission recovery separately requires a running owner.
        let offline_legacy = matches!(activity, ActivityState::Unknown)
            && self.state["running"] == false
            && self.state["legacyLocks"].as_array().is_some_and(|locks| {
                locks.iter().any(|lock| {
                    yes(lock, "supported")
                        && matches!(lock["scope"].as_str(), Some("connection" | "installation"))
                })
            });
        !self.stale
            && self.pending.is_none()
            && !self.test_running()
            && (!yes(&self.state, "configured") || activity.no_active() || offline_legacy)
    }
    fn legacy_action_allowed(&self, op: &str, fields: &Value) -> bool {
        self.persist
            && self.can_prepare_recovery()
            && self.state["legacyLocks"].as_array().is_some_and(|locks| {
                locks.iter().any(|lock| {
                    lock["scope"] == fields["scope"]
                        && yes(lock, "supported")
                        && match op {
                            "prepare-legacy-lock-recovery" => true,
                            "recover-legacy-lock" => {
                                yes(lock, "canRecover")
                                    && fields["id"].is_string()
                                    && fields["id"] == lock["checkpointId"]
                            }
                            _ => false,
                        }
                })
            })
    }
    fn admission_action_allowed(&self, op: &str, fields: &Value) -> bool {
        self.can_recover_admission()
            && match op {
                "prepare-admission-recovery" => true,
                "resume-admission" => {
                    yes(&self.state["admissionRecovery"], "canResume")
                        && fields["id"].is_string()
                        && fields["id"] == self.state["admissionRecovery"]["checkpointId"]
                }
                _ => false,
            }
    }
    pub fn can_handle_open(&self) -> bool {
        !self.busy && !self.interaction_pending && self.deferred.is_none()
    }
    fn attention(&self) -> Option<DeviceAttention> {
        if self.active_operation == Some("test") {
            Some(DeviceAttention {
                title: "正在提交本机测试",
                detail: "收到测试编号后，将在原记录中查看结果。",
                warning: false,
            })
        } else if self.pending.is_some() {
            Some(DeviceAttention {
                title: "测试启动结果待核对",
                detail: if yes(&self.state, "running") {
                    "正在查询原测试；不会重复发送请求，维护暂不可用。"
                } else {
                    "连接服务已停止。恢复后仅查询原测试，不会重复发送请求。"
                },
                warning: true,
            })
        } else if self.state["unresolved"].as_u64().unwrap_or(0) > 0 {
            Some(DeviceAttention {
                title: "有执行结果待核对",
                detail: "请回原调用方核对原任务。维护暂不可用，不会自动重派任务。",
                warning: true,
            })
        } else if !self.stale
            && yes(&self.state, "configured")
            && matches!(ActivityState::read(&self.state), ActivityState::Unknown)
        {
            Some(DeviceAttention {
                title: "任务状态尚未确认",
                detail: if yes(&self.state, "running") {
                    "当前服务未提供完整任务状态，暂不能停止连接或移除服务器。请运行连接诊断。"
                } else {
                    "启动原连接后可继续核对任务；不会重新发送任务。核对前暂不能移除服务器。"
                },
                warning: true,
            })
        } else if self.test_running() {
            Some(DeviceAttention {
                title: "本机测试进行中",
                detail: "正在等待原测试结果，可查看其他 Harness；维护暂不可用。",
                warning: false,
            })
        } else if self.state["active"].as_u64().unwrap_or(0) > 0 {
            Some(DeviceAttention {
                title: "设备正在执行任务",
                detail: "进度与原生审批请在调用方查看。任务结束前暂不可测试或维护。",
                warning: false,
            })
        } else if self.state["legacyLocks"]
            .as_array()
            .is_some_and(|locks| !locks.is_empty())
        {
            Some(DeviceAttention {
                title: "旧版操作需要核对",
                detail: "请在设置中核对中断操作，建立恢复检查点后再处理原操作锁。",
                warning: true,
            })
        } else {
            None
        }
    }
    fn fence(&self) -> ActionFence {
        ActionFence {
            config: self.config.clone(),
            node_id: text(&self.state, "nodeId"),
            daemon_id: text(&self.state, "daemonId"),
            provider: self.provider.clone(),
            preview: self.preview.clone(),
        }
    }
    fn action_error(&mut self, message: &str, cx: &mut Context<Self>) {
        self.error = Some(message.into());
        self.error_operation = None;
        cx.notify();
    }
    fn queue_user_decision(
        &mut self,
        action: UserAction,
        fence: ActionFence,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            self.submit_user_action(action, fence, cx);
            return;
        }
        self.deferred = Some(DeferredAction { fence, action });
        self.notice = Some("正在核对设备状态，完成后继续这次操作。".into());
        // Re-read the owner after a system dialog; a long-open dialog cannot
        // authorize a different daemon or selected binding. This never retries work.
        self.request(
            "status",
            json!({"refreshProviders":false}),
            Reply::State,
            None,
            cx,
        );
    }
    fn submit_user_action(
        &mut self,
        action: UserAction,
        fence: ActionFence,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            // Only one explicit user decision can wait behind a read. It is consumed once,
            // revalidated after that read, and is never a retry of a submitted mutation.
            if self.deferred.is_some()
                || !matches!(
                    self.active_operation,
                    Some("status" | "test-status" | "preferences")
                )
            {
                self.action_error("另一个操作尚未结束，请等待后重新操作。", cx);
            } else {
                self.deferred = Some(DeferredAction { fence, action });
                self.notice = Some("正在读取最新状态，完成后继续这次操作。".into());
                cx.notify();
            }
            return;
        }
        if self.config != fence.config
            || text(&self.state, "nodeId") != fence.node_id
            || text(&self.state, "daemonId") != fence.daemon_id
        {
            self.action_error("设备或连接状态已变化，请核对当前页面后重新操作。", cx);
            return;
        }
        match action {
            UserAction::Confirmed { op, fields } => {
                let resume = op == "start" && self.can_resume_service();
                let adopt = op == "install" && self.can_adopt_connection();
                let admission_recovery = self.admission_action_allowed(op, &fields);
                let legacy_recovery = self.legacy_action_allowed(op, &fields);
                if matches!(op, "prepare-admission-recovery" | "resume-admission")
                    && !admission_recovery
                {
                    self.action_error("恢复条件或检查点已变化，请刷新后重新核对。", cx);
                    return;
                }
                if matches!(op, "prepare-legacy-lock-recovery" | "recover-legacy-lock")
                    && !legacy_recovery
                {
                    self.action_error("旧操作锁或恢复条件已变化，请刷新后重新核对。", cx);
                    return;
                }
                if self.connect_unconfirmed
                    || (!resume
                        && !adopt
                        && !admission_recovery
                        && !legacy_recovery
                        && self.blocked())
                {
                    self.action_error(
                        "当前状态暂不允许这次操作，请先刷新并核对进行中的任务或测试。",
                        cx,
                    );
                    return;
                }
                if op == "test" {
                    let supported = self.state["providers"].as_array().is_some_and(|rows| {
                        rows.iter().any(|row| {
                            row["key"] == fence.provider
                                && row["status"] == "installed"
                                && yes(row, "selfTestSupported")
                        })
                    });
                    if self.provider != fence.provider || !supported || !yes(&self.state, "running")
                    {
                        self.action_error("Harness 或测试条件已变化，请核对后重新确认测试。", cx);
                        return;
                    }
                    let id = uuid::Uuid::new_v4().to_string();
                    self.pending = Some(Pending {
                        id: id.clone(),
                        provider: fence.provider.clone(),
                    });
                    self.request(
                        "test",
                        json!({"testId":id,"provider":fence.provider}),
                        Reply::State,
                        None,
                        cx,
                    );
                } else {
                    let reply = if op == "disconnect" {
                        Reply::Disconnected
                    } else {
                        Reply::State
                    };
                    self.request(op, fields, reply, None, cx);
                }
            }
            UserAction::Picked { kind, path } => {
                if self.state["connectionRecovery"].is_object() {
                    // The owner read may discover a claim created while the picker
                    // was open. Keep that claim's review intact; a new file must not
                    // replace the displayed server while setup resumes the old claim.
                    self.page = Page::Connect;
                    self.action_error(
                        "已找到原接入记录，请先核对并继续原接入；本次文件选择未应用。",
                        cx,
                    );
                    return;
                }
                if self.connect_unconfirmed
                    || self.pending.is_some()
                    || self.test_running()
                    || ((kind == "ca" || kind == "workdir") && self.preview != fence.preview)
                {
                    self.action_error("接入信息或设备状态已变化，请重新选择。", cx);
                    return;
                }
                match kind {
                    "pairing" => {
                        self.preview = None;
                        self.invitation = None;
                        self.pairing = None;
                        self.request(
                            "pairing",
                            json!({"pairing":path}),
                            Reply::Pairing(path),
                            None,
                            cx,
                        );
                    }
                    "ca" => {
                        self.ca = Some(path);
                        cx.notify();
                    }
                    _ => {
                        self.workdir = path;
                        cx.notify();
                    }
                }
            }
            UserAction::Invitation(link) => self.read_invitation(link, cx),
            UserAction::EndConnectionReview => {
                if self.stale
                    || yes(&self.state, "configured")
                    || self.state["connectionRecovery"].is_object()
                {
                    self.action_error("已找到原接入记录，请继续核对原连接。", cx);
                    return;
                }
                self.uncertain_invitation = self.invitation.take();
                self.connect_unconfirmed = false;
                self.preview = None;
                self.pairing = None;
                self.error = None;
                self.error_operation = None;
                self.notice = Some(
                    "本机没有可继续的接入记录。请先向管理员核实原邀请，再使用新的邀请。".into(),
                );
                cx.notify();
            }
        }
    }
    fn drain_deferred(&mut self, cx: &mut Context<Self>) {
        if !self.busy {
            if let Some(action) = self.deferred.take() {
                self.notice = None;
                if self.stale {
                    self.notice =
                        Some("未取得最新设备状态，这次确认尚未执行。请刷新后重新操作。".into());
                    cx.notify();
                    return;
                }
                self.submit_user_action(action.action, action.fence, cx);
            }
        }
    }
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let (op, fields) = match &self.pending {
            Some(p) if !self.stale && yes(&self.state, "running") => {
                ("test-status", json!({"testId":p.id,"provider":p.provider}))
            }
            // A receipt identifies the original test, not a running owner. First
            // read that owner so a stopped service can be explicitly restored.
            _ => ("status", json!({})),
        };
        self.request(op, fields, Reply::State, None, cx);
    }
    fn request(
        &mut self,
        op: &'static str,
        fields: Value,
        reply: Reply,
        target: Option<String>,
        cx: &mut Context<Self>,
    ) {
        if self.busy {
            return;
        }
        let config = target.unwrap_or_else(|| self.config.clone());
        let bridge = self.bridge.clone();
        let persist = self.persist;
        let pending = self.pending.clone();
        let receipt_pending = pending.clone();
        self.busy = true;
        self.active_operation = Some(op);
        self.mutating = ![
            "status",
            "test-status",
            "invitation",
            "pairing",
            "doctor",
            "provider-details",
            "log-location",
            "preferences",
        ]
        .contains(&op);
        if !["status", "test-status", "log-location"].contains(&op) {
            if !self.connect_unconfirmed {
                self.error = None;
                self.error_operation = None;
            }
            self.notice = None;
        }
        cx.notify();
        cx.spawn(async move |this, cx| {
            let query_config = config.clone();
            let kind = reply.clone();
            let (result, clear) = cx
                .background_executor()
                .spawn(async move {
                    let mut clear = false;
                    let result = (|| -> Result<Value, String> {
                        if matches!(kind, Reply::Boot) {
                            let prefs = if persist {
                                bridge.call("preferences", &query_config, json!({}))?
                            } else {
                                json!({"config":query_config,"provider":""})
                            };
                            let selected = prefs["pending"]["config"]
                                .as_str()
                                .or(prefs["config"].as_str())
                                .unwrap_or(&query_config);
                            let state = bridge.call("status", selected, json!({}))?;
                            return Ok(
                                json!({"preferences":prefs,"config":selected,"device":state}),
                            );
                        }
                        if op == "test" && persist {
                            if let Err(error) =
                                bridge.call("save-test-receipt", &query_config, fields.clone())
                            {
                                clear = true;
                                return Err(error);
                            }
                        }
                        let result = bridge.call(op, &query_config, fields.clone());
                        if let Some(p) = &receipt_pending {
                            let confirmed = result.as_ref().is_ok_and(|v| confirmation(v, p));
                            let rejected = op == "test"
                                && result.as_ref().err().is_some_and(|e| {
                                    [
                                        "device_busy",
                                        "unresolved_execution",
                                        "device_not_running",
                                        "self_test_unsupported",
                                        "self_test_storage_unavailable",
                                        "self_test_id_conflict",
                                    ]
                                    .contains(&e.as_str())
                                });
                            if confirmed || rejected {
                                if persist {
                                    bridge.call(
                                        "clear-test-receipt",
                                        &query_config,
                                        json!({"provider":p.provider,"testId":p.id}),
                                    )?;
                                }
                                clear = true;
                            }
                        }
                        result
                    })();
                    (result, clear)
                })
                .await;
            let _ = this.update(cx, |this, cx| {
                this.busy = false;
                this.active_operation = None;
                this.mutating = false;
                if clear && this.pending.as_ref().map(|p| &p.id) == pending.as_ref().map(|p| &p.id)
                {
                    this.pending = None;
                }
                match result {
                    Ok(value) => match reply {
                        Reply::Boot => {
                            this.appearance =
                                Appearance::parse(&text(&value["preferences"], "appearance"));
                            this.appearance.apply(cx);
                            this.set_config(text(&value, "config"));
                            this.provider = text(&value["preferences"], "provider");
                            let p = &value["preferences"]["pending"];
                            if p["id"].is_string() {
                                this.pending = Some(Pending {
                                    id: text(p, "id"),
                                    provider: text(p, "provider"),
                                });
                            }
                            this.apply(value["device"].clone());
                        }
                        Reply::State => {
                            if this.config == config {
                                if matches!(op, "status" | "test-status")
                                    && matches!(
                                        this.error_operation,
                                        Some("status" | "test-status")
                                    )
                                    && !this.connect_unconfirmed
                                {
                                    this.error = None;
                                    this.error_operation = None;
                                }
                                this.apply(value);
                            }
                        }
                        Reply::Select(path) => {
                            if yes(&value, "configured") {
                                this.set_config(path);
                                this.apply(value);
                                this.navigate(Page::Home, cx);
                                this.preview = None;
                                this.invitation = None;
                                this.pairing = None;
                                this.ca = None;
                                this.connect_tls = false;
                            } else {
                                this.error = Some("所选文件尚未配置设备。".into());
                            }
                        }
                        Reply::Preview => {
                            this.preview = Some(value);
                            this.navigate(Page::Connect, cx);
                        }
                        Reply::Pairing(path) => {
                            this.pairing = Some(path);
                            this.invitation = None;
                            this.preview = Some(value);
                            this.navigate(Page::Connect, cx);
                        }
                        Reply::Checks => {
                            this.checks = value["checks"].as_array().cloned().unwrap_or_default();
                            this.checked_at =
                                Some(chrono::Local::now().format("%H:%M:%S").to_string());
                            this.diagnostic_details = false;
                        }
                        Reply::Disconnected => {
                            this.set_config(text(&value, "config"));
                            this.apply(value["device"].clone());
                            let next = if this.preview.is_some() {
                                Page::Connect
                            } else {
                                Page::Home
                            };
                            this.navigate(next, cx);
                            this.notice =
                                Some("已移除服务器连接。原设备身份和历史记录已保留。".into());
                        }
                        Reply::LogLocation => {
                            let path = Path::new(value["path"].as_str().unwrap_or_default());
                            if this.config == config
                                && path.is_absolute()
                                && path.file_name().is_some_and(|name| name == "daemon.log")
                            {
                                cx.reveal_path(path);
                            } else {
                                this.notice = Some("暂时无法定位本机日志。".into());
                            }
                        }
                    },
                    Err(code) => {
                        if code == "panel_selection_changed" {
                            this.deferred = None;
                            this.stale = true;
                            this.navigate(Page::Home, cx);
                            this.bootstrap(cx);
                            return;
                        }
                        if op == "log-location" {
                            this.notice = Some(
                                if code == "log_not_found" {
                                    "尚未生成本机日志。"
                                } else {
                                    "暂时无法定位本机日志。"
                                }
                                .into(),
                            );
                            this.drain_deferred(cx);
                            cx.notify();
                            return;
                        }
                        if code == "pairing_changed" {
                            this.preview = None;
                            this.pairing = None;
                            this.invitation = None;
                        }
                        if op == "setup" || op == "connect" {
                            this.set_config(config.clone());
                            this.state = Value::Null;
                            // Unknown claim outcomes cannot be resolved by an absent local config.
                            // Keep submission blocked until an existing identity is read back.
                            this.connect_unconfirmed = code == "invitation_claim_unconfirmed"
                                || code == "connection_change_busy"
                                || code == "helper_timeout"
                                || bridge::message(&code) == bridge::message("management_failed");
                        }
                        this.error_operation = Some(op);
                        this.error = Some(match op {
                            "invitation" if code == "management_failed" => {
                                "暂时无法读取邀请，请检查链接是否完整，再重新读取。".into()
                            }
                            "pairing" if code == "management_failed" => {
                                "暂时无法读取配对文件，请确认选择了管理员提供的文件，再重新读取。"
                                    .into()
                            }
                            "connect" | "setup" if this.connect_unconfirmed => {
                                "尚未确认这次接入是否完成，请先检查连接状态，避免重复领取邀请。"
                                    .into()
                            }
                            _ => bridge::message(&code).into(),
                        });
                        if ["status", "test-status", "preferences"].contains(&op) {
                            this.stale = true;
                        }
                        // Read back the original identity after an unconfirmed mutation. Never retry the mutation.
                        if ![
                            "status",
                            "test-status",
                            "preferences",
                            "invitation",
                            "pairing",
                            "doctor",
                        ]
                        .contains(&op)
                        {
                            this.stale = true;
                            this.refreshed = Instant::now() - std::time::Duration::from_secs(11);
                        }
                    }
                }
                this.drain_deferred(cx);
                cx.notify();
            });
        })
        .detach();
    }
    fn set_config(&mut self, config: String) {
        if self.config != config {
            self.checks.clear();
            self.checked_at = None;
            self.diagnostic_details = false;
            self.advanced = false;
        }
        self.config = config;
    }

    fn apply(&mut self, mut state: Value) {
        if self.state["nodeId"] != state["nodeId"] {
            self.checks.clear();
            self.checked_at = None;
            self.diagnostic_details = false;
        }
        // A lightweight poll carries no installation snapshot, including before pairing.
        if state["providersRefreshed"] == false {
            let supported = state["selfTestProviders"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut providers = self.state["providers"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for provider in &mut providers {
                provider["selfTestSupported"] = json!(
                    provider["status"] == "installed" && supported.contains(&provider["key"])
                );
            }
            state["providers"] = json!(providers);
        }
        if yes(&state, "configured") && self.connect_unconfirmed {
            self.connect_unconfirmed = false;
            self.preview = None;
            self.invitation = None;
            self.pairing = None;
            self.error = None;
            self.error_operation = None;
        }
        if !yes(&state, "configured") && state["connectionRecovery"].is_object() {
            self.preview = Some(state["connectionRecovery"].clone());
            self.workdir = text(&state["connectionRecovery"], "cwd");
            self.ca = state["connectionRecovery"]["caFile"]
                .as_str()
                .map(str::to_owned);
            self.invitation = None;
            self.pairing = None;
        }
        self.state = state;
        if self.page == Page::Connect && yes(&self.state, "configured") {
            self.page = Page::Home;
            self.notice = Some(
                if yes(&self.state, "connected") && !self.state["connectionIssue"].is_string() {
                    "接入成功。回到提供邀请的应用，即可向这台电脑发起任务。"
                } else {
                    "服务器设置已保存，正在核对连接状态。"
                }
                .into(),
            );
        }
        self.stale = false;
        self.refreshed = Instant::now();
        if self.provider.is_empty() {
            self.provider = self.state["providers"]
                .as_array()
                .and_then(|a| a.iter().find(|p| p["status"] == "installed"))
                .map(|p| text(p, "key"))
                .unwrap_or_else(|| "codex".into());
        }
    }
    pub fn receive_invitation(&mut self, link: String, cx: &mut Context<Self>) {
        self.submit_user_action(UserAction::Invitation(link), self.fence(), cx);
    }
    fn read_invitation(&mut self, link: String, cx: &mut Context<Self>) {
        if self.state["connectionRecovery"].is_object() {
            self.page = Page::Connect;
            self.preview = Some(self.state["connectionRecovery"].clone());
            self.notice = Some("已保存原接入信息，请先继续原接入。不会领取新邀请。".into());
            cx.notify();
            return;
        }
        if self.connect_unconfirmed {
            self.page = Page::Connect;
            cx.notify();
            return;
        }
        if self.pending.is_some() || self.test_running() {
            self.error = Some("当前操作或本机测试尚未结束，请稍后重新打开邀请。".into());
            cx.notify();
            return;
        }
        if link.len() > 4096 {
            self.error = Some(bridge::message("invalid_invitation").into());
            self.error_operation = Some("invitation");
            cx.notify();
            return;
        }
        if self.uncertain_invitation.as_deref() == Some(link.trim()) {
            self.action_error(
                "原邀请的领取结果曾待核对，请使用管理员核实后提供的新邀请。",
                cx,
            );
            return;
        }
        self.preview = None;
        self.invitation = Some(link.trim().to_owned());
        self.pairing = None;
        self.request(
            "invitation",
            json!({"invitation":self.invitation}),
            Reply::Preview,
            None,
            cx,
        );
    }
    fn preview_input(&mut self, cx: &mut Context<Self>) {
        let link = self.input.read(cx).value().to_string();
        self.receive_invitation(link, cx);
    }
    fn confirm(
        &mut self,
        op: &'static str,
        fields: Value,
        title: &str,
        detail: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let resume = op == "start" && self.can_resume_service();
        let adopt = op == "install" && self.can_adopt_connection();
        let admission_recovery = self.admission_action_allowed(op, &fields);
        let legacy_recovery = self.legacy_action_allowed(op, &fields);
        if self.busy
            || self.interaction_pending
            || (!resume && !adopt && !admission_recovery && !legacy_recovery && self.blocked())
        {
            self.action_error("设备状态暂不允许此操作，请先核对当前状态。", cx);
            return;
        }
        let fence = self.fence();
        self.interaction_pending = true;
        let action_label = match op {
            "test" => format!(
                "测试 {}",
                if self.provider == "dsh" {
                    "DeepSeek Harness"
                } else {
                    "Codex"
                }
            ),
            "stop" => "停止服务".into(),
            "start" => "恢复服务并核对结果".into(),
            "install" => "启用连接管理".into(),
            "disconnect" => "移除服务器".into(),
            "prepare-admission-recovery" => "建立恢复检查点".into(),
            "resume-admission" => "恢复接收新任务".into(),
            "prepare-legacy-lock-recovery" => "建立恢复检查点".into(),
            "recover-legacy-lock" => "归档旧操作锁".into(),
            "autostart" => if fields["enabled"] == true {
                "开启自动连接"
            } else {
                "关闭自动连接"
            }
            .into(),
            _ => "继续操作".into(),
        };
        let answer = window.prompt(
            PromptLevel::Warning,
            title,
            Some(detail),
            &[
                PromptButton::cancel("取消"),
                PromptButton::new(action_label),
            ],
            cx,
        );
        cx.spawn(async move |this, cx| {
            let accepted = answer.await == Ok(1);
            let _ = this.update(cx, |this, cx| {
                this.interaction_pending = false;
                if accepted {
                    this.queue_user_decision(UserAction::Confirmed { op, fields }, fence, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn choose(&mut self, kind: &'static str, cx: &mut Context<Self>) {
        if self.busy
            || self.interaction_pending
            || self.pending.is_some()
            || self.test_running()
            || self.connect_unconfirmed
        {
            return;
        }
        let fence = self.fence();
        self.interaction_pending = true;
        let answer = cx.prompt_for_paths(PathPromptOptions {
            files: kind != "workdir",
            directories: kind == "workdir",
            multiple: false,
            prompt: Some(
                match kind {
                    "pairing" => "选择远端服务器提供的配对文件",
                    "ca" => "选择可信 CA 证书",
                    _ => "选择 Harness 工作目录",
                }
                .into(),
            ),
        });
        cx.spawn(async move |this, cx| {
            let answer = answer.await;
            let _ = this.update(cx, |this, cx| {
                this.interaction_pending = false;
                if let Ok(Ok(Some(paths))) = answer {
                    if let Some(path) = paths.first() {
                        this.queue_user_decision(
                            UserAction::Picked {
                                kind,
                                path: path.to_string_lossy().into_owned(),
                            },
                            fence,
                            cx,
                        );
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }
    fn setup(&mut self, cx: &mut Context<Self>) {
        if self.busy
            || self.pending.is_some()
            || self.test_running()
            || self.stale
            || self.preview.is_none()
        {
            return;
        }
        if self.state["connectionRecovery"].is_object() {
            self.request(
                "recover-connection",
                json!({}),
                Reply::Select(self.config.clone()),
                None,
                cx,
            );
            return;
        }
        if self.connect_unconfirmed {
            return;
        }
        let mut fields = json!({"cwd":self.workdir});
        if let Some(link) = &self.invitation {
            fields["invitation"] = json!(link);
        } else if let Some(file) = &self.pairing {
            fields["pairing"] = json!(file);
            fields["expectedPairingDigest"] = self
                .preview
                .as_ref()
                .map(|value| value["pairingDigest"].clone())
                .unwrap_or(Value::Null);
        } else {
            return;
        }
        if let Some(ca) = &self.ca {
            fields["caFile"] = json!(ca);
        }
        // The helper owns the selected binding; the UI never allocates another device profile.
        if yes(&self.state, "configured") {
            return;
        }
        let config = self.config.clone();
        self.request(
            if self.persist { "connect" } else { "setup" },
            fields,
            Reply::Select(config),
            None,
            cx,
        );
    }
    fn end_connection_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy || self.interaction_pending {
            return;
        }
        let fence = self.fence();
        self.interaction_pending = true;
        let answer = window.prompt(PromptLevel::Warning, "结束本次接入核对？", Some("本机没有找到可继续的接入记录，原邀请可能已被领取。请先向管理员核实原设备身份，再使用新的邀请；此操作不会重新领取原邀请或启动任务。"),
            &[PromptButton::cancel("继续核对"), PromptButton::new("结束核对")], cx);
        cx.spawn(async move |this, cx| {
            let accepted = answer.await == Ok(1);
            let _ = this.update(cx, |this, cx| {
                this.interaction_pending = false;
                if accepted {
                    this.queue_user_decision(UserAction::EndConnectionReview, fence, cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
    pub fn quit(&mut self, cx: &mut Context<Self>) {
        if self.mutating {
            self.error = Some("安装或维护正在进行，完成后才能退出；可以先收起窗口。".into());
            cx.notify();
        } else {
            cx.quit();
        }
    }
    pub fn hide(&mut self, cx: &mut Context<Self>) {
        self.visible = false;
        cx.hide();
    }
    fn test_label(&self, provider: &str) -> String {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.provider == provider)
        {
            return if self.active_operation == Some("test") {
                "正在提交"
            } else {
                "启动结果待核对"
            }
            .into();
        }
        if self.stale {
            return "测试状态待刷新".into();
        }
        let last = self
            .tests()
            .into_iter()
            .filter(|t| t["provider"].as_str().unwrap_or("codex") == provider)
            .max_by_key(|t| t["startedAt"].as_u64().unwrap_or(0));
        last.map(|t| {
            match t["state"].as_str() {
                Some("passed") => "上次测试通过",
                Some("running") => "测试进行中",
                Some("failed") => "上次测试未通过",
                _ => "原结果待核对",
            }
            .into()
        })
        .unwrap_or_else(|| "尚未测试".into())
    }
    fn status_label(&self) -> &'static str {
        self.connection_state().label()
    }

    fn set_appearance(&mut self, appearance: Appearance, cx: &mut Context<Self>) {
        self.appearance = appearance;
        appearance.apply(cx);
        cx.notify();
        if !self.persist {
            return;
        }
        let bridge = self.bridge.clone();
        let config = self.config.clone();
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async move {
                    bridge.call(
                        "save-appearance",
                        &config,
                        json!({"appearance":appearance.key()}),
                    )
                })
                .await;
            if result.is_err() {
                let _ = this.update(cx, |this, cx| {
                    if this.appearance == appearance {
                        this.notice = Some("外观已切换，偏好暂未保存。".into());
                        cx.notify();
                    }
                });
            }
        })
        .detach();
    }
    pub fn tick(&mut self, cx: &mut Context<Self>) {
        let interval = if self.pending.is_some() || self.test_running() {
            2
        } else {
            10
        };
        if !self.busy
            && !self.interaction_pending
            && self.deferred.is_none()
            && (self.visible || self.tray_visible || self.pending.is_some() || self.test_running())
            && self.refreshed.elapsed().as_secs() >= interval
        {
            if self.stale || self.pending.is_some() || self.state["providers"].as_array().is_none()
            {
                self.refresh(cx);
            } else {
                self.request(
                    "status",
                    json!({"refreshProviders":false}),
                    Reply::State,
                    None,
                    cx,
                );
            }
        }
    }
}
