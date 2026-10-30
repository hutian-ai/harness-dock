import Foundation

struct DeviceState: Decodable {
    var configured = false
    var managed: Bool?
    var externalInstallation: Bool?
    var running: Bool?
    var connected: Bool?
    var server: String?
    var cwd: String?
    var nodeId: String?
    var daemonId: String?
    var autostart: Bool?
    var canRollback: Bool?
    var appVersion: String?
    var installedVersion: String?
    var appReleaseId: String?
    var installedReleaseId: String?
    var runningReleaseId: String?
    var releaseMatchesApp: Bool?
    var updateAvailable: Bool?
    var active: Int?
    var unresolved: Int?
    var connectionIssue: String?
    var selfTest: SelfTestSnapshot?
    var providers: [ProviderInstallation]?
    var selfTests: [SelfTestSnapshot]?
    var selfTestProviders: [String]?
    var acceptedSelfTestId: String?
    var acceptedSelfTestProvider: String?
    var selfTestReceipt: SelfTestReceipt?
}
struct ProviderInstallation: Decodable, Identifiable {
    let key: String
    let displayName: String
    let status: String
    let selfTestSupported: Bool
    let version: String?
    let source: String?
    let executable: String?
    let home: String?
    let selfTestKind: String?
    let acceptanceCommand: String?
    let acceptanceDescription: String?
    let experimental: Bool?
    var id: String { key }
}
struct SelfTestReceipt: Decodable {
    let id: String
    let found: Bool
    let provider: String?
    var providerKey: String { provider ?? "codex" }
}
struct SelfTestSnapshot: Decodable {
    let id: String
    let runId: String
    let daemonId: String
    let state: String
    let phase: String
    let startedAt: Double
    let finishedAt: Double?
    let model: String?
    let code: String?
    let provider: String?
    var providerKey: String { provider ?? "codex" }
}
struct PairingPreview: Decodable { let server: String; let nodeId: String }
struct FoundDevice: Decodable, Identifiable {
    let configPath: String
    let server: String
    let folder: String
    let running: Bool
    let connected: Bool
    var id: String { configPath }
}
struct FoundDevices: Decodable { let devices: [FoundDevice]; let incomplete: Bool }
struct Check: Decodable, Identifiable {
    let check: String
    let state: String
    var id: String { check }
}
struct Checks: Decodable { let checks: [Check] }
struct LogOutput: Decodable { let text: String }
struct HelperResponse<T: Decodable>: Decodable {
    let ok: Bool
    let value: T?
    let error: String?
}
struct PanelFailure: LocalizedError {
    let code: String
    var errorDescription: String? {
        switch code {
        case "setup_identity_conflict": return "这里已有另一份设备配置，已保留。请重新检测已有设备，或在高级设置中导入原配置。"
        case "invalid_device_pairing", "pairing_required": return "这不是有效的连接邀请文件。请向服务管理员领取邀请链接；旧文件可在高级设置中导入。"
        case "invalid_invitation": return "邀请链接不完整或地址无效。请复制服务管理员提供的完整链接。"
        case "invitation_expired": return "邀请已过期，请向服务管理员领取新链接。"
        case "invitation_unavailable": return "邀请已过期、已领取或已撤销。请向服务管理员领取新链接。"
        case "invitation_claim_unconfirmed": return "尚未确认邀请领取结果。请先刷新设备状态；若仍未接入，请管理员生成新邀请，不要重复提交旧链接。"
        case "legacy_service_unverified", "legacy_owner_still_running", "legacy_service_changed": return "旧后台服务尚未确认安全退役，已保留原配置。请刷新状态后检查本地日志。"
        case "device_busy": return "设备正在执行任务，请结束后再操作。"
        case "unresolved_execution": return "有执行结果待核对。请查看原本机检查记录，或回到发起应用查询原任务，再维护设备。"
        case "self_test_unsupported": return "当前设备后台不支持一键测试。请先更新设备后台，再重新测试。"
        case "self_test_storage_unavailable": return "无法保存测试记录，尚未确认测试已启动。请检查本地状态目录后刷新状态。"
        case "self_test_id_conflict": return "此测试记录已存在。请刷新查看原测试结果，不会重复发送请求。"
        case "installation_config_mismatch": return "设备使用其他安装位置。请通过原安装入口维护，或联系部署者确认配置。"
        case "installation_inspection_unavailable": return "无法确认已有后台的安装位置。请通过原安装入口维护，或联系部署者检查本机设备配置。"
        case "device_not_installed": return "这是源码启动或自定义安装的设备。可以查看状态与诊断；请通过原安装入口进行维护。"
        case "installation_busy": return "另一个安装或维护操作正在进行，请稍后刷新状态。"
        case "invalid_config_file_permissions": return "设备配置必须归当前用户所有，且仅当前用户可读写。请检查文件权限。"
        case "file_not_found": return "所选文件或目录已不存在，请重新选择。"
        case "no_previous_release": return "暂时没有可以回滚的上一版本。"
        case "activation_failed_previous_restored": return "新版本未能启动，已确认恢复原版本。"
        case "activation_failed_recovery_unconfirmed": return "版本切换失败，恢复尚未确认。请查看状态和本地日志。"
        case "release_integrity_mismatch", "release_platform_mismatch", "incompatible_release_format": return "运行包校验失败或与此设备不兼容，未切换版本。请重新取得可信安装包。"
        case "helper_timeout": return "操作等待超时，结果尚未确认。请刷新状态并查看日志，再决定下一步。"
        case "helper_unavailable": return "应用的运行文件不完整，请重新构建或取得完整的 Harness Dock.app。"
        default: return "操作未完成，原有设备数据已保留。请刷新状态，或查看本地日志进一步诊断。"
        }
    }
}

