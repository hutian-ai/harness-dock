use super::*;
use gpui_kit::component::{
    description_list::{DescriptionItem, DescriptionList},
    h_flex,
    label::Label,
    separator::Separator,
    table::{Table, TableBody, TableCell, TableHead, TableHeader, TableRow},
    tooltip::Tooltip,
    v_flex,
};

/// Keep both slots on the same baseline without changing Kit's field styling.
/// The medium description-list gap adds 4 px between these 40 px rows.
fn provider_fact(label: &str, value: impl IntoElement) -> DescriptionItem {
    DescriptionItem::new(
        h_flex()
            .min_h(px(40.))
            .child(Label::new(label.to_owned()).text_sm())
            .into_any_element(),
    )
    .value(
        h_flex()
            .min_h(px(40.))
            .min_w_0()
            .child(div().flex_1().min_w_0().child(value))
            .into_any_element(),
    )
}

impl Panel {
    pub(super) fn provider_page(&self, key: &str, cx: &mut Context<Self>) -> AnyElement {
        let provider = self.state["providers"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["key"] == key))
            .cloned()
            .unwrap_or(Value::Null);
        let latest = self
            .tests()
            .into_iter()
            .filter(|test| test["provider"].as_str().unwrap_or("codex") == key)
            .max_by_key(|test| test["startedAt"].as_u64().unwrap_or(0))
            .cloned();
        let installed = provider["status"] == "installed";
        let name = provider_name(&provider);
        let name = if name.is_empty() {
            match key {
                "codex" => "Codex",
                "dsh" => "DeepSeek Harness",
                _ => "Harness",
            }
            .to_owned()
        } else {
            name
        };
        let when = latest
            .as_ref()
            .filter(|_| !self.stale && self.pending.as_ref().is_none_or(|p| p.provider != key))
            .and_then(|t| t["finishedAt"].as_u64().or(t["startedAt"].as_u64()))
            .map(|at| {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                let minutes = now.saturating_sub(at as u128) / 60_000;
                if minutes < 1 {
                    "刚刚".into()
                } else if minutes < 60 {
                    format!("{minutes} 分钟前")
                } else if minutes < 1440 {
                    format!("{} 小时前", minutes / 60)
                } else {
                    format!("{} 天前", minutes / 1440)
                }
            });
        let status = Label::new(self.test_label(key)).text_sm();
        let status = match when {
            Some(age) => status.secondary(format!("· {age}")),
            None => status,
        };
        let failure = latest
            .as_ref()
            .filter(|test| test["state"] == "failed" || test["state"] == "unknown")
            .map(|test| match test["code"].as_str().unwrap_or("") {
                "self_test_provider_unavailable" => {
                    "未能启动原生 Harness，请检查其安装与登录状态。"
                }
                "self_test_model_unavailable" => {
                    "没有找到可用模型，请检查原生 Harness 的模型配置与访问权限。"
                }
                "self_test_read_only_unavailable" => "当前 Codex 环境不支持测试所需的只读模式。",
                "self_test_permission_requested" | "self_test_unexpected_tool" => {
                    "测试请求了额外权限或工具，已中止测试。请检查原生 Harness 设置。"
                }
                "self_test_answer_mismatch" => "模型响应不符合测试要求，尚不能确认测试通过。",
                "self_test_timed_out" => "等待测试结果超时，请先核对原结果。",
                "self_test_interrupted" => "测试被中断，原结果尚未确认。",
                "self_test_execution_failed" => {
                    "测试未能完成，请检查原生 Harness 的模型与网络配置。"
                }
                _ => "测试结果尚未确认，请在设置中排查原记录，不会自动重发请求。",
            });
        let configured = yes(&self.state, "configured");
        let running = yes(&self.state, "running");
        let supported = yes(&provider, "selfTestSupported");
        let (heading, guidance, action) = if self.stale {
            (
                "状态待更新",
                Some("刷新后可确认本机安装与连接状态。"),
                Some(
                    self.read_action(
                        "provider-refresh",
                        "刷新状态",
                        IconName::RefreshCw,
                        "status",
                        cx,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                ),
            )
        } else if !installed {
            let guidance = match provider["status"].as_str() {
                Some("not_found") => "请先安装并登录原生 Harness，再重新检测。",
                Some("disabled") => "本机连接配置已停用此 Harness。更新设备配置后可重新检测。",
                _ => "安装状态尚未确认，请重新检测。",
            };
            (
                "安装",
                Some(guidance),
                Some(
                    self.read_action(
                        "provider-refresh",
                        "重新检测",
                        IconName::RefreshCw,
                        "status",
                        cx,
                    )
                    .on_click(cx.listener(|this, _, _, cx| this.refresh(cx))),
                ),
            )
        } else if !configured {
            let (guidance, label) = if self.state["connectionRecovery"].is_object() {
                ("完成上次服务器接入后可测试。", "继续接入")
            } else if self.connect_unconfirmed {
                ("上次接入结果待核对，确认后可测试。", "核对接入结果")
            } else {
                ("接入服务器后可进行测试。", "接入服务器")
            };
            (
                "模型响应测试",
                Some(guidance),
                Some(
                    button("provider-next", label)
                        .on_click(cx.listener(|this, _, _, cx| this.navigate(Page::Connect, cx))),
                ),
            )
        } else if self.blocked() {
            // The page feedback already explains pending tests and running or unresolved work.
            (
                "模型响应测试",
                Some("当前任务结束或结果核对后，可发起测试。"),
                None,
            )
        } else if !running || !supported {
            let (guidance, label) = if !running {
                ("连接服务已停止，请在概览中启动后再测试。", "前往概览")
            } else {
                ("当前连接服务不支持此 Harness 的响应测试。", "查看设置")
            };
            (
                "模型响应测试",
                Some(guidance),
                (!self.attention().is_some_and(|attention| attention.warning)).then(|| {
                    button("provider-next", label).on_click(cx.listener(move |this, _, _, cx| {
                        if running {
                            this.advanced = true;
                            this.navigate(Page::Settings, cx);
                        } else {
                            this.navigate(Page::Home, cx);
                        }
                    }))
                }),
            )
        } else {
            let (label, guidance): (String, Option<&str>) =
                match latest.as_ref().and_then(|test| test["state"].as_str()) {
                    Some("failed") => ("重新测试".into(), failure),
                    Some("unknown") => (
                        "发起新测试".into(),
                        Some("原测试结果仍待核对。新测试会使用独立编号。"),
                    ),
                    _ => ("测试响应".into(), None),
                };
            let detail = if key == "dsh" {
                "将发送一条简短测试请求，会使用模型额度。测试沿用 DeepSeek Harness 的原生权限，不提供只读保证。结果不明时不会自动重发。"
            } else {
                "将发送一条简短测试请求，会使用模型额度。测试使用 Codex 的原生只读模式。结果不明时不会自动重发。"
            };
            let title = format!("测试 {name}？");
            (
                "模型响应测试",
                guidance,
                Some(
                    button("test", label)
                        .icon(IconName::Play)
                        .disabled(self.busy || self.interaction_pending)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.confirm("test", json!({}), &title, detail, window, cx);
                        })),
                ),
            )
        };
        let installation = Label::new(self.installation_label(&provider)).text_sm();
        let version = text(&provider, "version");
        let installation = if installed && !version.is_empty() {
            installation.secondary(format!("· {version}"))
        } else {
            installation
        };
        let native = &self.state["providerDetails"][key];
        let defaults = &native["defaults"];
        let model_default = native["models"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == defaults["model"]))
            .map(model_caption)
            .unwrap_or_else(|| reported_default(defaults, "model"));
        let effort_default = effort_name(&reported_default(defaults, "effort")).to_owned();
        let mode_default = permission_caption(native);
        let modes = native["permissionModes"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row["name"].as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            })
            .unwrap_or_default();
        let locations: Vec<_> = [
            ("native-binary", "程序路径", text(&provider, "executable")),
            ("native-home", "配置目录", text(&provider, "home")),
        ]
        .into_iter()
        .filter(|(_, _, value)| !value.is_empty())
        .collect();
        let show_result = latest.is_some()
            || self
                .pending
                .as_ref()
                .is_some_and(|test| test.provider == key);
        v_flex()
            .w_full()
            .max_w(px(720.))
            .flex_shrink_0()
            .gap_8()
            .child(
                v_flex()
                    .flex_shrink_0()
                    .gap_3()
                    .child(
                        h_flex()
                            .flex_shrink_0()
                            .min_h(px(48.))
                            .gap_4()
                            .child(div().size(px(48.)).flex_shrink_0().child(provider_logo(key, 48.)))
                            .child(
                                v_flex()
                                    .flex_1()
                                    .flex_shrink_0()
                                    .min_w_0()
                                    .min_h(px(48.))
                                    .justify_center()
                                    .gap_1()
                                    .child(page_title(name.clone()).flex_shrink_0())
                                    .child(installation.flex_shrink_0()),
                            )
                            .children(yes(&provider, "experimental").then(|| {
                                self.muted("实验适配", cx).text_xs().flex_shrink_0()
                            })),
                    )
                    .children((installed && !self.stale).then(|| {
                        self.muted("任务到达时由连接服务启动，无需手动打开客户端。", cx)
                    })),
            )
            .children(self.page_feedback(cx))
            .children((installed && native["state"] == "reported").then(|| {
                GroupBox::new()
                    .outline()
                    .flex_shrink_0()
                    .title(
                        h_flex()
                            .justify_between()
                            .child(section_title("原生会话配置"))
                            .child(self.muted("只读", cx).text_xs()),
                    )
                    .child(
                        DescriptionList::horizontal()
                            .columns(1)
                            .bordered(false)
                            .label_width(px(120.))
                            .child(provider_fact("模型", Label::new(model_default).text_sm()))
                            .child(provider_fact("推理强度", Label::new(effort_default).text_sm()))
                            .child(provider_fact("权限模式", Label::new(mode_default).text_sm()))
                            .children((!modes.is_empty()).then(|| provider_fact("可用权限", self.muted(modes, cx).text_xs())))
                            .children([("sandbox", "沙箱"), ("approvalPolicy", "审批策略")].into_iter().filter_map(|(id, label)| {
                                defaults["mode"].is_null().then(|| defaults[id].as_str()).flatten().map(|value| provider_fact(label, Label::new(value.to_owned()).text_sm()))
                            })),
                    )
                    .footer(
                        v_flex()
                            .gap_1()
                            .child(self.muted("未指定的任务沿用原生默认；实际执行以任务和设备配置为准。", cx).text_xs())
                            .children((defaults["mode"].is_null()).then(|| {
                                self.muted("原生接口未提供权限模式查询；需要审批时，在发起任务的应用中处理。", cx).text_xs()
                            })),
                    )
            }))
            .children(installed.then(|| self.provider_models(native, cx)))
            .children((!locations.is_empty()).then(|| {
                GroupBox::new()
                    .outline()
                    .flex_shrink_0()
                    .title(section_title("本机安装"))
                    .child(
                        DescriptionList::horizontal()
                            .columns(1)
                            .bordered(false)
                            .label_width(px(120.))
                            .children(locations.into_iter().map(|(id, label, value)| {
                                provider_fact(label, self.technical_value(id, label, value, cx))
                            })),
                    )
            }))
            .child(
                GroupBox::new()
                    .normal()
                    .flex_shrink_0()
                    .title(
                        h_flex()
                            .flex_wrap()
                            .gap_3()
                            .justify_between()
                            .child(section_title(heading).flex_shrink_0())
                            .children(action.map(|action| action.flex_shrink_0())),
                    )
                    .child(
                        v_flex()
                            .gap_2()
                            .children((installed && !self.stale).then(|| {
                                self.muted(
                                    "可选检查：发送一条简短请求，确认模型能否响应。会使用模型额度。",
                                    cx,
                                )
                            }))
                            .children(guidance.map(|message| self.muted(message, cx))),
                    )
                    .children(show_result.then(|| {
                        v_flex()
                            .gap_3()
                            .child(Separator::horizontal().h(px(1.)))
                            .child(status)
                            .children(
                                failure
                                    .filter(|message| !self.stale && Some(*message) != guidance)
                                    .map(|message| self.muted(message, cx)),
                            )
                            .children(latest.as_ref().and_then(|test| {
                                let id = text(test, "id");
                                (!id.is_empty()).then(|| {
                                    DescriptionList::horizontal()
                                        .columns(1)
                                        .bordered(false)
                                        .label_width(px(120.))
                                        .child(provider_fact("测试编号",
                                            self.technical_value("test-id", "测试编号", id, cx),
                                        ))
                                })
                            }))
                    })),
            )
            .into_any_element()
    }
}

