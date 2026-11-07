use super::*;
use gpui_kit::component::{
    accordion::Accordion,
    form::{Field, Form},
    separator::Separator,
};

fn preference_label(title: &'static str, detail: &'static str, cx: &App) -> Div {
    v_flex().gap(px(3.)).child(Label::new(title)).child(
        Label::new(detail)
            .text_xs()
            .line_height(px(16.))
            .font_weight(FontWeight::NORMAL)
            .text_color(cx.theme().muted_foreground),
    )
}

impl Panel {
    fn settings_recoveries(&self, cx: &mut Context<Self>) -> Div {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .children(
                self.state["legacyLocks"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|lock| {
                        matches!(lock["scope"].as_str(), Some("connection" | "installation"))
                    })
                    .map(|lock| self.legacy_lock_recovery(lock, cx)),
            )
            .children(
                (self.state["unresolved"].as_u64().unwrap_or(0) > 0)
                    .then(|| self.admission_recovery(cx)),
            )
    }
    fn settings_technical(&self, cx: &mut Context<Self>) -> Accordion {
        let content = self.advanced.then(|| {
            let details = DescriptionList::horizontal()
                .columns(1)
                .bordered(false)
                .label_width(px(88.))
                .item(
                    "配置文件",
                    self.technical_value("config", "配置文件", self.config.clone(), cx),
                    1,
                );
            let cwd = text(&self.state, "cwd");
            let details = if cwd.is_empty() {
                details
            } else {
                details.item(
                    "执行目录",
                    self.technical_value("workdir", "执行目录", cwd, cx),
                    1,
                )
            };
            let installed = text(&self.state, "installedVersion");
            let version = format!(
                "后台 {} / 应用 {}",
                if installed.is_empty() {
                    "待确认"
                } else {
                    &installed
                },
                env!("CARGO_PKG_VERSION"),
            );
            details.item(
                "版本",
                self.technical_value("versions", "版本", version, cx),
                1,
            )
        });
        Accordion::new("settings-advanced")
            .bordered(false)
            .small()
            .h_auto()
            .item(|item| {
                item.title("技术信息")
                    .title_style(div().px_0().py_3().style().clone())
                    .content_style(div().px_0().pb_0().style().clone())
                    .open(self.advanced)
                    .children(content)
            })
            .on_toggle_click(cx.listener(|this, open: &[usize], _, cx| {
                this.advanced = open.contains(&0);
                cx.notify();
            }))
    }