/// One helper process per operation; only the daemon CLI owns installation and control semantics.
struct DaemonBridge {
    let resources: URL
    func call<T: Decodable>(_ operation: String, config: String, fields: [String: Any] = [:], as: T.Type) async throws -> T {
        let node = resources.appendingPathComponent("daemon/runtime/node")
        let cli = resources.appendingPathComponent("daemon/dist/panel-cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            throw PanelFailure(code: "helper_unavailable")
        }
        var request = fields
        request["operation"] = operation
        request["config"] = config
        let input = try JSONSerialization.data(withJSONObject: request)
        let readOnly = ["status", "test-status", "discover", "pairing", "invitation", "doctor", "logs"].contains(operation)
        let bytes = try await run(node: node, cli: cli, input: input, readOnly: readOnly)
        guard let response = try? JSONDecoder().decode(HelperResponse<T>.self, from: bytes) else { throw PanelFailure(code: "management_failed") }
        guard response.ok, let value = response.value else { throw PanelFailure(code: response.error ?? "management_failed") }
        return value
    }
    private func run(node: URL, cli: URL, input: Data, readOnly: Bool) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process(), output = Pipe(), stdin = Pipe()
                process.executableURL = node
                process.arguments = [cli.path]
                process.standardInput = stdin
                process.standardOutput = output
                process.standardError = FileHandle.nullDevice
                // Keep native environment discovery; never import unrelated shell credentials into the helper.
                let allowed = ["HOME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME", "CODEX_CLI_PATH", "DSH_HOME", "NVM_DIR"]
                process.environment = ProcessInfo.processInfo.environment.filter { allowed.contains($0.key) }
                let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
                do {
                    try process.run()
                    // A UI deadline must never interrupt an installation or owner mutation halfway through.
                    // These operations complete under the daemon's existing locks and control boundaries.
                    if readOnly { DispatchQueue.global().asyncAfter(deadline: .now() + 120, execute: timeout) }
                    try stdin.fileHandleForWriting.write(contentsOf: input)
                    try stdin.fileHandleForWriting.close()
                    // Helper responses contain at most 32 KiB of log plus bounded management fields.
                    var data = Data()
                    while let chunk = try output.fileHandleForReading.read(upToCount: 8192), !chunk.isEmpty {
                        data.append(chunk)
                        if data.count > 262_144 { process.terminate(); throw PanelFailure(code: "management_failed") }
                    }
                    process.waitUntilExit()
                    timeout.cancel()
                    if process.terminationReason == .uncaughtSignal { throw PanelFailure(code: "helper_timeout") }
                    continuation.resume(returning: data)
                } catch {
                    timeout.cancel()
                    if process.isRunning { process.terminate() }
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
