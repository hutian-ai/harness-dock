#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod app_assets;
mod bridge;
mod panel;
mod theme;
#[cfg(target_os = "windows")]
mod window_visibility;

#[cfg(not(target_os = "macos"))]
use gpui_kit::component::TitleBar;
use gpui_kit::*;
use panel::{Page, Panel};
#[cfg(not(target_os = "macos"))]
use std::{cell::Cell, time::Instant};
use std::{cell::RefCell, collections::VecDeque, rc::Rc, time::Duration};
#[cfg(not(target_os = "macos"))]
use tray_icon::menu::{Menu as TrayMenu, MenuItem as TrayItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, menu::MenuEvent};

actions!(
    dock,
    [
        QuitPanel,
        HidePanel,
        RefreshPanel,
        ShowTray,
        ShowOverview,
        ShowSettings
    ]
);
enum Open {
    Show,
    Page(Page),
    Invitation(String),
    Tray,
    #[cfg(target_os = "macos")]
    Connection,
    #[cfg(target_os = "macos")]
    Attention,
}

fn activate_main_window(window: &mut Window, cx: &mut App) {
    #[cfg(target_os = "windows")]
    if window_visibility::show(window).is_err() {
        eprintln!("window_show_failed");
    }
    window.activate_window();
    cx.activate(true);
}

