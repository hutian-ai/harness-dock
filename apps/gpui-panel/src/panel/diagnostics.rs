use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum DiagnosticOutcome {
    Connected,
    NeedsAttention(usize),
    Incomplete,
}

pub(super) struct DiagnosticCopy {
    pub label: &'static str,
    pub passed: &'static str,
    pub advice: &'static str,
}

pub(super) fn diagnostic_copy(key: &str) -> Option<DiagnosticCopy> {
    let (label, passed, advice) = match key {
        "configuration" => ("设备配置", "可读取", "检查设备配置文件及访问权限。"),
        "runtime" => (
            "运行组件",
            "可用",
            "应用运行组件不完整，请重新安装完整客户端。",
        ),
        "supported_device" => (
            "系统兼容性",
            "受支持",
            "当前发布支持 macOS Apple Silicon；Windows 仍需实机验收。",
        ),
        "workdir" => (
            "执行目录",
            "可访问",
            "检查执行目录是否存在，以及这台电脑是否允许访问。",
        ),
        "daemon" => ("本机后台", "正在运行", "回到概览启动连接服务。"),
        "daemon_configuration" => (
            "后台配置",
            "与当前设备一致",
            "后台使用的服务器与当前配置不同，请核对原连接。",
        ),
        "device_authentication" => (
            "服务器连接",
            "已连接",
            "尚未确认服务器接受了连接，请核对网络、服务器和配对状态。",
        ),
        "server_transport" | "server_health" => (
            "独立健康检查",
            "接口可访问",
            "部分服务器不提供此接口；这项检查不代替实际连接状态。",
        ),
        "device_protocol" => (
            "连接协议",
            "版本匹配",
            "请核对服务器和设备后台的版本是否兼容。",
        ),
        "codex_installation" => (
            "Codex 安装",
            "已检测到",
            "如需使用 Codex，请先完成原生安装和登录，再刷新。",
        ),
        "dsh_installation" => (
            "DeepSeek Harness 安装",
            "已检测到",
            "如需使用 DeepSeek Harness，请先完成原生安装和登录，再刷新。",
        ),
        "codex_proxy" => (
            "Codex 网络配置",
            "已读取",
            "未确认后台采用的网络配置；请检查 Codex 的网络和代理设置。",
        ),
        "dsh_proxy" => (
            "DeepSeek Harness 网络配置",
            "已读取",
            "未确认后台采用的网络配置；请检查 DeepSeek Harness 的网络和代理设置。",
        ),
        "native_installation" => (
            "Harness 安装",
            "已检测到",
            "尚未检测到可用安装，请安装需要使用的原生 Harness。",
        ),
        "native_auth_and_protocol" => (
            "模型响应测试",
            "已验证",
            "本次未发送模型请求。如需验证，在 Harness 详情中运行模型响应测试。",
        ),
        "unresolved_execution" => (
            "执行结果",
            "无需核对",
            "有执行结果待核对，请回到发起任务的应用处理；不要重复提交任务。",
        ),
        "device" => (
            "设备信息",
            "可读取",
            "无法读取设备信息，请检查设备配置和执行目录的访问权限。",
        ),
        _ => return None,
    };
    Some(DiagnosticCopy {
        label,
        passed,
        advice,
    })
}

/// Optional health probes and unperformed model tests must not become connection failures.
/// Missing required evidence must not become a green all-clear, either.
pub(super) fn diagnostic_outcome(checks: &[Value]) -> DiagnosticOutcome {
    let failures = checks
        .iter()
        .filter(|check| {
            check["state"] == "fail"
                && diagnostic_copy(check["check"].as_str().unwrap_or_default()).is_some()
        })
        .count();
    if failures > 0 {
        return DiagnosticOutcome::NeedsAttention(failures);
    }
    let required = [
        "configuration",
        "runtime",
        "supported_device",
        "workdir",
        "daemon",
        "daemon_configuration",
        "device_authentication",
    ];
    if required.iter().all(|key| {
        checks
            .iter()
            .any(|check| check["check"] == *key && check["state"] == "pass")
    }) {
        DiagnosticOutcome::Connected
    } else {
        DiagnosticOutcome::Incomplete
    }
}

#[cfg(test)]
mod tests {
    use super::{DiagnosticOutcome, diagnostic_outcome};
    use serde_json::{Value, json};

    fn connected() -> Vec<Value> {
        [
            "configuration",
            "runtime",
            "supported_device",
            "workdir",
            "daemon",
            "daemon_configuration",
            "device_authentication",
        ]
        .map(|key| json!({"check":key,"state":"pass"}))
        .to_vec()
    }

    #[test]
    fn unavailable_health_and_unperformed_model_test_do_not_negate_confirmed_connection() {
        let mut checks = connected();
        checks.extend([
            json!({"check":"server_health","state":"unknown"}),
            json!({"check":"native_auth_and_protocol","state":"unknown"}),
        ]);
        assert_eq!(diagnostic_outcome(&checks), DiagnosticOutcome::Connected);
    }

    #[test]
    fn absent_connection_evidence_does_not_report_success() {
        let mut checks = connected();
        checks.retain(|check| check["check"] != "device_authentication");
        assert_eq!(diagnostic_outcome(&checks), DiagnosticOutcome::Incomplete);
    }

    #[test]
    fn actual_failures_remain_actionable_but_unrecognized_checks_are_not_reinterpreted() {
        let mut checks = connected();
        checks.push(json!({"check":"future_check","state":"fail"}));
        assert_eq!(diagnostic_outcome(&checks), DiagnosticOutcome::Connected);
        checks.push(json!({"check":"unresolved_execution","state":"fail"}));
        assert_eq!(
            diagnostic_outcome(&checks),
            DiagnosticOutcome::NeedsAttention(1)
        );
    }
}
