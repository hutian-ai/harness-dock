use super::ui::{button, page_title, section_title};
use super::*;
use crate::theme::{Appearance, metrics};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Selectable, Sizable,
    alert::Alert,
    button::{Button, ButtonGroup, ButtonVariants},
    clipboard::Clipboard,
    description_list::{DescriptionItem, DescriptionList},
    group_box::{GroupBox, GroupBoxVariants},
    h_flex,
    input::Input,
    label::Label,
    scroll::ScrollableElement,
    switch::Switch,
    v_flex,
};
#[cfg(not(target_os = "macos"))]
use gpui_kit::component::TitleBar;
use gpui_kit::component::{
    breadcrumb::{Breadcrumb, BreadcrumbItem},
    sidebar::{Sidebar, SidebarItem, SidebarMenu, SidebarMenuItem},
};
use gpui_kit::prelude::FluentBuilder;
use std::sync::{Arc, OnceLock};

mod connect;
mod dashboard;
mod diagnostics;
pub(super) mod home;
mod navigation;
mod provider;
mod settings;

fn glyph(name: IconName, size: f32) -> Icon {
    Icon::new(name).size(px(size))
}
fn surface() -> GroupBox {
    GroupBox::new().outline()
}
fn brand() -> Arc<Image> {
    static IMAGE: OnceLock<Arc<Image>> = OnceLock::new();
    IMAGE
        .get_or_init(|| {
            Arc::new(Image::from_bytes(
                ImageFormat::Png,
                include_bytes!("../../../device-panel/Resources/JiezhouMark.png").to_vec(),
            ))
        })
        .clone()
}

#[cfg(not(target_os = "macos"))]
pub(super) fn brand_image() -> impl IntoElement {
    img(brand()).size(px(24.)).rounded(px(5.))
}

/// UI branding is independent of the native adapter key.
pub(super) fn provider_name(provider: &Value) -> String {
    match provider["key"].as_str() {
        Some("dsh") => "DeepSeek Harness".into(),
        _ => text(provider, "displayName"),
    }
}

/// Transparent marks only. Adding a Harness changes the asset map, not tile styling.
const PROVIDER_LOGOS: &[(&str, &[u8])] = &[
    ("codex", include_bytes!("../../Resources/codex.svg")),
    ("dsh", include_bytes!("../../Resources/dsh.svg")),
];

struct ProviderArtwork;

impl Asset for ProviderArtwork {
    type Source = (&'static [u8], DevicePixels);
    type Output = Result<Arc<RenderImage>, ImageCacheError>;

    fn load(
        (data, edge): Self::Source,
        cx: &mut App,
    ) -> impl Future<Output = Self::Output> + Send + 'static {
        let renderer = cx.svg_renderer();
        async move {
            let svg = renderer.parse_svg(data)?;
            renderer
                .render_parsed(&svg, SvgSize::ExactSize(gpui_kit::size(edge, edge)))
                .map_err(Into::into)
        }
    }
}

pub(super) fn provider_mark(key: &str, size: f32) -> AnyElement {
    match PROVIDER_LOGOS.iter().find(|(name, _)| *name == key) {
        Some(&(_, data)) => img(move |window: &mut Window, cx: &mut App| {
            // Rasterize the full-color SVG at its displayed pixel size.
            let edge = DevicePixels((size * window.scale_factor()).round() as i32);
            window.use_asset::<ProviderArtwork>(&(data, edge), cx)
        })
        .size(px(size))
        .into_any_element(),
        None => glyph(IconName::SquareTerminal, size).into_any_element(),
    }
}

pub(super) fn provider_logo(key: &str, size: f32) -> AnyElement {
    icon_slot(size, provider_mark(key, size * 0.8)).into_any_element()
}

fn icon_slot(size: f32, icon: impl IntoElement) -> Div {
    h_flex()
        .size(px(size))
        .flex_shrink_0()
        .justify_center()
        .child(icon)
}