fn reported_default(defaults: &Value, key: &str) -> String {
    defaults[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or("未获取")
        .to_owned()
}

fn model_caption(model: &Value) -> String {
    let name = model["name"]
        .as_str()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| model["id"].as_str().unwrap_or("未提供"));
    match model["provider"]
        .as_str()
        .filter(|provider| !provider.is_empty() && *provider != name)
    {
        Some(provider) => format!("{name} · {provider}"),
        None => name.to_owned(),
    }
}

fn permission_caption(native: &Value) -> String {
    let defaults = &native["defaults"];
    if let Some(mode) = defaults["mode"].as_str().filter(|mode| !mode.is_empty()) {
        return native["permissionModes"]
            .as_array()
            .and_then(|rows| rows.iter().find(|row| row["id"] == mode))
            .and_then(|row| row["name"].as_str())
            .unwrap_or(mode)
            .to_owned();
    }
    if defaults["sandbox"].is_string() || defaults["approvalPolicy"].is_string() {
        "见沙箱与审批策略".to_owned()
    } else {
        "由原生 Harness 管理".to_owned()
    }
}

fn effort_name(value: &str) -> &str {
    match value {
        "none" => "无",
        "minimal" => "最低",
        "low" => "低",
        "medium" => "中",
        "high" => "高",
        "xhigh" => "很高",
        "max" => "极高",
        "ultra" => "最高",
        _ => value,
    }
}
fn effort_summary(values: &[&str]) -> String {
    const ORDER: [&str; 8] = [
        "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
    ];
    let positions: Option<Vec<usize>> = values
        .iter()
        .map(|value| ORDER.iter().position(|known| known == value))
        .collect();
    if let Some(mut positions) = positions {
        positions.sort_unstable();
        positions.dedup();
        if positions.len() > 2 && positions.windows(2).all(|pair| pair[1] == pair[0] + 1) {
            return format!(
                "{}—{} · {} 档",
                effort_name(ORDER[positions[0]]),
                effort_name(ORDER[*positions.last().unwrap()]),
                positions.len()
            );
        }
    }
    if values.is_empty() {
        "未提供".to_owned()
    } else {
        values
            .iter()
            .map(|value| effort_name(value))
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

impl Panel {
    fn provider_models(&self, native: &Value, cx: &mut Context<Self>) -> GroupBox {
        let available = native["state"] == "reported";
        let models = native["models"].as_array().cloned().unwrap_or_default();
        let guidance = if !yes(&self.state, "configured") {
            "接入服务器并启动本机连接服务后，可读取原生模型信息。"
        } else if !yes(&self.state, "running") {
            "本机连接服务已停止。请在概览中启动后读取。"
        } else if !yes(&self.state, "providerDetailsSupported") {
            "当前连接服务版本尚不支持读取模型信息，需在设备空闲时更新后台。"
        } else if native["state"] == "unavailable" {
            "未能读取原生模型信息。请检查 Harness 的登录与网络后重新读取。"
        } else if self.blocked() && native.is_null() {
            "当前有任务或结果待核对，空闲后可读取模型信息。"
        } else {
            "尚未获取原生模型信息。读取能力信息不会发送模型请求。"
        };
        let checked = native["checkedAt"]
            .as_i64()
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|time| {
                time.with_timezone(&chrono::Local)
                    .format("%m-%d %H:%M")
                    .to_string()
            });
        let body = if available {
            v_flex()
                .gap_2()
                .child(
                    div()
                        .id("native-model-list")
                        .max_h(px(380.))
                        .overflow_y_scrollbar()
                        .child(
                            Table::new()
                                .child(
                                    TableHeader::new().child(
                                        TableRow::new()
                                            .h_8()
                                            .child(
                                                TableHead::new()
                                                    .min_w_0()
                                                    .py_1()
                                                    .text_xs()
                                                    .child("模型"),
                                            )
                                            .child(
                                                TableHead::new()
                                                    .min_w_0()
                                                    .py_1()
                                                    .text_xs()
                                                    .child("推理范围"),
                                            ),
                                    ),
                                )
                                .child(TableBody::new().children(models.iter().enumerate().map(
                                    |(index, model)| {
                                        let values = model["efforts"]
                                            .as_array()
                                            .map(|values| {
                                                values
                                                    .iter()
                                                    .filter_map(Value::as_str)
                                                    .collect::<Vec<_>>()
                                            })
                                            .unwrap_or_default();
                                        let detail = if values.is_empty() {
                                            "原生环境未提供推理选项".to_owned()
                                        } else {
                                            values
                                                .iter()
                                                .map(|value| {
                                                    format!("{} ({value})", effort_name(value))
                                                })
                                                .collect::<Vec<_>>()
                                                .join(" / ")
                                        };
                                        let name = model_caption(model);
                                        let tooltip = format!("{name}\n{detail}");
                                        TableRow::new()
                                            .h_10()
                                            .child(
                                                TableCell::new().min_w_0().py_2().child(
                                                    Label::new(name)
                                                        .text_sm()
                                                        .flex_1()
                                                        .min_w_0()
                                                        .truncate(),
                                                ),
                                            )
                                            .child(
                                                TableCell::new().min_w_0().py_2().child(
                                                    div()
                                                        .id(("model-efforts", index))
                                                        .w_full()
                                                        .tooltip(move |window, cx| {
                                                            Tooltip::new(tooltip.clone())
                                                                .build(window, cx)
                                                        })
                                                        .child(
                                                            self.muted(effort_summary(&values), cx)
                                                                .text_xs(),
                                                        ),
                                                ),
                                            )
                                    },
                                ))),
                        ),
                )
                .children(
                    models
                        .is_empty()
                        .then(|| self.muted("原生环境未提供可用模型列表。", cx)),
                )
                .children(
                    (native["modelsTruncated"] == true)
                        .then(|| self.muted("列表较长，此处仅展示部分模型。", cx).text_xs()),
                )
                .children(self.stale.then(|| {
                    self.muted("显示上次读取的信息，当前状态待更新。", cx)
                        .text_xs()
                }))
                .into_any_element()
        } else {
            self.muted(guidance, cx).into_any_element()
        };
        GroupBox::new()
            .normal()
            .flex_shrink_0()
            .title(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .child(
                        h_flex()
                            .gap_2()
                            .child(section_title(if available {
                                "可用模型"
                            } else {
                                "模型与权限"
                            }))
                            .children(
                                available
                                    .then(|| self.muted(models.len().to_string(), cx).text_xs()),
                            ),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .children(checked.map(|time| self.muted(time, cx).text_xs()))
                            .children((!available).then(|| self.muted("只读", cx).text_xs()))
                            .children(
                                (yes(&self.state, "running")
                                    && yes(&self.state, "providerDetailsSupported"))
                                .then(|| {
                                    Button::new("read-provider-details")
                                        .ghost()
                                        .small()
                                        .icon(IconName::RefreshCw)
                                        .when(native.is_null(), |button| button.label("读取信息"))
                                        .accessibility_label("重新读取模型信息")
                                        .tooltip("重新读取原生模型信息，不调用模型")
                                        .loading(self.active_operation == Some("provider-details"))
                                        .disabled(self.busy || self.stale || self.blocked())
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.request(
                                                "provider-details",
                                                json!({}),
                                                Reply::State,
                                                None,
                                                cx,
                                            )
                                        }))
                                }),
                            ),
                    ),
            )
            .child(body)
    }
}