    fn admission_recovery(&self, cx: &mut Context<Self>) -> GroupBox {
        let recovery = &self.state["admissionRecovery"];
        let locked = self.busy || self.interaction_pending || !self.can_recover_admission();
        let can_resume = yes(recovery, "canResume");
        let requires_restart = yes(recovery, "requiresRestart");
        let supported = yes(recovery, "supported");
        surface().gap(px(10.))
            .child(section_title("恢复设备接收任务"))
            .child(self.muted("先回原调用方核对原任务。无法查回时，可建立恢复检查点；自行重启电脑并完成核验后，再恢复接收新任务。", cx))
            .child(self.muted("原结果继续保留为待核对，原任务、输出与审批记录不会删除，也不会重发。", cx))
            .children((!supported).then(|| self.muted("当前系统暂不能核实原执行已结束，请继续在原调用方处理。", cx)))
            .children((supported && requires_restart).then(|| self.muted("恢复检查点已保存。请自行重启这台电脑，再重新打开界舟 核对。", cx)))
            .children((supported && !requires_restart && !can_resume && recovery["checkpointId"].is_string()).then(||
                self.muted("正在等待原执行已结束的系统证据，请刷新后核对。", cx)))
            .children((supported && !requires_restart && !recovery["checkpointId"].is_string()).then(||
                button("prepare-admission-recovery", "建立恢复检查点…").self_start().disabled(locked)
                    .on_click(cx.listener(|this, _, window, cx| this.confirm("prepare-admission-recovery", json!({}),
                        "建立设备恢复检查点？", "先在原调用方核对任务。检查点不改变待核对结果；保存后需要自行重启电脑，再核验是否可以恢复接收新任务。不会重新执行原任务。", window, cx)))))
            .children((supported && can_resume).then(|| {
                let id = text(recovery, "checkpointId");
                button("resume-admission", "恢复接收新任务…").self_start().disabled(locked || id.is_empty())
                    .on_click(cx.listener(move |this, _, window, cx| this.confirm("resume-admission", json!({"id":id}),
                        "恢复设备接收新任务？", "后台会重新核验系统重启证据。原执行仍保留待核对及全部记录，不会重新派发原任务或沿用旧审批决定。", window, cx)))
            }))
    }
    fn legacy_lock_recovery(&self, lock: &Value, cx: &mut Context<Self>) -> GroupBox {
        let scope = text(lock, "scope");
        let label = if scope == "connection" {
            "旧版连接操作中断"
        } else {
            "旧版安装操作中断"
        };
        let locked = self.busy
            || self.interaction_pending
            || !self.persist
            || !self.can_prepare_recovery()
            || self.connect_unconfirmed;
        let supported = yes(lock, "supported");
        let restart = yes(lock, "requiresRestart");
        let recover = yes(lock, "canRecover");
        surface().gap(px(10.))
            .child(section_title(label))
            .child(self.muted("先核对原安装、设备身份及中断操作。建立检查点后自行重启电脑，后台核实旧进程已结束且原锁未变，才可归档旧操作锁。", cx))
            .child(self.muted("只归档已核实的旧锁；不删除执行记录，也不解除待核对任务的准入限制。", cx))
            .children((!self.persist).then(|| self.muted("诊断窗口不管理客户端选中的连接。请正常启动界舟，再到设置中处理旧操作锁。", cx)))
            .children((!supported).then(|| self.muted("当前系统无法核实重启证据，请保留原锁并联系维护者。", cx)))
            .children((supported && restart).then(|| self.muted("检查点已保存，请自行重启这台电脑后再回来核对。", cx)))
            .children((supported && !restart && !recover && lock["checkpointId"].is_string()).then(||
                self.muted("正在等待可核实的系统证据，请刷新后检查。", cx)))
            .children((supported && !lock["checkpointId"].is_string()).then(|| {
                let scope = scope.clone();
                button(SharedString::from(format!("prepare-legacy-{scope}")), "建立恢复检查点…").self_start()
                    .disabled(locked).on_click(cx.listener(move |this, _, window, cx| this.confirm("prepare-legacy-lock-recovery",
                        json!({"scope":scope}), "为中断操作建立恢复检查点？", "请先核对原安装与设备身份。保存后需要自行重启电脑，再由后台核验原操作锁；此步骤不会删除锁或重新执行中断操作。", window, cx)))
            }))
            .children((supported && recover).then(|| {
                let id = text(lock, "checkpointId");
                button(SharedString::from(format!("recover-legacy-{scope}")), "归档旧操作锁…").self_start()
                    .disabled(locked || id.is_empty()).on_click(cx.listener(move |this, _, window, cx| this.confirm("recover-legacy-lock",
                        json!({"scope":scope,"id":id}), "归档已核实的旧操作锁？", "后台会再检查主机重启证据及原锁身份。仅归档旧锁，不恢复未知任务准入，不重试安装、领取邀请或重新执行任务。", window, cx)))
            }))
    }
    fn settings_preferences(&self, cx: &mut Context<Self>) -> GroupBox {
        let unavailable = if cfg!(windows) {
            Some("Windows 尚未提供自动启动。")
        } else if self.stale {
            Some("状态待更新，刷新后可设置。")
        } else if !yes(&self.state, "configured") {
            Some("接入服务器后可开启。")
        } else if yes(&self.state, "externalInstallation") {
            Some("由原安装管理，请在原安装中设置。")
        } else if !self.managed() {
            Some("在概览启用连接管理后可设置。")
        } else if self.connect_unconfirmed {
            Some("核对当前接入结果后可设置。")
        } else if !self.state["autostart"].is_boolean() {
            Some("自动连接状态待确认，请刷新。")
        } else {
            None
        };
        let description = unavailable.unwrap_or("登录电脑时自动连接。");
        let autostart = yes(&self.state, "autostart");
        let control = Switch::new("autostart")
            .checked(autostart)
            .accessibility_label("登录后自动连接")
            .disabled(unavailable.is_some() || self.busy || self.interaction_pending)
            .on_change(cx.listener(|this, enabled, _, cx| {
                if cfg!(windows)
                    || this.stale
                    || this.interaction_pending
                    || this.connect_unconfirmed
                    || !yes(&this.state, "configured")
                    || !this.managed()
                    || !this.state["autostart"].is_boolean()
                {
                    return;
                }
                this.request(
                    "autostart",
                    json!({ "enabled": *enabled }),
                    Reply::State,
                    None,
                    cx,
                );
            }));

        surface()
            .id("settings-preferences")
            .title(section_title("常规"))
            .child(
                Form::horizontal()
                    .label_width(px(144.))
                    .gap_y(px(12.))
                    .child(
                        Field::new().label("外观").items_center().child(
                            h_flex()
                                .min_h(px(32.))
                                .justify_end()
                                .child(self.appearance_controls(cx)),
                        ),
                    )
                    .child(
                        Field::new()
                            .label_indent(false)
                            .child(Separator::horizontal().w_full().h(px(1.))),
                    )
                    .child(
                        Field::new()
                            .label_fn(move |_, cx| {
                                preference_label("登录后自动连接", description, cx)
                            })
                            .items_center()
                            .child(h_flex().min_h(px(32.)).justify_end().child(control)),
                    ),
            )
    }

    pub(super) fn settings(&self, cx: &mut Context<Self>) -> AnyElement {
        let configured = yes(&self.state, "configured");
        let has_recovery = self.state["unresolved"].as_u64().unwrap_or(0) > 0
            || self.state["legacyLocks"].as_array().is_some_and(|locks| {
                locks.iter().any(|lock| {
                    matches!(lock["scope"].as_str(), Some("connection" | "installation"))
                })
            });

        v_flex()
            .gap_6()
            .w_full()
            .children(self.page_feedback(cx))
            .max_w(px(680.))
            .child(self.settings_preferences(cx))
            .children(has_recovery.then(|| self.settings_recoveries(cx)))
            .children(configured.then(|| self.settings_technical(cx)))
            .into_any_element()
    }
}
