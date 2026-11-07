use super::{Page, Panel, text, view::provider_name, yes};
use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};

const CONNECT: &str = "dock-status-connect";
const ATTENTION: &str = "dock-status-attention";
const PROVIDER: &str = "dock-status-provider:";
const OVERVIEW: &str = "dock-status-overview";
const SETTINGS: &str = "dock-status-settings";
const QUIT: &str = "dock-status-quit";

pub enum Command {
    Page(Page),
    Connection,
    Attention,
    Quit,
}

pub fn command(id: &str) -> Option<Command> {
    match id {
        CONNECT => Some(Command::Connection),
        ATTENTION => Some(Command::Attention),
        OVERVIEW => Some(Command::Page(Page::Home)),
        SETTINGS => Some(Command::Page(Page::Settings)),
        QUIT => Some(Command::Quit),
        _ => id
            .strip_prefix(PROVIDER)
            .map(|key| Command::Page(Page::Provider(key.into()))),
    }
}

/// An AppKit menu is a snapshot. Rebuild only when a displayed fact changes.
#[derive(PartialEq, Eq)]
pub struct Snapshot {
    status: String,
    connect: Option<&'static str>,
    attention: Option<&'static str>,
    harnesses: Vec<(String, String)>,
    can_quit: bool,
}

impl Snapshot {
    pub fn read(panel: &Panel) -> Self {
        let configured = yes(&panel.state, "configured");
        let cached = !panel.visible && panel.refreshed.elapsed().as_secs() >= 10;
        let status = if panel.connect_unconfirmed {
            "接入结果待确认".into()
        } else if !panel.state["configured"].is_boolean() || panel.stale {
            "服务器状态待确认".into()
        } else if configured {
            let status = panel.status_label();
            let host = text(&panel.state, "server");
            let status = if cached {
                format!("上次状态：{status}")
            } else {
                status.into()
            };
            if host.is_empty() {
                status
            } else {
                format!("{status} · {host}")
            }
        } else {
            "尚未接入服务器".into()
        };
        let connect = (panel.connection_destination() == Page::Connect).then(|| {
            if panel.state["connectionRecovery"].is_object() {
                "继续接入…"
            } else {
                "接入服务器…"
            }
        });
        let harnesses = panel.state["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|provider| {
                let name = provider_name(provider);
                let status = panel.installation_label(provider);
                let label = match (status, yes(provider, "experimental")) {
                    ("已安装", true) => format!("{name} · 实验"),
                    ("已安装", false) => name,
                    _ => format!("{name} · {status}"),
                };
                (text(provider, "key"), label)
            })
            .collect();
        Self {
            status,
            connect,
            attention: panel.attention().map(|attention| attention.title),
            harnesses,
            can_quit: !panel.mutating,
        }
    }

    pub fn menu(&self) -> Menu {
        let menu = Menu::new();
        let row = |id, label, enabled| MenuItem::with_id(id, label, enabled, None);
        menu.append(&row("dock-status-label", self.status.as_str(), false))
            .expect("status menu");
        if let Some(label) = self.connect {
            menu.append(&row(CONNECT, label, true))
                .expect("connection menu");
        }
        if let Some(label) = self.attention {
            menu.append(&row(ATTENTION, label, true))
                .expect("attention menu");
        }
        if !self.harnesses.is_empty() {
            menu.append(&PredefinedMenuItem::separator())
                .expect("harness menu");
            for (key, label) in &self.harnesses {
                menu.append(&MenuItem::with_id(
                    format!("{PROVIDER}{key}"),
                    label,
                    true,
                    None,
                ))
                .expect("harness menu item");
            }
        }
        menu.append_items(&[
            &PredefinedMenuItem::separator(),
            &row(OVERVIEW, "打开主窗口", true),
            &row(SETTINGS, "设置…", true),
            &row(QUIT, "退出界面", self.can_quit),
        ])
        .expect("window menu");
        menu
    }
}

impl Panel {
    pub fn refresh_tray_snapshot(&mut self, cx: &mut gpui_kit::Context<Self>) {
        // A click on the status item may be delivered after AppKit closes its
        // menu. Keep the hidden window idle; refresh once for the next opening.
        if self.can_handle_open()
            && (!self.visible || self.stale)
            && self.refreshed.elapsed().as_secs() >= 2
        {
            self.refresh(cx);
        }
    }

    pub fn tray_attention_destination(&mut self) -> Page {
        if self.attention().is_some_and(|attention| attention.warning) {
            Page::Settings
        } else {
            Page::Home
        }
    }
}
