use super::ui::{
    TRAY_ROW_CHEVRON_SIZE, TRAY_ROW_HEIGHT, TRAY_ROW_ICON_SIZE, button, navigation_row,
    section_title,
};
use super::view::home::harness_list;
use super::{Page, Panel, text, yes};
use crate::theme::{Appearance, metrics};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable,
    alert::Alert,
    button::{Button, ButtonVariants},
    h_flex,
    label::Label,
    separator::Separator,
    v_flex,
};
use gpui_kit::*;
use std::{cell::Cell, rc::Rc, time::Instant};

actions!(dock_tray, [DismissTray]);

const TRAY_WIDTH: f32 = 320.;
const TRAY_PADDING_Y: f32 = 8.;
const TRAY_GAP: f32 = 8.;
const CONNECTION_HEIGHT: f32 = 40.;
const ATTENTION_HEIGHT: f32 = 68.;
const SEPARATOR_HEIGHT: f32 = 1.;
const SECTION_HEIGHT: f32 = 20.;
const SECTION_GAP: f32 = 6.;

/// A second view of the existing owner model; it never starts its own helper or execution.
pub struct TrayPanel {
    panel: Entity<Panel>,
    main: AnyWindowHandle,
    focus: FocusHandle,
    dismissed: Rc<Cell<Option<Instant>>>,
}

impl TrayPanel {
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dismissed.set(Some(Instant::now()));
        self.panel.update(cx, |panel, cx| {
            panel.tray_visible = false;
            cx.notify();
        });
        window.remove_window();
    }

    fn open(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        // Remove the transient surface before navigating or focusing the main
        // window, including when discovery starts a new asynchronous read.
        self.dismiss(window, cx);
        self.panel.update(cx, |panel, cx| {
            panel.visible = true;
            panel.navigate(page, cx);
        });
        let _ = self.main.update(cx, |_, window, cx| {
            crate::activate_main_window(window, cx);
        });
    }
}

pub fn open(
    panel: Entity<Panel>,
    main: AnyWindowHandle,
    rect: tray_icon::Rect,
    dismissed: Rc<Cell<Option<Instant>>>,
    cx: &mut App,
) -> Result<AnyWindowHandle> {
    let scale = main
        .update(cx, |_, window, _| window.scale_factor())
        .unwrap_or(1.);
    let anchor = point(
        px(rect.position.x as f32 / scale),
        px(rect.position.y as f32 / scale),
    );
    let display = cx
        .displays()
        .into_iter()
        .find(|d| d.bounds().contains(&anchor))
        .or_else(|| cx.primary_display());
    let count = panel.read(cx).state["providers"]
        .as_array()
        .map_or(0, Vec::len);
    let mut dimensions = size(
        px(TRAY_WIDTH),
        content_height(count, panel.read(cx).attention().is_some()),
    );
    let mut origin = point(
        anchor.x + px(rect.size.width as f32 / scale) / 2. - dimensions.width / 2.,
        anchor.y + px(rect.size.height as f32 / scale) + px(6.),
    );
    if let Some(display) = &display {
        let bounds = display.visible_bounds();
        dimensions.height = dimensions.height.min(bounds.size.height - px(12.));
        origin.x = origin
            .x
            .max(bounds.left() + px(6.))
            .min(bounds.right() - dimensions.width - px(6.));
        if origin.y + dimensions.height > bounds.bottom() {
            origin.y = (anchor.y - dimensions.height - px(6.)).max(bounds.top() + px(6.));
        }
    }
    let (handle, _) = open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(origin, dimensions))),
            titlebar: None,
            kind: WindowKind::PopUp,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Transparent,
            display_id: display.map(|d| d.id()),
            ..Default::default()
        },
        cx,
        |window, cx| {
            window.set_window_title("界舟 · 设备速览");
            cx.new(|cx| {
                cx.observe(&panel, |_, _, cx| cx.notify()).detach();
                cx.observe_window_activation(window, |this: &mut TrayPanel, window, cx| {
                    if !window.is_window_active() {
                        this.dismiss(window, cx);
                    }
                })
                .detach();
                let observing = panel.clone();
                window
                    .observe_window_appearance(move |window, cx| {
                        if observing.read(cx).appearance == Appearance::System {
                            crate::theme::sync(window.appearance(), cx);
                        }
                    })
                    .detach();
                let focus = cx.focus_handle();
                window.focus(&focus, cx);
                TrayPanel {
                    panel: panel.clone(),
                    main,
                    focus,
                    dismissed,
                }
            })
        },
    )?;
    // A status-item click belongs to Explorer on Windows. Showing a topmost
    // tool window alone does not make it foreground, so it would never receive
    // the deactivation event used to dismiss it on an outside click.
    handle.update(cx, |_, window, _| window.activate_window())?;
    panel.update(cx, |panel, cx| {
        panel.tray_visible = true;
        // User-opened overview reads current state and installation discovery; never starts a model test.
        panel.refresh(cx);
        cx.notify();
    });
    Ok(handle)
}

