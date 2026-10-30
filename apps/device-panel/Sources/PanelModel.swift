import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class PanelModel: ObservableObject {
    @Published var device = DeviceState() { didSet { reconcileProviderSelection() } }
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
    @Published private(set) var pendingSelfTestProvider: String?
    @Published private(set) var selfTestFeedbackProvider: String?
    @Published private(set) var selectedProvider: String
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
        let saved = configOverride == nil
            ? (try? Data(contentsOf: preferences)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
            : nil
        configPath = configOverride ?? saved?["config"] ?? home.appendingPathComponent("device/config.json").path
        selectedProvider = saved?["provider"] ?? ""
    }
    var providerChoices: [ProviderInstallation] { device.providers ?? [] }
    var installedProviderCount: Int { providerChoices.filter { $0.status == "installed" }.count }
    var harnessSummaryTitle: String {
        guard device.providers != nil else { return "Harness 检测待确认" }
        if providerChoices.contains(where: { !["installed", "not_found", "disabled"].contains($0.status) }) && installedProviderCount == 0 {
            return "Harness 检测待确认"
        }
        return "\(refreshError == nil ? "已检测到" : "上次检测到") \(installedProviderCount) 个 Harness"
    }
    var harnessSummaryDetail: String? {
        if refreshError != nil { return "当前状态尚未刷新，保留上次检测结果。" }
        guard device.providers != nil else { return "刷新状态后查看本机支持的 Harness。" }
        if providerChoices.contains(where: { !["installed", "not_found", "disabled"].contains($0.status) }) { return "部分安装状态待确认，可刷新或运行诊断。" }
        if installedProviderCount == 0 { return "请在这台 Mac 安装并登录受支持的原生 Harness。" }
        return nil
    }
    var selectedInstallation: ProviderInstallation? { providerChoices.first(where: { $0.key == selectedProvider }) }
    var selectedProviderName: String { selectedInstallation?.displayName ?? (selectedProvider == "codex" ? "Codex" : selectedProvider.isEmpty ? "原生 Harness" : selectedProvider) }
    var selectedReadOnlyEcho: Bool { selectedInstallation?.selfTestKind == "read-only-echo" }
    var selectedAcceptanceCommand: String? {
        guard let command = selectedInstallation?.acceptanceCommand, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return command
    }
    var selectedAcceptanceDescription: String? { selectedInstallation?.acceptanceDescription }
    private func reconcileProviderSelection() {
        guard !providerChoices.contains(where: { $0.key == selectedProvider }) else { return }
        let next = pendingSelfTestProvider ?? providerChoices.first(where: { $0.status == "installed" })?.key
            ?? providerChoices.first?.key ?? allSelfTests.max { $0.startedAt < $1.startedAt }?.providerKey ?? ""
        guard next != selectedProvider else { return }
        selectedProvider = next; copiedTestCommand = false
        do { try saveSelection() } catch { self.error = error.localizedDescription }
    }
    func installationLabel(_ provider: ProviderInstallation) -> String {
        "\(provider.displayName)（\(installationStatus(provider))）"
    }
    func installationStatus(_ provider: ProviderInstallation) -> String { ["installed": "已安装", "not_found": "未发现", "disabled": "已禁用"][provider.status] ?? "待确认" }
    var selectedProviderSelfTestSupported: Bool {
        selectedInstallation?.selfTestSupported == true && (device.selfTestProviders?.contains(selectedProvider) ?? false)
    }
    var selectedProviderDetail: String {
        guard let installation = selectedInstallation else { return "尚未读回可展示的本机环境。请刷新或运行诊断，不能据此判断模型可用。" }
        switch installation.status {
        case "installed":
            if let test = selectedSelfTest {
                if test.state == "passed" { return selfTestIsHistorical
                    ? "已安装，保留后台重启前的回显结果；需要时可重新检查。"
                    : "已安装，最近固定回显已通过。该结果仅代表本次模型回显。" }
                if test.state == "unknown" { return "已安装，原检查结果尚未确认。请核对原记录，不会自动重发。" }
                if test.state == "running" { return "已安装，固定回显检查正在后台进行。" }
                if test.state == "failed" { return "已安装，最近一次固定检查未通过；请查看原记录或运行诊断。" }
            }
            return selectedProviderSelfTestSupported
                ? "已发现本机安装。需要验证模型连接时，可运行一次固定回显检查。"
                : "已发现本机安装，当前后台尚未提供对应检查。请核对后台版本或运行诊断。"
        case "disabled": return "本机 \(selectedProviderName) 已在设备配置中禁用。"
        case "not_found": return "尚未发现本机 \(selectedProviderName) 安装。请安装并登录原生 Harness，或运行诊断。"
        default: return "尚未读回本机安装状态。请刷新或更新后台，不能据此判断模型可用。"
        }
    }
    var allSelfTests: [SelfTestSnapshot] {
        var tests = device.selfTests ?? []
        if let legacy = device.selfTest, !tests.contains(where: { $0.id == legacy.id && $0.providerKey == legacy.providerKey }) { tests.append(legacy) }
        return tests
    }
    func latestSelfTest(for provider: String) -> SelfTestSnapshot? {
        allSelfTests.filter { $0.providerKey == provider }.max { $0.startedAt < $1.startedAt }
    }
    var selectedSelfTest: SelfTestSnapshot? { latestSelfTest(for: selectedProvider) }
    private func isHistorical(_ test: SelfTestSnapshot) -> Bool {
        guard let currentDaemon = device.daemonId else { return true }
        return test.daemonId != currentDaemon
    }
    func rowTestLabel(_ provider: ProviderInstallation) -> String {
        if pendingSelfTestId != nil && pendingSelfTestProvider == provider.key { return busy ? "正在启动测试" : "启动结果待核对" }
        guard let test = latestSelfTest(for: provider.key) else { return "尚未测试" }
        if test.state == "running" || test.phase != "finished" { return refreshError == nil ? "测试进行中" : "测试状态待刷新" }
        let historical = refreshError != nil || isHistorical(test) || provider.status != "installed"
        switch test.state {
        case "passed": return historical ? "上次回显通过" : "最近回显通过"
        case "unknown": return "结果待核对"
        default: return historical ? "上次回显未通过" : "最近回显未通过"
        }
    }
    func rowTestColor(_ provider: ProviderInstallation) -> Color {
        if pendingSelfTestId != nil && pendingSelfTestProvider == provider.key { return busy ? .secondary : .orange }
        guard let test = latestSelfTest(for: provider.key) else { return .secondary }
        if test.state == "running" || test.phase != "finished" { return .secondary }
        if test.state == "unknown" || test.state == "failed" { return .orange }
        return test.state == "passed" && provider.status == "installed" && !isHistorical(test) && refreshError == nil ? PanelTheme.accent : .secondary
    }
    func rowTestSymbol(_ provider: ProviderInstallation) -> String? {
        if pendingSelfTestId != nil && pendingSelfTestProvider == provider.key { return busy ? "clock" : "exclamationmark.circle" }
        guard let test = latestSelfTest(for: provider.key) else { return nil }
        if test.state == "running" || test.phase != "finished" { return "clock" }
        return test.state == "passed" ? "checkmark.circle.fill" : "exclamationmark.circle"
    }
    var selfTestRunning: Bool { allSelfTests.contains { $0.state == "running" || $0.phase != "finished" } }
    var selectedSelfTestRunning: Bool { selectedSelfTest.map { $0.state == "running" || $0.phase != "finished" } ?? false }
    var selfTestStartUnconfirmed: Bool { pendingSelfTestId != nil }
    var selectedSelfTestStartUnconfirmed: Bool { pendingSelfTestId != nil && pendingSelfTestProvider == selectedProvider }
    var hasSelectedSelfTestFeedback: Bool { selfTestFeedbackProvider != nil && selfTestFeedbackProvider == selectedProvider }
    var canOpenProviderDetails: Bool { !loading && !busy && !providerChoices.isEmpty }
    func openProviderDetails(_ provider: String) {
        guard canOpenProviderDetails, providerChoices.contains(where: { $0.key == provider }) else { return }
        // Viewing another installation never changes the pending test owner or starts a new request.
        if provider != selectedProvider {
            selectedProvider = provider; copiedTestCommand = false; error = nil; notice = nil
            do { try saveSelection() } catch { self.error = error.localizedDescription }
        }
        showVerification = true
    }
    var maintenanceBlocked: Bool { refreshError != nil || selfTestRunning || selfTestStartUnconfirmed || (device.active ?? 0) > 0 || (device.unresolved ?? 0) > 0 }
    var maintenanceBlockReason: String? {
        if refreshError != nil { return "最新状态尚未读回，确认设备状态后才能维护后台。" }
        if selfTestStartUnconfirmed { return "本机检查启动结果待核对，请先查看原检查记录。" }
        if selfTestRunning { return "本机检查仍在运行，完成后才能维护后台。" }
        if (device.unresolved ?? 0) > 0 { return "有执行结果待核对，核对原记录后才能维护后台；不会自动重发任务。" }
        if (device.active ?? 0) > 0 { return "设备正在执行任务，完成后才能维护后台。" }
        return nil
    }
    var backgroundStateLabel: String { refreshError != nil ? "待确认" : device.running == true ? "运行中" : "已停止" }
    var connectionTitle: String {
        if loading { return "正在读取" }
        if refreshError != nil { return "待确认" }
        if !device.configured { return "未连接" }
        if device.running != true { return "后台已停止" }
        if device.connectionIssue != nil { return "连接需检查" }
        return device.connected == true ? "已连接" : "连接中"
    }
    var connectionDetail: String {
        if refreshError != nil { return "当前连接状态尚未读回，请刷新或运行诊断。" }
        if !device.configured { return "通过邀请连接服务，让应用使用这台 Mac 的原生 Harness。" }
        if device.running != true { return "启动后台后恢复服务连接。" }
        if device.connectionIssue == "configuration_mismatch" { return "后台连接与保存的服务配置不一致，请运行诊断核对。" }
        if device.connectionIssue != nil { return "请检查网络、服务地址与设备配对。" }
        if device.connected != true { return "后台正在等待连接服务。" }
        return "回到提供邀请的应用发起任务，进度、审批和结果会在那里显示。"
    }
    var connectionColor: Color {
        if refreshError != nil || device.connectionIssue != nil { return .orange }
        return device.running == true && device.connected == true ? PanelTheme.accent : .secondary
    }
    var canUpgradeBackground: Bool { device.managed == true && device.externalInstallation != true && device.updateAvailable == true }
    var backgroundVersionDetail: String {
        if device.externalInstallation == true { return "后台由其他安装入口管理，请通过原入口更新。" }
        if device.managed != true { return "后台尚未由此应用管理。" }
        if device.releaseMatchesApp == true { return "后台与此应用附带版本一致。" }
        if canUpgradeBackground { return "已安装后台与此应用附带版本不同，可显式更新。" }
        if device.releaseMatchesApp == false { return "运行中的后台版本需核对，请先运行诊断并查看原安装记录。" }
        return "后台版本尚未确认，请刷新或运行诊断。"
    }
    private var attentionSelfTest: SelfTestSnapshot? {
        let tests = allSelfTests.filter { $0.state != "passed" }
        return tests.first(where: { $0.state == "unknown" })
            ?? tests.first(where: { $0.state == "running" || $0.phase != "finished" })
            ?? tests.max { $0.startedAt < $1.startedAt }
    }
    var localTestNeedsAttention: Bool { selfTestStartUnconfirmed || attentionSelfTest != nil }
    var localTestNoticeTitle: String {
        if selfTestStartUnconfirmed { return "本机检查启动结果待核对" }
        guard let test = attentionSelfTest else { return "本机环境检查" }
        if test.state == "unknown" { return "本机检查结果待核对" }
        if test.state == "running" || test.phase != "finished" { return "本机环境检查进行中" }
        return "最近本机检查未通过"
    }
    var localTestNoticeDetail: String {
        if selfTestStartUnconfirmed { return "查看原检查的启动收据；不会自动重新调用模型。" }
        guard let test = attentionSelfTest else { return "按需检查本机安装与模型连接。" }
        if test.state == "unknown" { return "完成状态尚未确认。请查看原检查记录和本地诊断，保留原请求。" }
        if test.state == "running" || test.phase != "finished" { return "检查由设备后台持有，可在详情中查看进度。" }
        return "查看对应环境的检查记录，按提示排查安装或模型连接。"
    }
    func openLocalChecks() {
        if let provider = pendingSelfTestProvider ?? attentionSelfTest?.providerKey, provider != selectedProvider {
            selectedProvider = provider; copiedTestCommand = false
            do { try saveSelection() } catch { self.error = error.localizedDescription }
        }
        showVerification = true
    }
    var canStartSelfTest: Bool { !busy && device.running == true && !maintenanceBlocked && selectedInstallation?.status == "installed" && selectedProviderSelfTestSupported }
    var selfTestButtonTitle: String {
        if selectedSelfTestRunning { return "测试中…" }
        if selectedSelfTestStartUnconfirmed { return "等待确认…" }
        return "\(selectedSelfTest == nil ? "测试" : "重新测试") \(selectedProviderName)"
    }
    var selfTestDescription: String {
        selectedReadOnlyEcho
            ? "会实际调用一次模型并使用账户额度。测试使用原生确认的只读模式核对一次回显，不会授予额外工具权限。"
            : "会实际调用一次模型并使用账户额度。测试沿用 \(selectedProviderName) 的原生权限配置，仅核对固定回显；出现工具活动或额外审批不会判定通过。"
    }
    var selfTestScopeDetail: String {
        "通过只证明本次 \(selectedProviderName) 模型回显。设备连接单独显示；工具、应用授权、浏览器和插件需按实际用途分别验证。"
    }
    var selfTestIsHistorical: Bool {
        guard let test = selectedSelfTest else { return false }
        return isHistorical(test)
    }
    var selfTestTitle: String {
        if selectedSelfTestStartUnconfirmed { return busy ? "正在启动 \(selectedProviderName) 测试" : "\(selectedProviderName) 测试启动结果待核对" }
        guard let test = selectedSelfTest else { return "尚未测试 \(selectedProviderName)" }
        switch test.state {
        case "running": return "正在测试 \(selectedProviderName)"
        case "passed":
            let passed = "本机 \(selectedProviderName) 回显通过"
            return selfTestIsHistorical || refreshError != nil ? "上次测试：\(passed)" : passed
        case "unknown": return "测试结果待核对"
        default: return test.code == "self_test_read_only_unavailable" ? "暂时无法安全验证" : "本次测试未通过"
        }
    }
    var selfTestDetail: String {
        if selectedSelfTestStartUnconfirmed { return busy ? "正在交给设备后台处理，请稍候。" : "请刷新查看原 \(selectedProviderName) 测试记录；不会自动重新发送模型请求。" }
        guard let test = selectedSelfTest else { return selectedProviderDetail }
        if test.state == "running" {
            if test.phase == "executing" { return selectedReadOnlyEcho ? "正在向本机 \(selectedProviderName) 发送只读回显请求，等待真实完成。" : "正在向本机 \(selectedProviderName) 发送固定回显请求，等待真实完成。" }
            return selectedReadOnlyEcho ? "正在检查 \(selectedProviderName) 安装、登录与只读执行环境。" : "正在检查本机 \(selectedProviderName) 安装与模型环境，沿用原生权限配置。"
        }
        if test.state == "passed" {
            if refreshError != nil { return "模型已通过上次测试，当前设备状态尚未刷新。" }
            if selfTestIsHistorical { return "这是后台重启前的测试结果。可重新测试确认当前状态。" }
            if selectedReadOnlyEcho { return device.connected == true ? "本次原生只读回显通过，设备连接正常。工具和应用授权需分别验证。" : "本次原生只读回显通过；远程使用还需要恢复设备连接。" }
            return device.connected == true ? "本次固定回显通过，设备连接正常。工具和应用授权需分别验证。" : "本次固定回显通过；远程使用还需要恢复设备连接。"
        }
        switch test.code {
        case "self_test_read_only_unavailable": return selectedReadOnlyEcho
            ? "当前原生环境未提供已确认的只读模式，未发送模型请求。请更新 \(selectedProviderName) 后重试。"
            : "当前后台无法确认本次回显测试所需的执行条件，未发送模型请求。请更新后台并运行诊断。"
        case "self_test_provider_unavailable": return "\(selectedProviderName) 环境尚未就绪。请在此 Mac 安装并登录 \(selectedProviderName)，再运行诊断。"
        case "self_test_model_unavailable": return "当前没有可用模型。请检查本机 \(selectedProviderName) 的登录、模型权限与账户状态。"
        case "self_test_answer_mismatch": return "模型已返回，但未通过回显核对。请查看本地日志后重新测试。"
        case "self_test_unexpected_tool": return "测试中出现了预期之外的工具活动，未判定为可用。请查看本地日志。"
        case "self_test_permission_requested": return "固定回显测试出现了额外权限请求，已拒绝。请检查 \(selectedProviderName) 环境。"
        case "self_test_timed_out": return "等待模型完成超时。请先查看原测试记录，不要把超时当作已取消。"
        case "self_test_interrupted": return "设备后台在测试中重启。原请求未被自动重发，请先诊断并核对原记录。"
        case "self_test_storage_unavailable": return "无法确认测试记录已保存。请检查本地状态目录并查看日志。"
        default: return test.state == "unknown" ? "尚未取得足够的完成证据。请运行诊断并核对原测试记录。" : "未能确认模型可用。请先运行诊断，按提示检查本机环境。"
        }
    }
    var selfTestColor: Color {
        if selectedSelfTestStartUnconfirmed || selectedSelfTest?.state == "unknown" || selectedSelfTest?.state == "failed" { return .orange }
        if selectedSelfTest?.state == "passed" && !selfTestIsHistorical && refreshError == nil { return PanelTheme.accent }
        return .secondary
    }
    var selfTestCheckedAt: String? {
        guard let test = selectedSelfTest, !selectedSelfTestStartUnconfirmed else { return nil }
        return Date(timeIntervalSince1970: (test.finishedAt ?? test.startedAt) / 1000).formatted(.dateTime.month().day().hour().minute())
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
        guard !selfTestRunning, !selfTestStartUnconfirmed else { error = "本机测试尚未完成，请先查看原测试结果后再切换连接。"; return }
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
        panel.title = "选择原生 Harness 的工作目录"
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
        guard !busy, !selfTestRunning, !selfTestStartUnconfirmed else { return }
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
        guard !busy, !selfTestRunning, !selfTestStartUnconfirmed else { return }
        perform {
            let state = try await self.bridge.call("status", config: path, as: DeviceState.self)
            guard state.configured else { throw PanelFailure(code: "file_not_found") }
            self.configPath = path; self.device = state; self.checks = []; self.clearInvitation(); self.refreshError = nil
            self.clearPendingSelfTest()
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
            self.notice = "设备已接入，后台独立运行。可回到调用方应用发起任务，需要时再检查本机环境。"
        }
    }
    func continueSetup() {
        action("install")
    }
    func startSelfTest() {
        guard canStartSelfTest else { return }
        let id = UUID().uuidString.lowercased()
        let provider = selectedProvider
        pendingSelfTestId = id; pendingSelfTestProvider = provider
        perform("正在启动 \(selectedProviderName) 本机测试…", feedbackProvider: provider) {
            do {
                self.device = try await self.bridge.call("test", config: self.configPath, fields: ["testId": id, "provider": provider], as: DeviceState.self)
                self.refreshError = nil
                self.confirmSelfTestStart()
            } catch {
                // Only explicit pre-admission rejections clear the pending receipt. Never retry a lost POST.
                if let failure = error as? PanelFailure,
                   ["self_test_unsupported", "self_test_id_conflict", "self_test_storage_unavailable", "unsupported_provider", "invalid_self_test_provider", "device_busy", "unresolved_execution", "device_not_running"].contains(failure.code) {
                    self.clearPendingSelfTest()
                }
                throw error
            }
        }
    }
    private func clearPendingSelfTest() { pendingSelfTestId = nil; pendingSelfTestProvider = nil }
    private func confirmSelfTestStart() {
        guard let pending = pendingSelfTestId, let provider = pendingSelfTestProvider else { return }
        let matchingSnapshot = allSelfTests.contains { $0.id == pending && $0.providerKey == provider }
        let matchingReceipt = device.selfTestReceipt?.id == pending && device.selfTestReceipt?.providerKey == provider
        let matchingAcceptance = device.acceptedSelfTestId == pending && (device.acceptedSelfTestProvider ?? "codex") == provider
        if matchingAcceptance || matchingSnapshot || matchingReceipt && device.selfTestReceipt?.found == true {
            clearPendingSelfTest(); error = nil
        } else if matchingReceipt && device.selfTestReceipt?.found == false {
            clearPendingSelfTest()
            let name = providerChoices.first(where: { $0.key == provider })?.displayName ?? provider
            notice = "已确认 \(name) 测试未启动。"
        }
    }
    private func readDeviceState(config: String) async throws -> DeviceState {
        if let pending = pendingSelfTestId, let provider = pendingSelfTestProvider {
            return try await bridge.call("test-status", config: config, fields: ["testId": pending, "provider": provider], as: DeviceState.self)
        }
        return try await bridge.call("status", config: config, as: DeviceState.self)
    }
    func copyTestCommand() {
        guard let command = selectedAcceptanceCommand else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        copiedTestCommand = true
    }
    func action(_ operation: String, fields: [String: Any] = [:]) {
        guard !selfTestRunning, !selfTestStartUnconfirmed else { return }
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
    private func perform(_ message: String = "正在处理…", feedbackProvider: String? = nil, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        selfTestFeedbackProvider = feedbackProvider
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
        let data = try JSONEncoder().encode(["config": configPath, "provider": selectedProvider])
        try data.write(to: preferences, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: preferences.path)
    }
}