impl Panel {
    pub fn navigate(&mut self, page: Page, cx: &mut Context<Self>) {
        let page = if page == Page::Connect && yes(&self.state, "configured") {
            Page::Home
        } else {
            page
        };
        if page != self.page && !matches!(page, Page::Home | Page::Settings) {
            self.detail_scroll.set_offset(Point::default());
        }
        if let Page::Provider(key) = &page {
            if self.provider != *key {
                self.checks.clear();
            }
            self.provider = key.clone();
        }
        let read_native = matches!(&page, Page::Provider(_))
            && yes(&self.state, "running")
            && yes(&self.state, "providerDetailsSupported")
            && self.state["providerDetails"][&self.provider].is_null()
            && !self.stale
            && !self.busy
            && !self.blocked();
        self.page = page;
        self.notice = None;
        if !self.stale
            && self.pending.is_none()
            && !self.test_running()
            && !self.connect_unconfirmed
        {
            self.error = None;
        }
        if read_native {
            self.request("provider-details", json!({}), Reply::State, None, cx);
        }
        cx.notify();
    }
    fn muted(&self, label: impl Into<SharedString>, cx: &App) -> Label {
        Label::new(label)
            .text_sm()
            .text_color(cx.theme().muted_foreground)
    }
    pub(super) fn installation_label(&self, provider: &Value) -> &'static str {
        if self.stale {
            return "检测待刷新";
        }
        match provider["status"].as_str() {
            Some("installed") => "已安装",
            Some("disabled") => "已停用",
            Some("not_found") => "未检测到",
            _ => "待确认",
        }
    }
    fn device_attention(&self, cx: &mut Context<Self>) -> Option<Div> {
        if (self.page == Page::Home
            || (matches!(self.page, Page::Provider(_) | Page::Settings)
                && self.state["unresolved"].as_u64().unwrap_or(0) == 0))
            && self.state["overview"].is_object()
            && self.pending.is_none()
            && self.active_operation != Some("test")
            && !self.test_running()
            && (self.state["active"].as_u64().unwrap_or(0) > 0
                || (self.page == Page::Home && self.state["unresolved"].as_u64().unwrap_or(0) > 0))
        {
            return None;
        }
        self.attention().map(|attention| {
            let resume =
                self.page != Page::Home && self.pending.is_some() && self.can_resume_service();
            let alert = if attention.warning {
                Alert::warning("device-attention", attention.detail)
            } else {
                Alert::info("device-attention", attention.detail)
            };
            v_flex()
                .gap_2()
                .child(alert.title(attention.title).small())
                .children(resume.then(|| {
                    button("resume-pending-service", "恢复服务并核对结果")
                        .primary()
                        .self_start()
                        .disabled(self.busy)
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.confirm(
                                "start",
                                json!({}),
                                "恢复连接服务并核对原测试？",
                                "仅启动原设备后台并查询已保存的测试编号，不会重新发送模型请求。",
                                window,
                                cx,
                            )
                        }))
                }))
                .children(
                    (!resume && self.page != Page::Home && self.can_resume_service()).then(|| {
                        button("attention-overview", "前往概览启动连接")
                            .self_start()
                            .on_click(cx.listener(|this, _, _, cx| this.navigate(Page::Home, cx)))
                    }),
                )
                .children(
                    (!resume
                        && attention.warning
                        && self.page != Page::Settings
                        && yes(&self.state, "running"))
                    .then(|| {
                        button("attention-settings", "前往设置排查")
                            .self_start()
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.navigate(Page::Settings, cx);
                            }))
                    }),
                )
        })
    }
    fn page_feedback(&self, cx: &mut Context<Self>) -> Option<Div> {
        let onboarding =
            !yes(&self.state, "configured") && matches!(self.page, Page::Home | Page::Connect);
        let error = self.error.as_ref().filter(|_| !onboarding);
        let attention = self.device_attention(cx);
        let notice = self.notice.as_ref().filter(|_| !onboarding);
        if error.is_none() && attention.is_none() && notice.is_none() {
            return None;
        }
        Some(
            v_flex()
                .gap_2()
                .children(error.map(|message| Alert::error("page-error", message.clone()).small()))
                .children(attention)
                .children(notice.map(|message| self.muted(message.clone(), cx))),
        )
    }
    fn read_action(
        &self,
        id: &'static str,
        label: &'static str,
        icon: IconName,
        operation: &'static str,
        _cx: &App,
    ) -> Button {
        button(id, label)
            .icon(icon)
            .loading(self.active_operation == Some(operation))
            .disabled(self.busy)
    }
    fn log_location_action(&self, id: &'static str, cx: &mut Context<Self>) -> Button {
        let label = if cfg!(target_os = "macos") {
            "在访达中显示日志"
        } else {
            "显示日志文件"
        };
        self.read_action(id, "日志位置", IconName::FolderOpen, "log-location", cx)
            .ghost()
            .accessibility_label(label)
            .tooltip(label)
            .on_click(cx.listener(|this, _, _, cx| {
                this.request("log-location", json!({}), Reply::LogLocation, None, cx);
            }))
    }
    fn overview_refresh(&self, cx: &mut Context<Self>) -> Button {
        Button::new("home-refresh")
            .icon(IconName::RefreshCw)
            .ghost()
            .loading(matches!(
                self.active_operation,
                Some("status" | "test-status" | "preferences")
            ))
            .loading_icon(IconName::RefreshCw)
            .tooltip("立即刷新。窗口显示时通常每 10 秒更新；模型测试期间每 2 秒更新。")
            .accessibility_label("刷新设备与 Harness 状态")
            .disabled(self.busy)
            .on_click(cx.listener(|this, _, _, cx| this.refresh(cx)))
    }
    fn appearance_controls(&self, cx: &mut Context<Self>) -> ButtonGroup {
        ButtonGroup::new("appearance")
            .outline()
            .children(
                [
                    (Appearance::System, "跟随系统"),
                    (Appearance::Light, "浅色"),
                    (Appearance::Dark, "深色"),
                ]
                .into_iter()
                .map(|(mode, label)| {
                    Button::new(SharedString::from(format!("appearance-{}", mode.key())))
                        .label(label)
                        .selected(self.appearance == mode)
                        .accessibility_label(format!("外观：{label}"))
                }),
            )
            .on_click(cx.listener(|this, selected: &Vec<usize>, _, cx| {
                if let Some(index) = selected.first() {
                    if let Some(mode) =
                        [Appearance::System, Appearance::Light, Appearance::Dark].get(*index)
                    {
                        this.set_appearance(*mode, cx);
                    }
                }
            }))
    }
    fn navigation_sidebar(
        &self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Sidebar<navigation::HarnessNavigationGroup> {
        let colors = cx.theme().colors;
        let select = |label: String, icon: Icon, page: Page, active| {
            SidebarMenuItem::new(label)
                .icon(icon.size(px(18.)))
                .min_h(px(36.))
                .active(active)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if !this.interaction_pending && this.page != page {
                        this.navigate(page.clone(), cx);
                    }
                }))
        };
        let overview = SidebarMenu::new().child(select(
            "概览".into(),
            Icon::new(IconName::LayoutDashboard),
            Page::Home,
            matches!(
                self.page,
                Page::Home | Page::Connect | Page::Usage | Page::Execution(_)
            ),
        ));
        let settings = SidebarMenu::new().child(select(
            "设置".into(),
            Icon::new(IconName::Settings2),
            Page::Settings,
            self.page == Page::Settings,
        ));
        let providers = self.state["providers"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let harnesses: Vec<_> = providers
            .iter()
            .map(|provider| {
                let key = text(provider, "key");
                let page = Page::Provider(key.clone());
                navigation::HarnessNavigation::new(key, provider_name(provider))
                    .selected(self.page == page)
                    .disabled(self.interaction_pending)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.interaction_pending && this.page != page {
                            this.navigate(page.clone(), cx);
                        }
                    }))
            })
            .collect();
        Sidebar::new("panel-navigation")
            .w(px(metrics::SIDEBAR_WIDTH))
            .border_r_1()
            .border_color(colors.border)
            .collapsible(false)
            .header(
                v_flex()
                    .w_full()
                    .gap_4()
                    .pb_1()
                    .child(
                        h_flex()
                            .h(px(56.))
                            .gap_3()
                            .px_2()
                            .child(icon_slot(32., img(brand()).size(px(28.))))
                            .child(
                                v_flex()
                                    .gap(px(3.))
                                    .child(section_title("界舟").line_height(px(18.)))
                                    .child(
                                        Label::new(format!(
                                            "Harness Dock {}",
                                            env!("CARGO_PKG_VERSION")
                                                .split('-')
                                                .next()
                                                .unwrap_or("")
                                        ))
                                        .text_size(px(11.))
                                        .line_height(px(14.))
                                        .text_color(colors.muted_foreground),
                                    ),
                            ),
                    )
                    .child(overview.render("overview-navigation", window, cx)),
            )
            .child(navigation::HarnessNavigationGroup::new(harnesses))
            .footer(
                div()
                    .w_full()
                    .child(settings.render("settings-navigation", window, cx)),
            )
    }
    fn dashboard_header(&self, cx: &mut Context<Self>) -> Div {
        let trail = Breadcrumb::new();
        let trail = match self.page {
            Page::Home => trail.child("概览"),
            Page::Settings => trail.child("设置"),
            Page::Connect | Page::Provider(_) | Page::Usage | Page::Execution(_) => trail
                .child(
                    BreadcrumbItem::new("概览")
                        .disabled(self.interaction_pending)
                        .on_click(cx.listener(|this, _, _, cx| this.navigate(Page::Home, cx))),
                )
                .child(match &self.page {
                    Page::Connect => "设备接入",
                    Page::Usage => "用量明细",
                    Page::Execution(_) => "执行详情",
                    Page::Provider(key) if key == "codex" => "Codex",
                    Page::Provider(_) => "DeepSeek Harness",
                    _ => unreachable!(),
                }),
        };
        h_flex()
            .h(px(48.))
            .flex_shrink_0()
            .justify_between()
            .px(px(metrics::PAGE_PADDING))
            .border_b_1()
            .border_color(cx.theme().border)
            .child(trail.font_weight(FontWeight::MEDIUM))
            .children((self.page == Page::Home).then(|| self.overview_refresh(cx).small()))
    }
    fn technical_value(&self, id: &str, label: &str, value: String, cx: &App) -> AnyElement {
        if value.is_empty() {
            return self.muted("—", cx).into_any_element();
        }
        h_flex()
            .gap_2()
            .min_w_0()
            .child(
                Label::new(value.clone())
                    .text_sm()
                    .truncate()
                    .flex_1()
                    .min_w_0()
                    .font_family(cx.theme().mono_font_family.clone()),
            )
            .child(
                Clipboard::new(SharedString::from(format!("copy-{id}")))
                    .small()
                    .value(value)
                    .tooltip("复制完整内容")
                    .accessibility_label(format!("复制{label}")),
            )
            .into_any_element()
    }
}