fn harness_list_height(count: usize) -> f32 {
    count.min(4) as f32 * TRAY_ROW_HEIGHT
}

fn content_height(count: usize, attention: bool) -> Pixels {
    let attention = if attention {
        ATTENTION_HEIGHT + TRAY_GAP
    } else {
        0.
    };
    let harnesses = if count == 0 {
        SECTION_HEIGHT
    } else {
        SEPARATOR_HEIGHT + 2. * SECTION_GAP + SECTION_HEIGHT + harness_list_height(count)
    };
    px(2. * TRAY_PADDING_Y
        + 2. * TRAY_GAP
        + metrics::TRAY_HEADER_HEIGHT
        + SECTION_HEIGHT
        + SECTION_GAP
        + CONNECTION_HEIGHT
        + attention
        + harnesses)
}

impl Render for TrayPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = cx.theme().colors;
        let model = self.panel.read(cx);
        let rows = model.harness_rows();
        let count = rows.len();
        let configured = yes(&model.state, "configured");
        let online = model.server_online();
        let destination = model.connection_destination();
        let attention = model.attention();
        let testing = model.test_running();
        let reading = matches!(model.active_operation, Some("status" | "preferences"));
        let (status, address) = if model.connect_unconfirmed && destination == Page::Home {
            ("接入结果待确认", None)
        } else if model.stale || !model.state["configured"].is_boolean() {
            let label = if reading {
                "正在读取连接状态"
            } else {
                "连接状态待刷新"
            };
            (label, None)
        } else if configured {
            (model.status_label(), Some(text(&model.state, "server")))
        } else if model.state["connectionRecovery"].is_object() {
            ("继续上次接入", None)
        } else {
            ("接入服务器", None)
        };
        let connection_action = if destination == Page::Home {
            format!("{status}，打开本机概览")
        } else {
            status.to_owned()
        };
        let connection_label = address.as_ref().map_or_else(
            || connection_action.clone(),
            |address| format!("{address}，{connection_action}"),
        );
        let installed_label = model.harness_summary();

        let desired = content_height(count, attention.is_some()).min(
            window.display(cx).map_or(px(600.), |display| {
                display.visible_bounds().size.height - px(12.)
            }),
        );
        if (window.bounds().size.height - desired).abs() > px(1.) {
            window.resize(size(px(TRAY_WIDTH), desired));
        }

        let harnesses = if count == 0 {
            h_flex().h(px(SECTION_HEIGHT)).child(
                Label::new(if reading {
                    "正在检测本机 Harness…"
                } else {
                    "本机 Harness 安装状态待确认"
                })
                .text_xs()
                .text_color(p.muted_foreground),
            )
        } else {
            let tray = cx.weak_entity();
            let list = harness_list(rows, true, window, cx, move |key, window, cx| {
                let _ = tray.update(cx, |tray, cx| tray.open(Page::Provider(key), window, cx));
            });
            v_flex()
                .gap(px(SECTION_GAP))
                .child(Separator::horizontal().w_full().h(px(SEPARATOR_HEIGHT)))
                .child(
                    h_flex()
                        .h(px(SECTION_HEIGHT))
                        .justify_between()
                        .child(section_title("本机 Harness"))
                        .child(
                            Label::new(installed_label)
                                .text_xs()
                                .text_color(p.muted_foreground),
                        ),
                )
                .child(
                    v_flex()
                        .h(px(harness_list_height(count)))
                        .min_h_0()
                        .child(list),
                )
        };

        v_flex()
            .id("tray-panel")
            .track_focus(&self.focus)
            .size_full()
            .overflow_y_scroll()
            .bg(p.background)
            .text_color(p.foreground)
            .text_sm()
            .gap(px(TRAY_GAP))
            .px(px(metrics::GAP))
            .py(px(TRAY_PADDING_Y))
            .on_action(cx.listener(|this, _: &DismissTray, window, cx| this.dismiss(window, cx)))
            .child(
                h_flex()
                    .gap_2()
                    .h(px(metrics::TRAY_HEADER_HEIGHT))
                    .flex_shrink_0()
                    .child(super::view::brand_image())
                    .child(section_title("界舟").flex_1())
                    .child(
                        Button::new("tray-settings")
                            .ghost()
                            .small()
                            .icon(IconName::Settings2)
                            .accessibility_label("设置")
                            .tooltip("设置")
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.open(Page::Settings, window, cx)
                            })),
                    ),
            )
            .child(
                v_flex()
                    .gap(px(SECTION_GAP))
                    .flex_shrink_0()
                    .child(
                        h_flex()
                            .h(px(SECTION_HEIGHT))
                            .child(section_title("服务器连接")),
                    )
                    .child(
                        navigation_row(
                            "tray-connection",
                            connection_label,
                            h_flex()
                                .size(px(TRAY_ROW_ICON_SIZE))
                                .justify_center()
                                .child(
                                    Icon::new(if online {
                                        IconName::CircleCheck
                                    } else {
                                        IconName::Server
                                    })
                                    .size(px(16.))
                                    .text_color(if online {
                                        p.success
                                    } else {
                                        p.muted_foreground
                                    }),
                                ),
                            v_flex()
                                .child(
                                    Label::new(status)
                                        .text_sm()
                                        .line_height(px(16.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .truncate(),
                                )
                                .children(address.map(|address| {
                                    Label::new(address)
                                        .text_xs()
                                        .line_height(px(14.))
                                        .text_color(p.muted_foreground)
                                        .truncate()
                                })),
                            TRAY_ROW_CHEVRON_SIZE,
                            cx,
                        )
                        .h(px(CONNECTION_HEIGHT))
                        .flex_shrink_0()
                        .role(Role::Button)
                        .tab_index(0)
                        .focus_visible(|style| style.bg(p.list_active))
                        .on_click(cx.listener(|this, _, window, cx| {
                            let page = this.panel.read(cx).connection_destination();
                            this.open(page, window, cx);
                        })),
                    ),
            )
            .children(attention.map(|attention| {
                let warning = attention.warning;
                let alert = if warning {
                    Alert::warning("tray-attention", "核对原操作状态")
                } else if testing {
                    Alert::info("tray-attention", "正在等待测试结果")
                } else {
                    Alert::info("tray-attention", "进度与审批请在调用方查看")
                };
                let action = if warning {
                    "打开设置"
                } else {
                    "本机概览"
                };
                h_flex()
                    .min_h(px(ATTENTION_HEIGHT))
                    .flex_shrink_0()
                    .gap_2()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(alert.title(attention.title).small()),
                    )
                    .child(
                        button("tray-attention-open", action)
                            .small()
                            .flex_shrink_0()
                            .tooltip(attention.detail)
                            .accessibility_label(format!("{action}，{}", attention.detail))
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.open(
                                    if warning { Page::Settings } else { Page::Home },
                                    window,
                                    cx,
                                );
                            })),
                    )
            }))
            .child(harnesses.flex_shrink_0())
    }
}
