#[cfg(not(target_os = "macos"))]
use gpui_kit::assets::IconName;
#[cfg(not(target_os = "macos"))]
use gpui_kit::component::{ActiveTheme, Icon, h_flex, list::ListItem};
use gpui_kit::component::{button::Button, label::Label};
use gpui_kit::*;

#[cfg(not(target_os = "macos"))]
pub(super) const TRAY_ROW_HEIGHT: f32 = 48.;
#[cfg(not(target_os = "macos"))]
pub(super) const TRAY_ROW_ICON_SIZE: f32 = 24.;
#[cfg(not(target_os = "macos"))]
pub(super) const TRAY_ROW_CHEVRON_SIZE: f32 = 12.;

pub(super) fn button(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Button {
    let label = label.into();
    Button::new(id)
        .accessibility_label(label.clone())
        .label(label)
}

#[cfg(not(target_os = "macos"))]
use gpui_kit::component::group_box::{GroupBox, GroupBoxVariants};

/// Overview groups use the same Kit border in both themes without form padding.
#[cfg(not(target_os = "macos"))]
pub(super) fn list_group() -> GroupBox {
    let mut content = div().p_0().gap_0().overflow_hidden();
    GroupBox::new()
        .outline()
        .content_style(content.style().clone())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn navigation_row(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: impl IntoElement,
    content: Div,
    chevron_size: f32,
    cx: &App,
) -> ListItem {
    ListItem::new(id)
        .role(Role::Group)
        .accessibility_label(label)
        .cursor_pointer()
        .child(
            h_flex()
                .w_full()
                .gap_3()
                .child(div().flex_shrink_0().child(icon))
                .child(content.flex_1().min_w_0())
                .child(
                    Icon::new(IconName::ChevronRight)
                        .size(px(chevron_size))
                        .text_color(cx.theme().muted_foreground)
                        .flex_shrink_0(),
                ),
        )
}

pub(super) fn page_title(label: impl Into<SharedString>) -> Label {
    Label::new(label)
        .text_xl()
        .font_weight(FontWeight::SEMIBOLD)
}

pub(super) fn section_title(label: impl Into<SharedString>) -> Label {
    Label::new(label)
        .text_sm()
        .font_weight(FontWeight::SEMIBOLD)
}