#[cfg(test)]
mod model_presentation_tests {
    use super::{effort_summary, model_caption, permission_caption};
    use serde_json::json;
    #[test]
    fn native_model_names_do_not_display_opaque_route_values() {
        let route = r#"["provider","model"]"#;
        assert_eq!(
            model_caption(&json!({"id":route,"name":"Model","provider":"Provider"})),
            "Model · Provider"
        );
        assert_eq!(model_caption(&json!({"id":"model-id"})), "model-id");
    }
    #[test]
    fn missing_native_modes_do_not_imply_a_failed_read_or_a_fabricated_mode() {
        assert_eq!(
            permission_caption(&json!({"defaults":{"mode":null},"permissionModes":[]})),
            "由原生 Harness 管理"
        );
        assert_eq!(
            permission_caption(
                &json!({"defaults":{"mode":"read-only"},"permissionModes":[{"id":"read-only","name":"Read-only"}]})
            ),
            "Read-only"
        );
        assert_eq!(
            permission_caption(&json!({"defaults":{"mode":null,"sandbox":"read-only"}})),
            "见沙箱与审批策略"
        );
    }
    #[test]
    fn inference_ranges_never_invent_missing_choices() {
        assert_eq!(
            effort_summary(&["low", "medium", "high", "xhigh", "max", "ultra"]),
            "低—最高 · 6 档"
        );
        assert_eq!(effort_summary(&["low", "high", "ultra"]), "低 · 高 · 最高");
        assert_eq!(effort_summary(&["custom"]), "custom");
        assert_eq!(effort_summary(&[]), "未提供");
    }
}
