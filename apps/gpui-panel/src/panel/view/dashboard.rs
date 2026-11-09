use super::*;
use chrono::{DateTime, Local};
use gpui_kit::component::{
    separator::Separator,
    table::{Table, TableBody, TableCell, TableHead, TableHeader, TableRow},
};

fn rows(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn harness(key: &str) -> String {
    match key {
        "codex" => "Codex".into(),
        "dsh" => "DeepSeek Harness".into(),
        _ => key.into(),
    }
}
fn short_id(id: &str) -> String {
    if id.chars().count() <= 16 {
        format!("#{id}")
    } else {
        format!(
            "#{}…{}",
            id.chars().take(6).collect::<String>(),
            id.chars()
                .rev()
                .take(4)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        )
    }
}
fn timestamp(value: &Value) -> String {
    value
        .as_i64()
        .and_then(DateTime::from_timestamp_millis)
        .map(|time| {
            time.with_timezone(&Local)
                .format("%m-%d %H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}
fn elapsed(value: &Value) -> String {
    match value.as_u64() {
        Some(ms) if ms >= 3_600_000 => format!("{} 时 {} 分", ms / 3_600_000, ms / 60_000 % 60),
        Some(ms) if ms >= 60_000 => format!("{} 分 {} 秒", ms / 60_000, ms / 1000 % 60),
        Some(ms) => format!("{} 秒", ms / 1000),
        None => "—".into(),
    }
}
fn tokens(value: &Value) -> String {
    match value.as_u64() {
        Some(n) if n >= 1_000_000 => format!("{:.1} M", n as f64 / 1_000_000.),
        Some(n) if n >= 1000 => format!("{:.1} K", n as f64 / 1000.),
        Some(n) => n.to_string(),
        None => "—".into(),
    }
}
fn execution_label(row: &Value) -> &'static str {
    match row["state"].as_str() {
        Some("running") => "执行中",
        Some("completed") => "已完成",
        Some("failed") => "失败",
        Some("cancelled") => "已取消",
        _ => "待确认",
    }
}
fn matches_filter(row: &Value, filter: usize) -> bool {
    match filter {
        1 => row["state"] == "running",
        2 => !matches!(
            row["state"].as_str(),
            Some("running" | "completed" | "failed" | "cancelled")
        ),
        3 => matches!(
            row["state"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ),
        _ => true,
    }
}
fn head(label: &str, width: f32) -> TableHead {
    TableHead::new()
        .min_w_0()
        .w(px(width))
        .child(label.to_owned())
}
fn cell(width: f32) -> TableCell {
    TableCell::new().min_w_0().w(px(width))
}

// One Kit button composition for contextual navigation: leading identity, trailing affordance.
fn action_row(
    id: &'static str,
    label: &'static str,
    icon: Option<IconName>,
    trailing: IconName,
) -> Button {
    Button::new(id)
        .ghost()
        .w_full()
        .min_w_0()
        .h_9()
        .px_0()
        .accessibility_label(label)
        .when_some(icon, |this, icon| this.icon(icon))
        .child(
            h_flex()
                .flex_1()
                .min_w_0()
                .gap_2()
                .child(
                    Label::new(label)
                        .text_sm()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_left(),
                )
                .child(glyph(trailing, 14.)),
        )
}

impl Panel {
    fn overview_snapshot(&self) -> Value {
        let mut overview = self.state["overview"].clone();
        if self.stale {
            if let Some(records) = overview["executions"].as_array_mut() {
                for row in records {
                    if row["state"] == "running" {
                        row["state"] = json!("unknown");
                    }
                }
            }
            if overview.is_object() {
                let running = overview["counts"]["running"].as_u64().unwrap_or(0);
                let unknown = overview["counts"]["unknown"].as_u64().unwrap_or(0);
                overview["counts"]["running"] = json!(0);
                overview["counts"]["unknown"] = json!(unknown + running);
                overview["source"] = json!("persisted");
            }
        }
        overview
    }

    pub(super) fn dashboard_footer(&self, cx: &App) -> Div {
        let workdir = text(&self.state, "cwd");
        let subtitle = if workdir.is_empty() {
            "接入时选择".to_owned()
        } else {
            workdir
        };
        h_flex()
            .h(px(44.))
            .flex_shrink_0()
            .border_t_1()
            .border_color(cx.theme().border)
            .child(
                h_flex()
                    .w(px(metrics::SIDEBAR_WIDTH))
                    .h_full()
                    .px_5()
                    .gap_2()
                    .border_r_1()
                    .border_color(cx.theme().border)
                    .child(glyph(IconName::Monitor, 14.).text_color(cx.theme().muted_foreground))
                    .child(
                        self.muted(format!("{} · {}", match std::env::consts::OS {
                            "macos" => "macOS",
                            "windows" => "Windows",
                            other => other,
                        }, std::env::consts::ARCH), cx)
                            .text_xs(),
                    ),
            )
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .px(px(metrics::PAGE_PADDING))
                    .gap_2()
                    .bg(cx.theme().background)
                    .child(glyph(IconName::Folder, 14.).text_color(cx.theme().muted_foreground))
                    .child(
                        self.muted(format!("执行目录  {subtitle}"), cx)
                            .text_xs()
                            .truncate(),
                    ),
            )
    }
    fn execution_status(&self, row: &Value, cx: &App) -> Div {
        let (icon, color) = match row["state"].as_str() {
            Some("running") => (IconName::Loader, cx.theme().primary),
            Some("completed") => (IconName::Check, cx.theme().muted_foreground),
            Some("failed") => (IconName::CircleAlert, cx.theme().warning),
            Some("cancelled") => (IconName::CircleX, cx.theme().muted_foreground),
            _ => (IconName::CircleAlert, cx.theme().warning),
        };
        h_flex()
            .gap_1p5()
            .text_color(color)
            .child(glyph(icon, 14.))
            .child(Label::new(execution_label(row)).text_xs())
    }
    fn execution_table(&self, filtered: &[&Value], cx: &mut Context<Self>) -> Table {
        Table::new()
            .small()
            .w_full()
            .accessibility_label("本机执行记录")
            .child(
                TableHeader::new().child(
                    TableRow::new()
                        .child(
                            TableHead::new()
                                .flex_1()
                                .min_w(px(190.))
                                .child("执行 / 模型"),
                        )
                        .child(head("状态", 82.))
                        .child(head("开始时间", 106.))
                        .child(head("耗时", 84.).text_right()),
                ),
            )
            .child(
                TableBody::new().children(filtered.iter().take(self.execution_limit).map(|row| {
                    let provider = text(row, "provider");
                    let id = text(row, "runId");
                    let target = id.clone();
                    let model = text(row, "model");
                    TableRow::new()
                        .child(
                            TableCell::new().flex_1().min_w(px(190.)).py_3().child(
                                h_flex().gap_2().child(provider_logo(&provider, 24.)).child(
                                    v_flex()
                                        .min_w_0()
                                        .gap(px(2.))
                                        .child(Label::new(harness(&provider)).text_sm())
                                        .child(
                                            h_flex()
                                                .gap_1()
                                                .child(
                                                    button(
                                                        SharedString::from(format!("run-{id}")),
                                                        short_id(&id),
                                                    )
                                                    .link()
                                                    .xsmall()
                                                    .on_click(cx.listener(move |this, _, _, cx| {
                                                        this.navigate(
                                                            Page::Execution(target.clone()),
                                                            cx,
                                                        )
                                                    })),
                                                )
                                                .children((!model.is_empty()).then(|| {
                                                    self.muted(format!("· {model}"), cx)
                                                        .text_xs()
                                                        .truncate()
                                                })),
                                        ),
                                ),
                            ),
                        )
                        .child(cell(82.).child(self.execution_status(row, cx)))
                        .child(
                            cell(106.)
                                .child(self.muted(timestamp(&row["startedAt"]), cx).text_xs()),
                        )
                        .child(
                            cell(84.).text_right().child(
                                v_flex()
                                    .gap_1()
                                    .items_end()
                                    .child(Label::new(elapsed(&row["elapsedMs"])).text_xs())
                                    .children(
                                        (row["state"] == "unknown")
                                            .then(|| self.muted("最后已知", cx).text_xs()),
                                    ),
                            ),
                        )
                })),
            )
    }
    fn execution_records(&self, cx: &mut Context<Self>) -> Div {
        let snapshot = self.overview_snapshot();
        let overview = &snapshot;
        let available = overview.is_object();
        let records = rows(&overview["executions"]);
        let filtered: Vec<_> = records
            .iter()
            .filter(|row| matches_filter(row, self.execution_filter))
            .collect();
        let counts = &overview["counts"];
        let unknown = counts["unknown"].as_u64().unwrap_or(0);
        let capacity = overview["maxConcurrentExecutions"].as_u64();
        let running = counts["running"].as_u64().unwrap_or(0);
        let filters = ButtonGroup::new("execution-filters")
            .outline()
            .small()
            .children(
                [
                    ("全部", "total"),
                    ("执行中", "running"),
                    ("待确认", "unknown"),
                    ("已结束", "ended"),
                ]
                .iter()
                .enumerate()
                .map(|(i, (label, key))| {
                    button(
                        ("execution-filter", i),
                        format!("{label} {}", counts[*key].as_u64().unwrap_or(0)),
                    )
                    .selected(self.execution_filter == i)
                }),
            )
            .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                if let Some(i) = selected.first() {
                    this.execution_filter = *i;
                    this.execution_limit = 10;
                    cx.notify();
                }
            }));
        v_flex()
            .min_w_0()
            .gap_4()
            .child(
                h_flex()
                    .justify_between()
                    .gap_3()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(section_title("执行记录"))
                            .child(self.muted("近 24 小时开始及尚未结束的执行", cx).text_xs()),
                    )
                    .children(
                        capacity
                            .filter(|_| !self.stale)
                            .map(|max| self.muted(format!("{running} / {max} 并发"), cx).text_xs()),
                    ),
            )
            .children(available.then_some(filters))
            .children((available && overview["source"] == "persisted").then(|| {
                Alert::info(
                    "persisted-executions",
                    "当前显示本机保存的记录；未确认结束的执行仍保留为待确认。",
                )
                .small()
            }))
            .children((unknown > 0).then(|| {
                Alert::warning(
                    "unknown-executions",
                    format!(
                        "{unknown} 项执行缺少结束证据。请在发起任务的应用中核对，不计为已结束。"
                    ),
                )
                .small()
            }))
            .child(if !available {
                surface()
                    .child(self.muted("当前后台版本尚未提供执行记录，更新连接服务后可查看。", cx))
                    .into_any_element()
            } else if filtered.is_empty() {
                surface()
                    .child(
                        v_flex()
                            .py_6()
                            .gap_2()
                            .child(section_title(if self.execution_filter == 0 {
                                "还没有执行记录"
                            } else {
                                if overview["truncated"] == true {
                                    "当前快照中没有此分类的记录"
                                } else {
                                    "此分类暂无记录"
                                }
                            }))
                            .child(
                                self.muted(
                                    if self.execution_filter == 0 {
                                        "远端任务通过这台电脑执行后，会显示在这里。"
                                    } else {
                                        "可切换其他分类查看。"
                                    },
                                    cx,
                                )
                                .text_xs(),
                            ),
                    )
                    .into_any_element()
            } else {
                self.execution_table(&filtered, cx).into_any_element()
            })
            .children((filtered.len() > self.execution_limit).then(|| {
                button("more-executions", "显示更多")
                    .self_start()
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.execution_limit += 10;
                        cx.notify();
                    }))
            }))
            .children((overview["truncated"] == true).then(|| {
                self.muted(
                    "当前快照最多展示 50 条，优先保留未结束执行；分类数量按全部记录统计。",
                    cx,
                )
                .text_xs()
            }))
            .children(available.then(|| {
                self.muted(
                    "每行对应一次执行。审批与业务结果在发起任务的应用中处理。",
                    cx,
                )
                .text_xs()
            }))
    }
    fn usage_summary(&self, cx: &mut Context<Self>) -> GroupBox {
        let usage = rows(&self.state["overview"]["usage"]);
        let available = self.state["overview"].is_object();
        surface()
            .child(
                h_flex()
                    .justify_between()
                    .child(section_title("Token 用量"))
                    .child(self.muted("近 24 小时", cx).text_xs()),
            )
            .children(usage.iter().take(4).map(|row| {
                h_flex()
                    .gap_2()
                    .py_1()
                    .child(provider_logo(&text(row, "provider"), 20.))
                    .child(
                        Label::new(harness(&text(row, "provider")))
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_xs(),
                    )
                    .child(
                        Label::new(if row["totalTokens"].is_number() {
                            format!(
                                "{}{}",
                                tokens(&row["totalTokens"]),
                                if row["reportedExecutions"].as_u64().unwrap_or(0)
                                    < row["executions"].as_u64().unwrap_or(0)
                                {
                                    " · 部分"
                                } else {
                                    ""
                                }
                            )
                        } else if row["executions"] == 0 {
                            "暂无执行".into()
                        } else {
                            "未上报".into()
                        })
                        .text_xs(),
                    )
            }))
            .children(usage.is_empty().then(|| {
                self.muted(
                    if available {
                        "暂无已上报用量"
                    } else {
                        "当前服务未提供用量数据"
                    },
                    cx,
                )
                .text_xs()
            }))
            .children((usage.len() > 4).then(|| {
                self.muted(format!("另有 {} 个 Harness", usage.len() - 4), cx)
                    .text_xs()
            }))
            .child(
                self.muted("按近 24 小时开始的执行统计；用量随执行结果上报后更新。", cx)
                    .text_xs(),
            )
            .child(Separator::horizontal())
            .child(
                action_row(
                    "usage-details",
                    "查看用量明细",
                    None,
                    IconName::ChevronRight,
                )
                .disabled(!available || self.interaction_pending)
                .on_click(cx.listener(|this, _, _, cx| this.navigate(Page::Usage, cx))),
            )
    }
    fn connection_tools(&self, cx: &mut Context<Self>) -> Div {
        v_flex()
            .gap_3()
            .child(section_title("连接工具"))
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        action_row(
                            "overview-doctor",
                            "检查连接",
                            Some(IconName::Activity),
                            IconName::ChevronRight,
                        )
                        .loading(self.active_operation == Some("doctor"))
                        .disabled(self.busy)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.request("doctor", json!({}), Reply::Checks, None, cx)
                        })),
                    )
                    .child(
                        self.muted("检查网络和环境，不调用模型。", cx)
                            .text_xs()
                            .pl_6(),
                    ),
            )
            .child(
                action_row(
                    "overview-log-location",
                    "日志位置",
                    Some(IconName::FolderOpen),
                    IconName::ArrowUpRight,
                )
                .loading(self.active_operation == Some("log-location"))
                .disabled(self.busy)
                .tooltip("在访达中显示日志")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.request("log-location", json!({}), Reply::LogLocation, None, cx)
                })),
            )
    }
    pub(super) fn dashboard(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let wide = window.viewport_size().width >= px(1040.);
        let content = if wide {
            h_flex()
                .items_start()
                .gap_6()
                .child(self.execution_records(cx).flex_1())
                .child(
                    v_flex()
                        .w(px(230.))
                        .flex_shrink_0()
                        .gap_6()
                        .child(self.usage_summary(cx))
                        .child(self.connection_tools(cx)),
                )
                .into_any_element()
        } else {
            v_flex()
                .gap_6()
                .child(self.execution_records(cx))
                .child(self.usage_summary(cx))
                .child(self.connection_tools(cx))
                .into_any_element()
        };
        v_flex()
            .gap_6()
            .children(self.page_feedback(cx))
            .children(
                (!self.stale && yes(&self.state, "running") && !self.server_online()).then(|| {
                    Alert::warning(
                        "server-reconnecting",
                        "正在重新连接服务器。连接中断不代表本机执行结束，也不会重新派发任务。",
                    )
                    .small()
                }),
            )
            .child(self.connected_summary(cx))
            .children((!self.checks.is_empty()).then(|| {
                surface()
                    .title(
                        h_flex()
                            .w_full()
                            .justify_between()
                            .gap_3()
                            .child(section_title("连接诊断"))
                            .child(
                                h_flex()
                                    .gap_2()
                                    .children(self.checked_at.as_ref().map(|time| {
                                        self.muted(format!("检查于 {time}"), cx).text_xs()
                                    }))
                                    .child(
                                        Button::new("dismiss-diagnostics")
                                            .icon(IconName::X)
                                            .ghost()
                                            .xsmall()
                                            .tooltip("收起诊断结果")
                                            .accessibility_label("收起诊断结果")
                                            .on_click(cx.listener(|this, _, _, cx| {
                                                this.checks.clear();
                                                this.checked_at = None;
                                                this.diagnostic_details = false;
                                                cx.notify();
                                            })),
                                    ),
                            ),
                    )
                    .child(self.diagnostic_results(cx))
            }))
            .child(content)
            .into_any_element()
    }
    pub(super) fn usage_page(&self, cx: &mut Context<Self>) -> AnyElement {
        let usage = rows(&self.state["overview"]["usage"]);
        v_flex()
            .gap_5()
            .child(
                v_flex()
                    .gap_1()
                    .child(page_title("Token 用量"))
                    .child(self.muted("近 24 小时开始的执行 · 仅统计本机 Dock 已收到的用量。", cx)),
            )
            .child(
                Table::new()
                    .small()
                    .w_full()
                    .accessibility_label("各 Harness 用量明细")
                    .child(
                        TableHeader::new().child(
                            TableRow::new()
                                .child(TableHead::new().flex_1().min_w(px(150.)).child("Harness"))
                                .child(head("输入", 76.).text_right())
                                .child(head("其中缓存", 86.).text_right())
                                .child(head("输出", 76.).text_right())
                                .child(head("合计", 76.).text_right()),
                        ),
                    )
                    .child(TableBody::new().children(usage.iter().map(|row| {
                        TableRow::new()
                            .child(
                                TableCell::new().flex_1().min_w(px(150.)).py_4().child(
                                    h_flex()
                                        .gap_2()
                                        .child(provider_logo(&text(row, "provider"), 24.))
                                        .child(
                                            v_flex()
                                                .flex_1()
                                                .min_w_0()
                                                .gap_1()
                                                .child(
                                                    Label::new(harness(&text(row, "provider")))
                                                        .truncate(),
                                                )
                                                .child(
                                                    self.muted(
                                                        format!(
                                                            "{} / {} 次执行已上报",
                                                            row["reportedExecutions"]
                                                                .as_u64()
                                                                .unwrap_or(0),
                                                            row["executions"].as_u64().unwrap_or(0)
                                                        ),
                                                        cx,
                                                    )
                                                    .text_xs(),
                                                ),
                                        ),
                                ),
                            )
                            .child(cell(76.).text_right().child(tokens(&row["inputTokens"])))
                            .child(
                                cell(86.)
                                    .text_right()
                                    .child(tokens(&row["cachedInputTokens"])),
                            )
                            .child(cell(76.).text_right().child(tokens(&row["outputTokens"])))
                            .child(cell(76.).text_right().child(tokens(&row["totalTokens"])))
                    }))),
            )
            .children(usage.is_empty().then(|| self.muted("暂无用量数据。", cx)))
            .child(
                self.muted(
                    "缓存输入包含在输入中，不重复计入合计。— 表示未上报，不能视为 0。",
                    cx,
                )
                .text_xs(),
            )
            .into_any_element()
    }
    pub(super) fn execution_page(&self, id: &str, cx: &mut Context<Self>) -> AnyElement {
        let snapshot = self.overview_snapshot();
        let row = rows(&snapshot["executions"])
            .iter()
            .find(|row| row["runId"] == id);
        let Some(row) = row else {
            return v_flex()
                .gap_3()
                .child(page_title("执行详情"))
                .child(self.muted("此执行已超出当前记录范围，请在发起任务的应用中查看。", cx))
                .into_any_element();
        };
        v_flex()
            .gap_5()
            .max_w(px(680.))
            .child(
                h_flex()
                    .gap_3()
                    .child(provider_logo(&text(row, "provider"), 36.))
                    .child(
                        v_flex()
                            .gap_1()
                            .child(page_title(harness(&text(row, "provider"))))
                            .child(self.execution_status(row, cx)),
                    ),
            )
            .child(
                surface().child(
                    DescriptionList::horizontal()
                        .columns(1)
                        .bordered(false)
                        .child(DescriptionItem::new("执行编号").value(self.technical_value(
                            "execution-id",
                            "执行编号",
                            id.into(),
                            cx,
                        )))
                        .child(
                            DescriptionItem::new("模型").value(
                                if text(row, "model").is_empty() {
                                    "未上报".into()
                                } else {
                                    text(row, "model")
                                }
                                .into_any_element(),
                            ),
                        )
                        .child(
                            DescriptionItem::new("开始时间")
                                .value(timestamp(&row["startedAt"]).into_any_element()),
                        )
                        .child(
                            DescriptionItem::new("结束时间")
                                .value(timestamp(&row["endedAt"]).into_any_element()),
                        )
                        .child(
                            DescriptionItem::new(if row["state"] == "unknown" {
                                "最后已知耗时"
                            } else {
                                "耗时"
                            })
                            .value(elapsed(&row["elapsedMs"]).into_any_element()),
                        ),
                ),
            )
            .child(self.muted(
                "这是本机执行记录。任务内容、原生审批与业务结果请在发起任务的应用中查看。",
                cx,
            ))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::{elapsed, matches_filter, tokens};
    use serde_json::{Value, json};
    #[test]
    fn unknown_never_appears_as_ended() {
        for state in ["unknown", "missing", ""] {
            let row = json!({"state":state});
            assert!(matches_filter(&row, 2));
            assert!(!matches_filter(&row, 3));
        }
        for state in ["completed", "failed", "cancelled"] {
            assert!(matches_filter(&json!({"state":state}), 3));
        }
    }
    #[test]
    fn missing_usage_is_not_zero() {
        assert_eq!(tokens(&Value::Null), "—");
        assert_eq!(tokens(&json!(0)), "0");
    }
    #[test]
    fn duration_is_elapsed_not_a_completion_claim() {
        assert_eq!(elapsed(&Value::Null), "—");
        assert_eq!(elapsed(&json!(134000)), "2 分 14 秒");
    }
}
