use super::*;
#[cfg(not(target_os = "macos"))]
use crate::panel::ui::{
    TRAY_ROW_CHEVRON_SIZE, TRAY_ROW_HEIGHT, TRAY_ROW_ICON_SIZE, navigation_row,
};
#[cfg(not(target_os = "macos"))]
use gpui_kit::component::{
    IndexPath,
    list::{List, ListDelegate, ListItem, ListState},
    separator::Separator,
};

#[cfg(not(target_os = "macos"))]
const HOME_HARNESS_ROW_HEIGHT: f32 = 56.;
const HOME_ICON_SLOT_SIZE: f32 = 36.;

pub(super) fn overview_connection_row(cx: &App) -> Div {
    // Match the horizontal inset and icon column of the Kit ListItem below.
    h_flex().px_3().py_3().gap_3().child(icon_slot(
        HOME_ICON_SLOT_SIZE,
        glyph(IconName::Server, 20.).text_color(cx.theme().muted_foreground),
    ))
}

#[cfg(not(target_os = "macos"))]
#[derive(Clone, PartialEq, Eq)]
pub(in crate::panel) struct HarnessRow {
    key: String,
    name: String,
    detail: String,
    status: &'static str,
    experimental: bool,
}

#[cfg(not(target_os = "macos"))]
type OpenHarness = Box<dyn Fn(String, &mut Window, &mut App)>;

#[cfg(not(target_os = "macos"))]
struct HarnessList {
    rows: Vec<HarnessRow>,
    compact: bool,
    selected: Option<IndexPath>,
    on_open: OpenHarness,
}

#[cfg(not(target_os = "macos"))]
impl ListDelegate for HarnessList {
    type Item = ListItem;

    fn items_count(&self, _: usize, _: &App) -> usize {
        self.rows.len()
    }

    fn render_item(
        &mut self,
        index: IndexPath,
        _: &mut Window,
        cx: &mut Context<ListState<Self>>,
    ) -> Option<ListItem> {
        let row = self.rows.get(index.row)?;
        let muted = cx.theme().muted_foreground;
        let name = div()
            .text_sm()
            .font_weight(FontWeight::MEDIUM)
            .truncate()
            .child(row.name.clone());
        let label = || div().text_xs().text_color(muted);
        let content = if self.compact {
            h_flex().flex_1().min_w_0().gap_1().child(name).children(
                row.experimental
                    .then(|| label().flex_shrink_0().child("实验")),
            )
        } else {
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(px(2.))
                .child(name.line_height(px(18.)))
                .child(
                    label()
                        .line_height(px(16.))
                        .truncate()
                        .child(row.detail.clone()),
                )
        };
        let (logo, height, chevron) = if self.compact {
            (
                provider_mark(&row.key, TRAY_ROW_ICON_SIZE),
                TRAY_ROW_HEIGHT,
                TRAY_ROW_CHEVRON_SIZE,
            )
        } else {
            (
                provider_logo(&row.key, HOME_ICON_SLOT_SIZE),
                HOME_HARNESS_ROW_HEIGHT,
                14.,
            )
        };

        Some(
            navigation_row(
                SharedString::from(format!("provider-{}", row.key)),
                format!("{}，{}，查看详情", row.name, row.status),
                logo,
                h_flex().gap_3().child(content).children(
                    (row.status != "已安装").then(|| label().flex_shrink_0().child(row.status)),
                ),
                chevron,
                cx,
            )
            .h(px(height))
            .when(!self.compact && index.row > 0, |item| {
                item.suffix(|_, _| {
                    Separator::horizontal()
                        .absolute()
                        .top_0()
                        .left(px(HOME_ICON_SLOT_SIZE + 24.))
                        .right_3()
                        .h(px(1.))
                })
            }),
        )
    }

    fn set_selected_index(
        &mut self,
        index: Option<IndexPath>,
        _: &mut Window,
        _: &mut Context<ListState<Self>>,
    ) {
        self.selected = index;
    }

    fn confirm(&mut self, _: bool, window: &mut Window, cx: &mut Context<ListState<Self>>) {
        if let Some(row) = self.selected.and_then(|index| self.rows.get(index.row)) {
            (self.on_open)(row.key.clone(), window, cx);
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub(in crate::panel) fn harness_list(
    rows: Vec<HarnessRow>,
    compact: bool,
    window: &mut Window,
    cx: &mut App,
    on_open: impl Fn(String, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let id = if compact {
        "tray-harness-list"
    } else {
        "home-harness-list"
    };
    let state = window.use_keyed_state(id, cx, |window, cx| {
        let list = ListState::new(
            HarnessList {
                rows: rows.clone(),
                compact,
                selected: None,
                on_open: Box::new(on_open),
            },
            window,
            cx,
        );
        list.focus_handle(cx).tab_stop(true);
        list
    });

    let height = px(HOME_HARNESS_ROW_HEIGHT * rows.len() as f32);
    if state.read(cx).delegate().rows != rows {
        state.update(cx, |state, cx| {
            let previous = &state.delegate().rows;
            let selected = state
                .selected_index()
                .and_then(|index| previous.get(index.row))
                .and_then(|row| rows.iter().position(|other| other.key == row.key))
                .map(IndexPath::new);
            state.delegate_mut().rows = rows;
            state.set_selected_index(selected, window, cx);
            cx.notify();
        });
    }

    List::new(&state)
        .min_h_0()
        .when(!compact, |list| list.h(height).scrollbar_visible(false))
        .into_any_element()
}

impl Panel {
    #[cfg(not(target_os = "macos"))]
    pub(in crate::panel) fn harness_summary(&self) -> String {
        let providers = self.state["providers"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        if providers.is_empty() {
            return if self.busy {
                "读取中"
            } else {
                "检测待确认"
            }
            .into();
        }
        let installed = providers
            .iter()
            .filter(|p| p["status"] == "installed")
            .count();
        let incomplete = providers.iter().any(|p| {
            !matches!(
                p["status"].as_str(),
                Some("installed" | "disabled" | "not_found")
            )
        });
        if self.stale {
            format!("上次检测 · {installed} 个已安装")
        } else if incomplete {
            "检测未完成".into()
        } else {
            format!("{installed} 个已安装")
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub(in crate::panel) fn harness_rows(&self) -> Vec<HarnessRow> {
        self.state["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|provider| {
                let key = text(provider, "key");
                let experimental = yes(provider, "experimental");
                let detail = match provider["status"].as_str() {
                    Some("installed") => {
                        let version = text(provider, "version");
                        let mut facts = Vec::new();
                        if !version.is_empty() {
                            facts.push(version);
                        }
                        if !self.stale
                            && (self
                                .tests()
                                .iter()
                                .any(|t| t["provider"].as_str().unwrap_or("codex") == key)
                                || self.pending.as_ref().is_some_and(|p| p.provider == key))
                        {
                            facts.push(self.test_label(&key));
                        }
                        if experimental {
                            facts.push("实验适配".into());
                        }
                        facts.join(" · ")
                    }
                    Some("disabled") => "可在详情查看原因".into(),
                    Some("not_found") => "安装并登录后可重新检测".into(),
                    _ => "刷新以确认本机安装状态".into(),
                };
                HarnessRow {
                    key,
                    name: provider_name(provider),
                    detail,
                    status: self.installation_label(provider),
                    experimental,
                }
            })
            .collect()
    }

    pub(super) fn home(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !yes(&self.state, "configured") {
            return self.connect_page(cx);
        }
        self.dashboard(window, cx)
    }
}