impl Render for Panel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = cx.theme().colors;
        let (content_id, body) = match &self.page {
            Page::Home => ("overview-content", self.home(window, cx)),
            Page::Connect => ("connect-content", self.connect_page(cx)),
            Page::Settings => ("settings-content", self.settings(cx)),
            Page::Provider(key) => ("harness-content", self.provider_page(key, cx)),
            Page::Usage => ("usage-content", self.usage_page(cx)),
            Page::Execution(id) => ("execution-content", self.execution_page(id, cx)),
        };
        let root = v_flex()
            .track_focus(&self.focus)
            .size_full()
            .bg(p.background)
            .text_color(p.foreground)
            .text_sm();
        #[cfg(not(target_os = "macos"))]
        let root = root.child(TitleBar::new().child(Label::new("界舟 · Harness Dock")));
        let body = div()
            .flex_1()
            .min_h_0()
            .px(px(metrics::PAGE_PADDING))
            .py(px(metrics::PAGE_PADDING))
            .child(div().w_full().max_w(px(metrics::CONTENT_WIDTH)).child(body));
        let root = {
            let scroll = match self.page {
                Page::Home => &self.overview_scroll,
                Page::Settings => &self.settings_scroll,
                _ => &self.detail_scroll,
            };
            root.bg(p.sidebar)
                .child(
                    h_flex()
                        .flex_1()
                        .min_h_0()
                        .items_start()
                        .child(self.navigation_sidebar(window, cx))
                        .child(
                            div().flex_1().h_full().min_w_0().child(
                                v_flex()
                                    .size_full()
                                    .min_w_0()
                                    .overflow_hidden()
                                    .bg(p.background)
                                    .child(self.dashboard_header(cx))
                                    .child(
                                        body.id(content_id)
                                            .w_full()
                                            .overflow_y_scroll()
                                            .track_scroll(scroll)
                                            .vertical_scrollbar(scroll),
                                    ),
                            ),
                        ),
                )
                .child(self.dashboard_footer(cx))
        };
        root
    }
}
