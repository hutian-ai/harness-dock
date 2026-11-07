use serde_json::Value;

/// One interpretation of helper evidence for the window and the menu-bar status.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectionState {
    Unconfirmed,
    Unknown,
    Unconfigured,
    Stopped,
    Connecting,
    NeedsAttention,
    Connected,
}

impl ConnectionState {
    pub fn read(state: &Value, stale: bool, unconfirmed: bool) -> Self {
        if unconfirmed {
            Self::Unconfirmed
        } else if stale || !state["configured"].is_boolean() {
            Self::Unknown
        } else if state["configured"] != true {
            Self::Unconfigured
        } else if state["running"] != true {
            Self::Stopped
        } else if state["connectionIssue"].is_string() {
            Self::NeedsAttention
        } else if state["connected"] == true {
            Self::Connected
        } else {
            Self::Connecting
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Unconfirmed => "接入结果待确认",
            Self::Unknown => "状态待刷新",
            Self::Unconfigured => "尚未接入服务器",
            Self::Stopped => "连接已停止",
            Self::Connecting => "正在连接",
            Self::NeedsAttention => "连接需要检查",
            Self::Connected => "已连接",
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum ActivityState {
    Unknown,
    Known { active: u64, unresolved: u64 },
}

impl ActivityState {
    pub fn read(state: &Value) -> Self {
        match (
            state["activityKnown"] == true,
            state["active"].as_u64(),
            state["unresolved"].as_u64(),
        ) {
            (true, Some(active), Some(unresolved)) => Self::Known { active, unresolved },
            _ => Self::Unknown,
        }
    }

    pub fn idle(self) -> bool {
        matches!(
            self,
            Self::Known {
                active: 0,
                unresolved: 0
            }
        )
    }

    pub fn no_active(self) -> bool {
        matches!(self, Self::Known { active: 0, .. })
    }
}
