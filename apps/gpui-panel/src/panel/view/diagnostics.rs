use super::*;
use crate::panel::diagnostics::{DiagnosticOutcome, diagnostic_copy, diagnostic_outcome};
use gpui_kit::component::accordion::Accordion;

impl Panel {
    pub(super) fn diagnostic_results(&self, cx: &mut Context<Self>) -> Div {
        let outcome = diagnostic_outcome(&self.checks);
        let summary = match outcome {
            DiagnosticOutcome::Connected => Alert::success("diagnostic-summary", "连接正常"),
            DiagnosticOutcome::NeedsAttention(count) => Alert::warning(
                "diagnostic-summary",
                format!("发现 {count} 项需要处理的问题"),
            ),
            DiagnosticOutcome::Incomplete => {
                Alert::info("diagnostic-summary", "部分检查未完成，暂不能确认连接状态")
            }
        }
        .small();
        let installed: Vec<_> = self
            .checks
            .iter()
            .filter_map(|check| {
                if check["state"] != "pass" {
                    return None;
                }
                match check["check"].as_str() {
                    Some("codex_installation") => Some("Codex"),
                    Some("dsh_installation") => Some("DeepSeek Harness"),
                    _ => None,
                }
            })
            .collect();
        let failures = self.checks.iter().filter_map(|check| {
            if check["state"] != "fail" {
                return None;
            }
            diagnostic_copy(check["check"].as_str().unwrap_or_default())
        });
        let details = self.diagnostic_details.then(|| {
            DescriptionList::horizontal()
                .columns(1)
                .label_width(px(180.))
                .bordered(false)
                .children(self.checks.iter().map(|check| {
                    let key = check["check"].as_str().unwrap_or_default();
                    let copy = diagnostic_copy(key);
                    let label = copy.as_ref().map(|copy| copy.label).unwrap_or("其他检查项");
                    let value = if let Some(copy) = &copy {
                        match check["state"].as_str() {
                            Some("pass") => copy.passed,
                            Some("fail") => "需要处理",
                            _ if key == "native_auth_and_protocol" => "本次未测试",
                            _ if key == "server_health" => "未获得独立检测结果",
                            _ => "未获得结果",
                        }
                    } else {
                        "当前界面无法解释此项，请查看日志"
                    };
                    DescriptionItem::new(label).value(
                        v_flex()
                            .gap_1()
                            .child(Label::new(value).text_sm())
                            .children((check["state"] != "pass").then(|| {
                                self.muted(
                                    copy.as_ref()
                                        .map(|copy| copy.advice)
                                        .unwrap_or("此项未参与连接结论。"),
                                    cx,
                                )
                                .text_xs()
                            }))
                            .into_any_element(),
                    )
                }))
        });
        v_flex()
            .gap_3()
            .child(summary)
            .children(
                (outcome == DiagnosticOutcome::Connected)
                    .then(|| self.muted("本机后台正在运行，服务器已接受这台设备的连接。", cx)),
            )
            .children((!installed.is_empty()).then(|| {
                self.muted(format!("已检测到安装：{}。", installed.join("、")), cx)
                    .text_xs()
            }))
            .children(
                matches!(outcome, DiagnosticOutcome::NeedsAttention(_)).then(|| {
                    DescriptionList::vertical()
                        .columns(1)
                        .bordered(false)
                        .children(failures.map(|copy| {
                            DescriptionItem::new(copy.label)
                                .value(Label::new(copy.advice).text_sm().into_any_element())
                        }))
                }),
            )
            .child(
                self.muted("这是本次手动检查的结果，不包含模型响应测试。", cx)
                    .text_xs(),
            )
            .child(
                Accordion::new("diagnostic-details")
                    .bordered(false)
                    .small()
                    .h_auto()
                    .item(|item| {
                        item.title("查看检查明细")
                            .title_style(div().px_0().py_2().style().clone())
                            .content_style(div().px_0().pb_0().style().clone())
                            .open(self.diagnostic_details)
                            .children(details)
                    })
                    .on_toggle_click(cx.listener(|this, open: &[usize], _, cx| {
                        this.diagnostic_details = open.contains(&0);
                        cx.notify();
                    })),
            )
    }
}
