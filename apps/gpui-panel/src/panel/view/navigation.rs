use super::*;
use gpui_kit::component::Collapsible;
use std::rc::Rc;

const NAVIGATION_ROW_HEIGHT: f32 = 36.;

/// Keep the sidebar's list rhythm explicit without changing Kit button styles.
/// SidebarGroup's fixed spacing cannot be configured independently of its rows.
#[derive(Clone)]
pub(super) struct HarnessNavigationGroup {
    items: Vec<HarnessNavigation>,
    collapsed: bool,
}

impl HarnessNavigationGroup {
    pub(super) fn new(items: Vec<HarnessNavigation>) -> Self {
        Self {
            items,
            collapsed: false,
        }
    }
}

impl Collapsible for HarnessNavigationGroup {
    fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }
}

impl SidebarItem for HarnessNavigationGroup {
    fn render(
        self,
        id: impl Into<ElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> impl IntoElement {
        let id = id.into();
        v_flex()
            .w_full()
            .when(!self.collapsed, |this| {
                this.child(
                    div().px_2().pt_1().pb_2().child(
                        Label::new("本机 Harness")
                            .text_xs()
                            .line_height(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(cx.theme().muted_foreground),
                    ),
                )
            })
            .child(
                v_flex()
                    .gap_1()
                    .children(self.items.into_iter().enumerate().map(|(index, item)| {
                        item.collapsed(self.collapsed)
                            .render(format!("{id}-{index}"), window, cx)
                            .into_any_element()
                    })),
            )
    }
}

/// SidebarMenuItem accepts only a monochrome Icon. Keep the Kit button's
/// interaction states while drawing the installed Harness's full-color mark.
#[derive(Clone)]
pub(super) struct HarnessNavigation {
    key: String,
    label: String,
    selected: bool,
    disabled: bool,
    collapsed: bool,
    on_click: Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>,
}

impl HarnessNavigation {
    pub(super) fn new(key: String, label: String) -> Self {
        Self {
            key,
            label,
            selected: false,
            disabled: false,
            collapsed: false,
            on_click: Rc::new(|_, _, _| {}),
        }
    }

    pub(super) fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }

    pub(super) fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub(super) fn on_click(
        mut self,
        on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Rc::new(on_click);
        self
    }
}

impl Collapsible for HarnessNavigation {
    fn is_collapsed(&self) -> bool {
        self.collapsed
    }

    fn collapsed(mut self, collapsed: bool) -> Self {
        self.collapsed = collapsed;
        self
    }
}

impl SidebarItem for HarnessNavigation {
    fn render(
        self,
        id: impl Into<ElementId>,
        _window: &mut Window,
        _cx: &mut App,
    ) -> impl IntoElement {
        let on_click = self.on_click;
        Button::new(id)
            .ghost()
            .small()
            .w_full()
            .h(px(NAVIGATION_ROW_HEIGHT))
            .px_2()
            .selected(self.selected)
            .disabled(self.disabled)
            .accessibility_label(self.label.clone())
            .tooltip(self.label.clone())
            .child(
                h_flex()
                    .w_full()
                    .min_w_0()
                    .gap_2()
                    .when(self.collapsed, |this| this.justify_center())
                    .child(icon_slot(18., provider_mark(&self.key, 18.)))
                    .when(!self.collapsed, |this| {
                        this.child(
                            Label::new(self.label)
                                .text_sm()
                                .min_w_0()
                                .truncate()
                                .when(self.selected, |this| this.font_weight(FontWeight::MEDIUM)),
                        )
                    }),
            )
            .on_click(move |event, window, cx| on_click(event, window, cx))
    }
}
