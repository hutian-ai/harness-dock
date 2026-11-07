use super::home::overview_connection_row;
use super::*;
use gpui_kit::component::{
    accordion::Accordion,
    form::{Field, Form},
    h_flex,
    menu::{DropdownMenu, PopupMenuItem},
    separator::Separator,
};

const ENTRY_ACTION_WIDTH: f32 = 88.;

impl Panel {
    fn invitation_form(&self, locked: bool, cx: &mut Context<Self>) -> Div {
        let input_error = self.error_operation == Some("invitation") && !self.connect_unconfirmed;
        let pairing_error = self.error_operation == Some("pairing") && !self.connect_unconfirmed;
        let reading = self.active_operation == Some("invitation");
        let help_url = self.bridge.help_url();

        v_flex()
            .gap_5()
            .child(
                Form::vertical().child(
                    Field::new()
                        .label("邀请链接")
                        .gap_2()
                        .description_fn(move |_, cx| {
                            h_flex()
                                .flex_wrap()
                                .gap_1()
                                .child(
                                    Label::new("由服务器管理员提供；确认后核对服务器和执行目录。")
                                        .text_xs()
                                        .text_color(cx.theme().muted_foreground),
                                )
                                .child(
                                    button("invitation-docs", "如何获取？")
                                        .xsmall()
                                        .link()
                                        .disabled(help_url.is_none())
                                        .on_click({
                                            let help_url = help_url.clone();
                                            move |_, _, cx| {
                                                if let Some(url) = &help_url {
                                                    cx.open_url(url);
                                                }
                                            }
                                        }),
                                )
                        })
                        .child(
                            v_flex()
                                .pt_1()
                                .gap_2()
                                .child(
                                    h_flex()
                                        .gap_2()
                                        .child(
                                            div().flex_1().min_w_0().child(
                                                Input::new(&self.input)
                                                    .aria_label("邀请链接")
                                                    .disabled(locked),
                                            ),
                                        )
                                        .child(
                                            button("preview", "确认")
                                                .primary()
                                                .min_w(px(ENTRY_ACTION_WIDTH))
                                                .flex_shrink_0()
                                                .loading(reading)
                                                .disabled(
                                                    locked
                                                        || self
                                                            .input
                                                            .read(cx)
                                                            .value()
                                                            .trim()
                                                            .is_empty(),
                                                )
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.preview_input(cx)
                                                })),
                                        ),
                                )
                                .children(self.error.as_ref().filter(|_| input_error).map(
                                    |message| {
                                        Alert::error("connection-input-error", message.clone())
                                            .small()
                                    },
                                )),
                        ),
                ),
            )
            .child(Separator::horizontal().h(px(1.)))
            .child(
                h_flex()
                    .gap_4()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(Label::new("或使用配对文件").font_weight(FontWeight::MEDIUM))
                            .child(
                                self.muted("选择服务器管理员导出的 device-pairing.json 文件。", cx)
                                    .text_xs(),
                            ),
                    )
                    .child(
                        button("pairing", "选择文件")
                            .min_w(px(ENTRY_ACTION_WIDTH))
                            .flex_shrink_0()
                            .loading(self.active_operation == Some("pairing"))
                            .disabled(locked)
                            .on_click(cx.listener(|this, _, _, cx| this.choose("pairing", cx))),
                    ),
            )
            .children(
                self.error
                    .as_ref()
                    .filter(|_| pairing_error)
                    .map(|message| {
                        Alert::error("connection-pairing-error", message.clone()).small()
                    }),
            )
    }

    fn ca_settings(&self, locked: bool, cx: &mut Context<Self>) -> Accordion {
        let path = self.ca.as_ref().map(|path| {
            Label::new(path.clone())
                .min_w_0()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
        });
        let actions = h_flex()
            .flex_wrap()
            .gap_2()
            .child(
                button(
                    "ca",
                    if self.ca.is_some() {
                        "更换 CA 证书"
                    } else {
                        "选择 CA 证书"
                    },
                )
                .icon(IconName::FileText)
                .disabled(locked)
                .on_click(cx.listener(|this, _, _, cx| this.choose("ca", cx))),
            )
            .children(self.ca.is_some().then(|| {
                button("clear-ca", "移除")
                    .ghost()
                    .disabled(locked)
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.ca = None;
                        cx.notify();
                    }))
            }));

        Accordion::new("connect-tls")
            .bordered(false)
            .h_auto()
            .small()
            .item(|item| {
                item.title(if self.ca.is_some() {
                    "自定义 CA 证书已选择"
                } else {
                    "自定义 CA 证书"
                })
                .title_style(div().py_2().style().clone())
                .content_style(div().pb_2().style().clone())
                .open(self.connect_tls)
                .children(self.connect_tls.then(|| {
                    v_flex()
                        .gap_2()
                        .child(self.muted("仅在远端服务器要求时选择自定义 CA 证书。", cx))
                        .children(path)
                        .child(actions)
                }))
            })
            .on_toggle_click(cx.listener(|this, open: &[usize], _, cx| {
                this.connect_tls = !open.is_empty();
                cx.notify();
            }))
    }

    fn connection_review_form(
        &self,
        preview: &Value,
        recovering: bool,
        locked: bool,
        cx: &mut Context<Self>,
    ) -> Form {
        let directory = h_flex()
            .items_start()
            .gap_2()
            .child(
                Label::new(self.workdir.clone())
                    .flex_1()
                    .min_w_0()
                    .font_family(cx.theme().mono_font_family.clone()),
            )
            .children((!recovering).then(|| {
                button("workdir", "更改目录…")
                    .flex_shrink_0()
                    .disabled(locked)
                    .on_click(cx.listener(|this, _, _, cx| this.choose("workdir", cx)))
            }));
        let actions = h_flex()
            .gap_2()
            .children((!recovering).then(|| {
                button("connect-back", "返回")
                    .disabled(locked)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.preview = None;
                        this.invitation = None;
                        this.pairing = None;
                        this.ca = None;
                        this.connect_tls = false;
                        this.error = None;
                        this.error_operation = None;
                        let input_focus = this.input.read(cx).focus_handle(cx);
                        window.focus(&input_focus, cx);
                        cx.notify();
                    }))
            }))
            .child(
                button(
                    "setup",
                    if recovering {
                        "继续原接入"
                    } else {
                        "确认接入"
                    },
                )
                .primary()
                .loading(matches!(
                    self.active_operation,
                    Some("connect" | "setup" | "recover-connection")
                ))
                .disabled(locked || self.stale)
                .on_click(cx.listener(|this, _, _, cx| this.setup(cx))),
            );

        Form::vertical()
            .gap_4()
            .child(
                Field::new().label("远端服务器").child(
                    Label::new(text(preview, "server"))
                        .min_w_0()
                        .font_family(cx.theme().mono_font_family.clone()),
                ),
            )
            .child(
                Field::new()
                    .label("本机工作目录")
                    .description("远端任务从这个目录启动，并使用 Harness 的本机权限。")
                    .child(directory),
            )
            .children(if recovering {
                self.ca.as_ref().map(|path| {
                    Field::new()
                        .label("自定义 CA 证书")
                        .child(Label::new(path.clone()))
                })
            } else {
                Some(
                    Field::new()
                        .label_indent(false)
                        .child(self.ca_settings(locked, cx)),
                )
            })
            .footer(actions)
    }

    fn connection_refresh(&self, label: &'static str, cx: &mut Context<Self>) -> Button {
        self.read_action(
            "connection-refresh",
            label,
            IconName::RefreshCw,
            "status",
            cx,
        )
        .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)))
    }

    pub(super) fn connect_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let recovering = self.state["connectionRecovery"].is_object();
        let awaiting_result = self.connect_unconfirmed && !recovering;
        let locked = self.busy || self.pending.is_some() || self.test_running();
        let field_error = matches!(self.error_operation, Some("invitation" | "pairing"));
        let claim_error =
            self.connect_unconfirmed && matches!(self.error_operation, Some("connect" | "setup"));
        let issue = self.error.as_ref().filter(|_| !field_error && !claim_error);
        let recovery = awaiting_result.then(|| {
            let end_review = (!self.stale).then(|| {
                button("end-connect-review", "结束核对…")
                    .disabled(self.busy)
                    .on_click(
                        cx.listener(|this, _, window, cx| this.end_connection_review(window, cx)),
                    )
            });
            let detail = if self.stale {
                "先检查这台电脑是否保存了本次接入的记录。"
            } else {
                "这台电脑没有找到可继续的接入记录。请向管理员核实原邀请，再开始新的接入。"
            };
            let check = if self.stale {
                "检查连接状态"
            } else {
                "重新检查"
            };
            surface()
                .child(
                    v_flex()
                        .gap_1()
                        .child(section_title("接入结果待确认"))
                        .child(self.muted(detail, cx)),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_2()
                        .child(
                            self.connection_refresh(check, cx)
                                .when(self.stale, |action| action.primary()),
                        )
                        .children(end_review),
                )
        });
        let form = (!awaiting_result).then(|| {
            if let Some(preview) = &self.preview {
                surface()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(section_title(if recovering {
                                "继续未完成的接入"
                            } else {
                                "核对接入信息"
                            }))
                            .children(
                                recovering
                                    .then(|| self.muted("将使用已保存的设备身份完成接入。", cx)),
                            ),
                    )
                    .child(self.connection_review_form(preview, recovering, locked, cx))
                    .into_any_element()
            } else {
                self.invitation_form(locked, cx).into_any_element()
            }
        });
        v_flex()
            .w_full()
            .max_w(px(metrics::FORM_WIDTH))
            .gap(px(metrics::SECTION_GAP))
            .child(v_flex().gap_1p5().child(page_title("接入服务器")).children(
                (self.preview.is_none() && !awaiting_result).then(|| {
                    self.muted("让远端服务器使用这台电脑上的 Harness，任务在本机执行。", cx)
                }),
            ))
            .children(self.page_feedback(cx))
            .child(
                v_flex()
                    .gap(px(metrics::SECTION_GAP))
                    .children(
                        self.notice.as_ref().map(|message| {
                            Alert::info("connection-notice", message.clone()).small()
                        }),
                    )
                    .children(recovery)
                    .children(
                        issue.map(|message| {
                            Alert::warning("connection-issue", message.clone()).small()
                        }),
                    )
                    .children(
                        (!awaiting_result && self.stale)
                            .then(|| self.connection_refresh("检查连接状态", cx).self_start()),
                    )
                    .children(form)
                    .children(
                        (issue.is_some() || awaiting_result)
                            .then(|| self.log_location_action("connect-logs", cx).self_start()),
                    ),
            )
            .into_any_element()
    }

    fn connection_service_action(&self, cx: &mut Context<Self>) -> Option<Button> {
        let busy = self.busy || self.interaction_pending;
        let locked = busy || self.blocked() || !self.managed();
        if self.stale || !yes(&self.state, "configured") {
            return Some(
                button("settings-refresh", "刷新状态")
                    .primary()
                    .icon(IconName::RefreshCw)
                    .loading(matches!(
                        self.active_operation,
                        Some("status" | "test-status" | "preferences")
                    ))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
            );
        }
        if !self.persist || yes(&self.state, "externalInstallation") {
            return None;
        }
        if !self.managed() {
            return Some(
                button("adopt", "启用连接管理")
                    .primary()
                    .loading(self.active_operation == Some("install"))
                    .disabled(busy || !self.can_adopt_connection())
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.confirm(
                            "install",
                            json!({}),
                            "启用连接管理？",
                            "保留原设备身份和历史，检查空闲后安装独立运行包。",
                            window,
                            cx,
                        )
                    })),
            );
        }
        if self.pending.is_some() && self.can_resume_service() {
            return Some(
                button("resume-service", "恢复服务并核对结果")
                    .primary()
                    .loading(self.active_operation == Some("start"))
                    .disabled(busy)
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.confirm(
                            "start",
                            json!({}),
                            "恢复连接服务并核对原测试？",
                            "仅启动原设备后台并查询已保存的测试编号，不会重新发送模型请求。",
                            window,
                            cx,
                        )
                    })),
            );
        }
        Some(
            button(
                "start-stop",
                if yes(&self.state, "running") {
                    "停止连接"
                } else {
                    "启动连接"
                },
            )
            .when(!yes(&self.state, "running"), |button| button.primary())
            .loading(matches!(self.active_operation, Some("start" | "stop")))
            .disabled(if yes(&self.state, "running") {
                locked
            } else {
                busy || !self.can_resume_service()
            })
            .on_click(cx.listener(|this, _, window, cx| {
                if yes(&this.state, "running") {
                    this.confirm(
                    "stop",
                    json!({}),
                    "停止连接服务？",
                    "停止后，这台电脑将暂时无法接收任务。服务器设置会保留，服务会先检查是否空闲。",
                    window,
                    cx,
                );
                } else {
                    this.request("start", json!({}), Reply::State, None, cx);
                }
            })),
        )
    }

    pub(super) fn connected_summary(&self, cx: &mut Context<Self>) -> Div {
        let running = yes(&self.state, "running");
        let external = !self.persist || yes(&self.state, "externalInstallation");
        let action = (!running || self.stale || self.pending.is_some())
            .then(|| self.connection_service_action(cx))
            .flatten();
        let can_remove = !self.busy
            && !self.interaction_pending
            && !self.blocked()
            && self.managed()
            && self.persist;
        let panel = cx.weak_entity();
        let more = Button::new("connection-more")
            .icon(IconName::Ellipsis)
            .ghost()
            .tooltip("更多连接操作")
            .accessibility_label("更多连接操作")
            .disabled(self.busy || self.interaction_pending)
            .dropdown_menu(move |menu, _, _| {
                let panel = panel.clone();
                let stop_panel = panel.clone();
                menu.item(PopupMenuItem::new("停止连接…").disabled(!can_remove || !running)
                    .on_click(move |_, window, cx| { let _ = stop_panel.update(cx, |this, cx| {
                        this.confirm("stop", json!({}), "停止连接服务？",
                            "停止后暂时无法接收任务。服务器设置会保留，服务会先检查是否空闲。", window, cx);
                    }); }))
                    .item(PopupMenuItem::new("移除服务器…")
                    .disabled(!can_remove)
                    .on_click(move |_, window, cx| {
                        let _ = panel.update(cx, |this, cx| {
                            this.confirm("disconnect", json!({}), "移除这台电脑的服务器连接？",
                                "移除后需使用邀请或以前的配置重新接入，登录后自动连接也会关闭。原设备身份和历史记录会保留。",
                                window, cx);
                        });
                    }))
            });
        let guidance = if self.stale {
            Some("请刷新，确认当前连接状态。")
        } else if external {
            Some("此连接由其他安装入口管理，请通过原入口启停。")
        } else if !self.managed() {
            Some("这是已有配置。启用连接管理后，即可在这里启动和停止。")
        } else if !running && self.pending.is_none() {
            Some("服务器设置已保留，可再次启动连接。")
        } else {
            None
        };
        let server = v_flex()
            .gap_3()
            .pb_4()
            .border_b_1()
            .border_color(cx.theme().border)
            .child(
                overview_connection_row(cx)
                    .px_0()
                    .py_1()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(3.))
                            .child(
                                Label::new(text(&self.state, "server"))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .line_height(px(18.))
                                    .truncate(),
                            )
                            .child(
                                h_flex()
                                    .gap_1p5()
                                    .children(self.server_online().then(|| {
                                        glyph(IconName::CircleCheck, 12.)
                                            .text_color(cx.theme().success)
                                    }))
                                    .child(
                                        self.muted(self.status_label(), cx)
                                            .text_xs()
                                            .line_height(px(16.)),
                                    ),
                            ),
                    )
                    .children(action)
                    .children((!external).then_some(more)),
            )
            .children(
                guidance
                    .map(|message| div().px_3().pb_3().child(self.muted(message, cx).text_xs())),
            );
        let invitation = self.preview.as_ref().map(|preview| {
            let ignore = button("ignore-server-invitation", "忽略邀请")
                .flex_shrink_0()
                .disabled(self.busy)
                .on_click(cx.listener(|this, _, _, cx| {
                    this.preview = None;
                    this.invitation = None;
                    this.pairing = None;
                    this.ca = None;
                    this.connect_tls = false;
                    cx.notify();
                }));
            surface().child(
                h_flex()
                    .gap_4()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_1()
                            .child(section_title("收到新的服务器邀请"))
                            .child(self.muted(
                                format!(
                                    "{} · 移除当前服务器后，可核对并接入。",
                                    text(preview, "server"),
                                ),
                                cx,
                            )),
                    )
                    .child(ignore),
            )
        });

        v_flex().gap_3().child(server).children(invitation)
    }
}
