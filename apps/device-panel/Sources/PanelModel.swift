import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class PanelModel: ObservableObject {
    @Published var device = DeviceState()
    @Published var pairing: PairingPreview?
    @Published var pairingURL: URL?
    @Published var invitationInput = ""
    private var invitationLink: String?
    @Published var workURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("harness-work")
    @Published var caURL: URL?
    @Published var busy = false
    @Published var busyMessage: String?
    @Published var loading = true
    @Published var error: String?
    @Published var refreshError: String?
    @Published var notice: String?
    @Published var checks: [Check] = []
    @Published var logs: String?
    @Published var showDetails = false
    @Published var resumeSetup = false
    @Published var scanning = false
    @Published var discovered: [FoundDevice] = []
    @Published var discoveryIncomplete = false
    @Published var showInvitationHelp = false
    @Published var showVerification = false
    @Published var copiedTestCommand = false
    @Published private(set) var pendingSelfTestId: String?
    @Published var copiedInvitationRequest = false
    @Published var connectingNew = false
    @Published var configPath: String
    var visible = true
    let bridge: DaemonBridge
    private let preferences: URL
    private let persistSelection: Bool
    private var refreshInProgress = false
    private var didScan = false

    init(resources: URL, configOverride: String? = nil) {
        bridge = DaemonBridge(resources: resources)
        let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".harness-dock/.local")
        preferences = home.appendingPathComponent("panel.json")
        persistSelection = configOverride == nil
        let saved = (try? Data(contentsOf: preferences)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        configPath = configOverride ?? saved?["config"] ?? home.appendingPathComponent("device/config.json").path
    }
    var selfTestRunning: Bool { device.selfTest.map { $0.state == "running" || $0.phase != "finished" } ?? false }
    var selfTestStartUnconfirmed: Bool { pendingSelfTestId != nil && pendingSelfTestId != device.selfTest?.id }
    var maintenanceBlocked: Bool { refreshError != nil || selfTestRunning || selfTestStartUnconfirmed || (device.active ?? 0) > 0 || (device.unresolved ?? 0) > 0 }
    var canStartSelfTest: Bool { !busy && device.running == true && !maintenanceBlocked }
    var selfTestButtonTitle: String { selfTestRunning ? "测试中…" : selfTestStartUnconfirmed ? "等待确认…" : "测试 Codex" }
    var selfTestIsHistorical: Bool {
        guard let testedDaemon = device.selfTest?.daemonId, let currentDaemon = device.daemonId else { return false }
        return testedDaemon != currentDaemon
    }
    var selfTestTitle: String {
        if selfTestStartUnconfirmed { return busy ? "正在启动测试" : "测试启动结果待核对" }
        guard let test = device.selfTest else { return "尚未测试 Codex" }
        switch test.state {
        case "running": return "正在测试 Codex"
        case "passed": return selfTestIsHistorical || refreshError != nil ? "上次测试：本机 Codex 可用" : "本机 Codex 可用"
        case "unknown": return "测试结果待核对"
        default: return test.code == "self_test_read_only_unavailable" ? "暂时无法安全验证" : "本次测试未通过"
        }
    }
    var selfTestDetail: String {
        if selfTestStartUnconfirmed { return busy ? "正在交给设备后台处理，请稍候。" : "请刷新查看原测试记录；不会自动重新发送模型请求。" }
        guard let test = device.selfTest else { return "点击后会实际调用一次模型并使用账户额度。" }
        if test.state == "running" { return test.phase == "executing" ? "正在向本机 Codex 发送只读回显请求，等待真实完成。" : "正在检查 Codex 安装、登录与只读执行环境。" }
        if test.state == "passed" {
            if refreshError != nil { return "模型已通过上次测试，当前设备状态尚未刷新。" }
            if selfTestIsHistorical { return "这是后台重启前的测试结果。可重新测试确认当前状态。" }
            return device.connected == true ? "模型已完成只读回显，设备连接正常。" : "模型执行正常；远程使用还需要恢复设备连接。"
        }
        switch test.code {
        case "self_test_read_only_unavailable": return "当前原生环境未提供已确认的只读模式，未发送模型请求。请更新 Codex 后重试。"
        case "self_test_provider_unavailable": return "Codex 环境尚未就绪。请在此 Mac 安装并登录 Codex，再运行诊断。"
        case "self_test_model_unavailable": return "当前没有可用模型。请检查本机 Codex 的登录、模型权限与账户状态。"
        case "self_test_answer_mismatch": return "模型已返回，但未通过回显核对。请查看本地日志后重新测试。"
        case "self_test_unexpected_tool": return "测试中出现了预期之外的工具活动，未判定为可用。请查看本地日志。"
        case "self_test_permission_requested": return "只读测试出现了额外权限请求，已拒绝。请检查 Codex 环境。"
        case "self_test_timed_out": return "等待模型完成超时。请先查看原测试记录，不要把超时当作已取消。"
        case "self_test_interrupted": return "设备后台在测试中重启。原请求未被自动重发，请先诊断并核对原记录。"
        case "self_test_storage_unavailable": return "无法确认测试记录已保存。请检查本地状态目录并查看日志。"
        default: return test.state == "unknown" ? "尚未取得足够的完成证据。请运行诊断并核对原测试记录。" : "未能确认模型可用。请先运行诊断，按提示检查本机环境。"
        }
    }
    var selfTestColor: Color {
        if selfTestStartUnconfirmed || device.selfTest?.state == "unknown" || device.selfTest?.state == "failed" { return .orange }
        if device.selfTest?.state == "passed" && !selfTestIsHistorical && refreshError == nil { return .teal }
        return .secondary
    }
    var selfTestCheckedAt: String? {
        guard let test = device.selfTest, !selfTestStartUnconfirmed else { return nil }
        return Date(timeIntervalSince1970: (test.finishedAt ?? test.startedAt) / 1000).formatted(.dateTime.month().day().hour().minute())
    }
    var statusTitle: String {
        if loading { return "正在读取设备" }
        if refreshError != nil { return "状态暂不可用" }
        if !device.configured { return "接入这台 Mac" }
        if (device.unresolved ?? 0) > 0 { return "有执行结果待核对" }
        if device.running != true { return "设备已停止" }
        if device.connectionIssue != nil { return "设备连接需检查" }
        if device.connected != true { return "正在等待连接" }
        return "设备已连接"
    }
    var statusDetail: String {
        if refreshError != nil { return "未能读取最新状态，请刷新或打开诊断。" }
        if (device.unresolved ?? 0) > 0 { return device.selfTest?.state == "unknown" ? "本机测试结果尚未确认，请查看测试详情并运行诊断。" : "请回到发起应用查询原执行记录，核对结果。" }
        if device.running != true { return "启动设备后，应用才能使用这台 Mac 的 Codex。" }
        if device.connected != true { return "后台已启动，尚未连接到服务。" }
        if selfTestRunning { return "正在进行本机可用性测试，结果将在这里显示。" }
        return (device.active ?? 0) > 0 ? "正在处理应用发起的执行，进度与结果请在应用中查看。" : "当前空闲，可测试 Codex 或等待应用发起执行。"
    }
    var statusColor: Color {
        if refreshError != nil || device.connectionIssue != nil || (device.unresolved ?? 0) > 0 { return .orange }
        return device.connected == true ? .teal : .secondary
    }
    func load() async {
        await refresh()
        if !device.configured && !didScan { await scanDevices() }
    }
    func scanDevices() async {
        guard !busy, !scanning else { return }
        scanning = true; didScan = true
        defer { scanning = false }
        do {
            let found = try await bridge.call("discover", config: configPath,
                fields: ["selectedOnly": !persistSelection], as: FoundDevices.self)
            discovered = found.devices; discoveryIncomplete = found.incomplete
        } catch { discoveryIncomplete = true }
    }
    func refresh() async {
        guard !busy, !refreshInProgress else { return }
        refreshInProgress = true
        defer { refreshInProgress = false; loading = false }
        let selectedConfig = configPath
        do {
            let state = try await readDeviceState(config: selectedConfig)
            if !busy && configPath == selectedConfig { device = state; refreshError = nil; confirmSelfTestStart() }
        }
        catch { if !busy && configPath == selectedConfig { refreshError = error.localizedDescription } }
    }
    func choosePairing() {
        let panel = NSOpenPanel()
        panel.title = "选择 Dock 服务提供的连接邀请（JSON）"
        panel.message = "连接邀请由服务端管理员导出；原 device-pairing.json 可以直接使用。"
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            busy = true; busyMessage = "正在检查连接邀请…"; error = nil; pairing = nil; pairingURL = nil
            invitationLink = nil
            defer { busy = false; busyMessage = nil }
            do {
                pairing = try await bridge.call("pairing", config: configPath, fields: ["pairing": url.path], as: PairingPreview.self)
                pairingURL = url
            } catch { self.error = error.localizedDescription }
        }
    }
    func pasteInvitation() {
        guard let link = NSPasteboard.general.string(forType: .string), !link.isEmpty else {
            error = "剪贴板里没有邀请链接。请先复制服务管理员提供的链接。"; return
        }
        invitationInput = link
        receiveInvitation(link)
    }
    func previewInvitation() { receiveInvitation(invitationInput) }
    func receiveInvitation(_ link: String) {
        guard !busy else { error = "当前操作尚未完成，请完成后重新打开邀请链接。"; return }
        let selected = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard selected.utf8.count <= 4096 else { error = PanelFailure(code: "invalid_invitation").localizedDescription; return }
        perform("正在读取连接邀请…") {
            let preview = try await self.bridge.call("invitation", config: self.configPath,
                fields: ["invitation": selected], as: PairingPreview.self)
            self.pairing = preview; self.invitationLink = selected; self.pairingURL = nil
            self.invitationInput = ""; self.resumeSetup = true; self.connectingNew = true
            self.loading = false
            self.notice = nil
        }
    }
    func clearInvitation() { pairing = nil; pairingURL = nil; invitationLink = nil; invitationInput = "" }
    func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.title = "选择 Codex 的工作目录"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.canCreateDirectories = true
        panel.directoryURL = workURL
        if panel.runModal() == .OK, let url = panel.url { workURL = url }
    }
    func chooseCA() {
        let panel = NSOpenPanel()
        panel.title = "选择服务器的可信 CA 证书"
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK { caURL = panel.url }
    }
    func adopt() {
        let panel = NSOpenPanel()
        panel.title = "手动导入已有设备配置"
        panel.message = "选择原 Daemon 的 config.json。自动检测未找到自定义安装时，才需要手动导入。"
        panel.allowedContentTypes = [.json]; panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = URL(fileURLWithPath: configPath).deletingLastPathComponent()
        guard panel.runModal() == .OK, let url = panel.url else { return }
        useDevice(url.path)
    }
    func useDevice(_ path: String) {
        perform {
            let state = try await self.bridge.call("status", config: path, as: DeviceState.self)
            guard state.configured else { throw PanelFailure(code: "file_not_found") }
            self.configPath = path; self.device = state; self.checks = []; self.clearInvitation(); self.refreshError = nil
            self.pendingSelfTestId = nil
            self.resumeSetup = false; self.connectingNew = false
            try self.saveSelection()
        }
    }
    func copyInvitationRequest() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("请为我的 Mac 生成一条 Harness Dock 连接邀请链接，并确认此设备已授权给应用、服务器已加载配置。如果使用私有 CA，也请提供 CA 证书。", forType: .string)
        copiedInvitationRequest = true
    }
    func setup() {
        guard pairingURL != nil || invitationLink != nil else { return }
        perform("正在安装并连接。首次安装需要复制运行文件，可能需要几分钟，请稍候。") {
            // The default directory is created only after the user explicitly chooses to connect.
            try FileManager.default.createDirectory(at: self.workURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            var fields: [String: Any] = ["cwd": self.workURL.path]
            if let link = self.invitationLink { fields["invitation"] = link }
            else if let file = self.pairingURL { fields["pairing"] = file.path }
            if let caURL = self.caURL { fields["caFile"] = caURL.path }
            self.device = try await self.bridge.call("setup", config: self.configPath, fields: fields, as: DeviceState.self)
            self.refreshError = nil
            try self.saveSelection()
            self.pairingURL = nil; self.pairing = nil
            self.invitationLink = nil
            self.resumeSetup = false
            self.notice = "设备后台已启动。点击“测试 Codex”即可验证本机模型执行。"
        }
    }
    func continueSetup() {
        action("install")
    }
    func startSelfTest() {
        guard canStartSelfTest else { return }
        let id = UUID().uuidString.lowercased()
        pendingSelfTestId = id
        perform("正在启动本机可用性测试…") {
            do {
                self.device = try await self.bridge.call("test", config: self.configPath, fields: ["testId": id], as: DeviceState.self)
                self.refreshError = nil
                self.confirmSelfTestStart()
            } catch {
                // Only explicit pre-admission rejections clear the pending receipt. Never retry a lost POST.
                if let failure = error as? PanelFailure,
                   ["self_test_unsupported", "self_test_id_conflict", "self_test_storage_unavailable", "device_busy", "unresolved_execution", "device_not_running"].contains(failure.code) {
                    self.pendingSelfTestId = nil
                }
                throw error
            }
        }
    }
    private func confirmSelfTestStart() {
        guard let pending = pendingSelfTestId else { return }
        if device.acceptedSelfTestId == pending || device.selfTest?.id == pending
            || device.selfTestReceipt?.id == pending && device.selfTestReceipt?.found == true {
            pendingSelfTestId = nil; error = nil
        } else if device.selfTestReceipt?.id == pending && device.selfTestReceipt?.found == false {
            pendingSelfTestId = nil; error = nil
            notice = "原测试未启动，可点击“测试 Codex”重新发起。"
        }
    }
    private func readDeviceState(config: String) async throws -> DeviceState {
        if let pending = pendingSelfTestId {
            return try await bridge.call("test-status", config: config, fields: ["testId": pending], as: DeviceState.self)
        }
        return try await bridge.call("status", config: config, as: DeviceState.self)
    }
    func copyTestCommand() {
        guard let nodeId = device.nodeId, UUID(uuidString: nodeId) != nil else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("pnpm client test /private/client.json --node-id \(nodeId)", forType: .string)
        copiedTestCommand = true
    }
    func action(_ operation: String, fields: [String: Any] = [:]) {
        let message = ["install": "正在迁移后台。首次安装需要复制运行文件，可能需要几分钟，请稍候。",
                       "upgrade": "正在更新后台，请稍候。", "rollback": "正在恢复上一程序版本，请稍候。",
                       "start": "正在启动设备…", "stop": "正在停止空闲设备…",
                       "autostart": "正在保存登录自启设置…"][operation] ?? "正在处理…"
        perform(message) {
            self.device = try await self.bridge.call(operation, config: self.configPath, fields: fields, as: DeviceState.self)
            self.refreshError = nil
            self.notice = ["stop": "设备已停止。需要使用时，可在这里重新启动。", "start": "设备后台已启动，正在连接服务。",
                           "install": "设备已由此应用管理，原设备身份和执行记录已保留。", "upgrade": "设备程序已更新。", "rollback": "设备程序已回滚。",
                           "autostart": "登录自启设置已保存。" ][operation]
        }
    }
    func diagnose() {
        perform("正在检查连接与本机环境，不会调用模型…") {
            let result = try await self.bridge.call("doctor", config: self.configPath, as: Checks.self)
            self.checks = result.checks
            self.notice = "诊断完成，未发送模型请求。"
        }
    }
    func readLogs() {
        perform {
            let result = try await self.bridge.call("logs", config: self.configPath, as: LogOutput.self)
            self.logs = result.text
        }
    }
    private func perform(_ message: String = "正在处理…", _ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; busyMessage = message; error = nil; notice = nil
        Task {
            defer { busy = false; busyMessage = nil }
            do { try await operation() }
            catch {
                self.error = error.localizedDescription
                // Maintenance can finish partially; always read the original identity back without retrying mutations.
                do {
                    device = try await readDeviceState(config: configPath); refreshError = nil
                    confirmSelfTestStart()
                    // A consumed invitation may already have saved the identity. Continue from that identity even after expiry.
                    if resumeSetup, let preview = pairing, device.configured, preview.nodeId == device.nodeId {
                        clearInvitation(); resumeSetup = false; connectingNew = false
                        notice = "设备身份已保存。可使用此应用管理，继续完成安装，无需再次领取邀请。"
                    }
                }
                catch { refreshError = error.localizedDescription }
            }
        }
    }
    private func saveSelection() throws {
        guard persistSelection else { return }
        try FileManager.default.createDirectory(at: preferences.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(["config": configPath])
        try data.write(to: preferences, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preferences.path)
    }
}