fn main() {
    let mut args = std::env::args().skip(1);
    let config = match args.next().as_deref() {
        Some("--config") => args.next(),
        _ => None,
    };
    let events = Rc::new(RefCell::new(VecDeque::new()));
    let app = application()
        .with_assets(app_assets::AppAssets)
        .with_quit_mode(QuitMode::Explicit);
    let incoming = events.clone();
    app.on_open_urls(move |urls| {
        let mut incoming = incoming.borrow_mut();
        for url in urls.into_iter().filter(|u| u.len() <= 4096).take(4) {
            if incoming.len() < 4 {
                incoming.push_back(Open::Invitation(url));
            }
        }
    });
    let incoming = events.clone();
    app.on_reopen(move |_| {
        let mut incoming = incoming.borrow_mut();
        if incoming.len() < 4 {
            incoming.push_back(Open::Show);
        }
    });
    app.run(move |cx| {
        init(cx);
        theme::Appearance::System.apply(cx);
        let bridge = bridge::Bridge::installed().expect("packaged application path");
        #[cfg(target_os = "macos")]
        let frame = WindowOptions::default();
        #[cfg(not(target_os = "macos"))]
        let frame = TitleBar::window_options();
        let (handle, view) = open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1100.), px(740.)),
                    cx,
                ))),
                window_min_size: Some(size(px(536. + theme::metrics::SIDEBAR_WIDTH), px(400.))),
                ..frame
            },
            cx,
            move |window, cx| {
                let view = cx.new(|cx| Panel::new(bridge, config, window, cx));
                let closing = view.clone();
                window.on_window_should_close(cx, move |window, cx| {
                    closing.update(cx, |view, cx| view.hide(window, cx));
                    false
                });
                let observing = view.clone();
                window
                    .observe_window_appearance(move |window, cx| {
                        if observing.read(cx).appearance == theme::Appearance::System {
                            theme::sync(window.appearance(), cx);
                        }
                    })
                    .detach();
                view
            },
        )
        .expect("open 界舟 · Harness Dock window");
        view.update(cx, |view, cx| view.bootstrap(cx));
        let quitting = view.clone();
        cx.on_action(move |_: &QuitPanel, cx| quitting.update(cx, |view, cx| view.quit(cx)));
        let hiding = view.clone();
        cx.on_action(move |_: &HidePanel, cx| {
            let hiding = hiding.clone();
            cx.defer(move |cx| {
                let _ = handle.update(cx, |_, window, cx| {
                    hiding.update(cx, |view, cx| view.hide(window, cx));
                });
            });
        });
        let refreshing = view.clone();
        cx.on_action(move |_: &RefreshPanel, cx| {
            refreshing.update(cx, |view, cx| view.refresh(cx))
        });
        let quick = events.clone();
        cx.on_action(move |_: &ShowTray, _| quick.borrow_mut().push_back(Open::Tray));
        let overview = events.clone();
        cx.on_action(move |_: &ShowOverview, _| {
            overview.borrow_mut().push_back(Open::Page(Page::Home))
        });
        let settings = events.clone();
        cx.on_action(move |_: &ShowSettings, _| {
            settings.borrow_mut().push_back(Open::Page(Page::Settings))
        });
        let (quit_key, hide_key, refresh_key) = if cfg!(target_os = "macos") {
            ("cmd-q", "cmd-w", "cmd-r")
        } else {
            ("ctrl-q", "ctrl-w", "ctrl-r")
        };
        cx.bind_keys([
            KeyBinding::new(quit_key, QuitPanel, None),
            KeyBinding::new(hide_key, HidePanel, None),
            KeyBinding::new(refresh_key, RefreshPanel, None),
            KeyBinding::new(
                if cfg!(target_os = "macos") {
                    "cmd-1"
                } else {
                    "ctrl-1"
                },
                ShowOverview,
                None,
            ),
            KeyBinding::new(
                if cfg!(target_os = "macos") {
                    "cmd-,"
                } else {
                    "ctrl-2"
                },
                ShowSettings,
                None,
            ),
            KeyBinding::new(
                if cfg!(target_os = "macos") {
                    "cmd-shift-d"
                } else {
                    "ctrl-shift-d"
                },
                ShowTray,
                None,
            ),
        ]);
        #[cfg(not(target_os = "macos"))]
        cx.bind_keys([KeyBinding::new("escape", panel::tray::DismissTray, None)]);
        let app_menu = Menu {
            name: "界舟 · Harness Dock".into(),
            disabled: false,
            items: if cfg!(target_os = "macos") {
                vec![
                    MenuItem::action("设置…", ShowSettings),
                    MenuItem::separator(),
                    MenuItem::action("收起窗口", HidePanel),
                    MenuItem::separator(),
                    MenuItem::action("退出 界舟 · Harness Dock", QuitPanel),
                ]
            } else {
                vec![
                    MenuItem::action("设备速览", ShowTray),
                    MenuItem::action("收起窗口", HidePanel),
                    MenuItem::action("刷新状态", RefreshPanel),
                    MenuItem::separator(),
                    MenuItem::action("退出 界舟 · Harness Dock", QuitPanel),
                ]
            },
        };
        cx.set_menus([
            app_menu,
            Menu {
                name: if cfg!(target_os = "macos") {
                    "显示"
                } else {
                    "前往"
                }
                .into(),
                disabled: false,
                items: if cfg!(target_os = "macos") {
                    vec![
                        MenuItem::action("本机概览", ShowOverview),
                        MenuItem::action("刷新状态", RefreshPanel),
                        MenuItem::action("设备速览", ShowTray),
                    ]
                } else {
                    vec![
                        MenuItem::action("本机概览", ShowOverview),
                        MenuItem::action("设置", ShowSettings),
                    ]
                },
            },
        ]);
        #[cfg(target_os = "macos")]
        let (menu, mut snapshot) = {
            let snapshot = panel::tray::Snapshot::read(view.read(cx));
            (snapshot.menu(), snapshot)
        };
        #[cfg(not(target_os = "macos"))]
        let (menu, ids) = {
            let show = TrayItem::new("打开 界舟 · Harness Dock", true, None);
            let refresh = TrayItem::new("刷新设备状态", true, None);
            let hide = TrayItem::new("收起窗口", true, None);
            let quit = TrayItem::new("退出界面（后台继续运行）", true, None);
            let menu = TrayMenu::with_items(&[&show, &refresh, &hide, &quit]).expect("tray menu");
            let ids = [show, refresh, hide, quit].map(|item| item.id().0.clone());
            (menu, ids)
        };
        // macOS colors a template from its alpha channel for light/dark menu bars.
        let source = if cfg!(target_os = "macos") {
            include_bytes!("../../device-panel/Resources/TrayTemplate.png").as_slice()
        } else {
            include_bytes!("../../device-panel/Resources/JiezhouMark.png").as_slice()
        };
        let png = image::load_from_memory(source).expect("brand icon");
        let mark = png
            .resize(32, 32, image::imageops::FilterType::Lanczos3)
            .into_rgba8();
        let mut canvas = image::RgbaImage::new(36, 36);
        image::imageops::overlay(
            &mut canvas,
            &mark,
            ((36 - mark.width()) / 2).into(),
            ((36 - mark.height()) / 2).into(),
        );
        let icon = tray_icon::Icon::from_rgba(canvas.into_raw(), 36, 36).expect("tray icon");
        #[cfg(target_os = "macos")]
        let builder = TrayIconBuilder::new().with_icon_templated(icon);
        #[cfg(not(target_os = "macos"))]
        let builder = TrayIconBuilder::new().with_icon(icon);
        let tray = builder
            .with_menu(Box::new(menu))
            .with_menu_on_left_click(cfg!(target_os = "macos"))
            .with_tooltip("界舟 · Harness Dock · 设备接入")
            .build();
        // A window remains usable if the platform cannot create its tray icon.
        if tray.is_err() {
            eprintln!("tray_unavailable");
        }
        view.update(cx, |view, _| view.tray_available = tray.is_ok());
        cx.activate(true);
        cx.spawn(async move |cx| {
            let tray = tray;
            #[cfg(not(target_os = "macos"))]
            let mut popup: Option<AnyWindowHandle> = None;
            #[cfg(not(target_os = "macos"))]
            let dismissed = Rc::new(Cell::new(None::<Instant>));
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
                #[cfg(target_os = "macos")]
                let mut menu_opened = false;
                #[cfg(not(target_os = "macos"))]
                if popup.is_some()
                    && (view.read_with(cx, |view, _| !view.tray_visible)
                        || events
                            .borrow()
                            .front()
                            .is_some_and(|event| !matches!(event, Open::Tray)))
                {
                    if let Some(open) = popup.take() {
                        let _ = open.update(cx, |_, window, _| window.remove_window());
                    }
                    let _ = view.update(cx, |view, cx| {
                        view.tray_visible = false;
                        cx.notify();
                    });
                    dismissed.set(Some(Instant::now()));
                }
                while let Ok(event) = TrayIconEvent::receiver().try_recv() {
                    #[cfg(target_os = "macos")]
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left | MouseButton::Right,
                            button_state: MouseButtonState::Down,
                            ..
                        }
                    ) {
                        menu_opened = true;
                    }
                    #[cfg(not(target_os = "macos"))]
                    if let TrayIconEvent::Click {
                        rect,
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Down,
                        ..
                    } = event
                    {
                        if let Some(open) = popup.take() {
                            if open
                                .update(cx, |_, window, _| window.remove_window())
                                .is_ok()
                            {
                                let _ = view.update(cx, |view, cx| {
                                    view.tray_visible = false;
                                    cx.notify();
                                });
                                dismissed.set(Some(Instant::now()));
                                continue;
                            }
                        }
                        // A tray click can dismiss the old popup before its click event arrives.
                        if dismissed
                            .get()
                            .is_some_and(|time| time.elapsed() < Duration::from_millis(350))
                        {
                            continue;
                        }
                        let _ = cx.update(|cx| {
                            match panel::tray::open(
                                view.clone(),
                                handle,
                                rect,
                                dismissed.clone(),
                                cx,
                            ) {
                                Ok(window) => popup = Some(window),
                                Err(_) => events.borrow_mut().push_back(Open::Show),
                            }
                        });
                    }
                }
                while let Ok(event) = MenuEvent::receiver().try_recv() {
                    #[cfg(target_os = "macos")]
                    {
                        use panel::tray::Command;
                        let open = match panel::tray::command(&event.id.0) {
                            Some(Command::Page(page)) => Some(Open::Page(page)),
                            Some(Command::Connection) => Some(Open::Connection),
                            Some(Command::Attention) => Some(Open::Attention),
                            Some(Command::Quit) => {
                                let _ = view.update(cx, |view, cx| view.quit(cx));
                                None
                            }
                            None => None,
                        };
                        if let Some(open) = open {
                            events.borrow_mut().push_back(open);
                        }
                    }
                    #[cfg(not(target_os = "macos"))]
                    match ids.iter().position(|id| *id == event.id.0) {
                        Some(0) => {
                            events.borrow_mut().push_back(Open::Show);
                        }
                        Some(1) => {
                            let _ = view.update(cx, |view, cx| view.refresh(cx));
                        }
                        Some(2) => {
                            let _ = handle.update(cx, |_, window, cx| {
                                view.update(cx, |view, cx| view.hide(window, cx));
                            });
                        }
                        Some(3) => {
                            let _ = view.update(cx, |view, cx| view.quit(cx));
                        }
                        _ => (),
                    }
                }
                let ready = view.read_with(cx, |view, _| view.can_handle_open());
                if ready {
                    let event = events.borrow_mut().pop_front();
                    if let Some(event) = event {
                        #[cfg(target_os = "macos")]
                        if matches!(event, Open::Tray) {
                            if let Ok(tray) = &tray {
                                // AppKit tracks the menu in a nested event loop.
                                // Don't hold a GPUI model borrow while it is open.
                                tray.show_menu();
                            }
                            continue;
                        }
                        #[cfg(not(target_os = "macos"))]
                        if matches!(event, Open::Tray) {
                            if let Some(rect) = tray.as_ref().ok().and_then(|tray| tray.rect()) {
                                if let Some(open) = popup.take() {
                                    let _ = open.update(cx, |_, window, _| window.remove_window());
                                }
                                let _ = cx.update(|cx| {
                                    popup = panel::tray::open(
                                        view.clone(),
                                        handle,
                                        rect,
                                        dismissed.clone(),
                                        cx,
                                    )
                                    .ok();
                                });
                            }
                            continue;
                        }
                        #[cfg(not(target_os = "macos"))]
                        if let Some(open) = popup.take() {
                            let _ = open.update(cx, |_, window, _| window.remove_window());
                            let _ = view.update(cx, |view, _| view.tray_visible = false);
                        }
                        let _ = handle.update(cx, |_, window, cx| {
                            activate_main_window(window, cx);
                        });
                        let _ = view.update(cx, |view, cx| {
                            view.visible = true;
                            match event {
                                Open::Invitation(url) => view.receive_invitation(url, cx),
                                Open::Page(page) => view.navigate(page, cx),
                                #[cfg(target_os = "macos")]
                                Open::Connection => {
                                    view.navigate(view.connection_destination(), cx)
                                }
                                #[cfg(target_os = "macos")]
                                Open::Attention => {
                                    let page = view.tray_attention_destination();
                                    view.navigate(page, cx);
                                }
                                _ => {}
                            }
                            cx.notify();
                        });
                    }
                }
                #[cfg(target_os = "macos")]
                if let Ok(tray) = &tray {
                    if menu_opened {
                        let _ = view.update(cx, |view, cx| view.refresh_tray_snapshot(cx));
                    }
                    let _ = cx.update(|cx| {
                        let next = panel::tray::Snapshot::read(view.read(cx));
                        if next != snapshot {
                            tray.set_menu(Some(Box::new(next.menu())));
                            snapshot = next;
                        }
                    });
                }
                let _ = view.update(cx, |view, cx| view.tick(cx));
            }
        })
        .detach();
    });
}
