import SwiftUI

struct PanelView: View {
    @ObservedObject var model: PanelModel
    let hide: () -> Void
    let quit: () -> Void
    @State private var maintenance = "upgrade"
    @State private var confirmMaintenance = false
    private let poll = Timer.publish(every: 5, on: .main, in: .common).autoconnect()
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if model.loading { ProgressView().frame(maxWidth: .infinity, minHeight: 170) }
                    else if model.device.configured && !model.resumeSetup && !(model.pairing != nil && model.device.managed != true) { device }
                    else { onboarding }
                    if let progress = model.busyMessage { message(progress, symbol: "clock", color: .secondary) }
                    if let error = model.refreshError { message(error, symbol: "arrow.clockwise", color: .orange) }
                    if let error = model.error { message(error, symbol: "exclamationmark.triangle", color: .orange) }
                    if let notice = model.notice { message(notice, symbol: "info.circle", color: .secondary) }
                }.padding(20)
            }
            Divider()
            footer
        }
        .frame(width: 400, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(.teal)
        .task { await model.load() }
        .onReceive(poll) { _ in if model.visible { Task { await model.refresh() } } }
        .confirmationDialog("确认维护设备", isPresented: $confirmMaintenance) {
            Button(maintenance == "rollback" ? "回滚程序版本" : "更新至此应用附带版本") {
                model.action(maintenance)
            }
            Button("取消", role: .cancel) { }
        } message: { Text("仅在设备空闲且没有待核对结果时切换。程序回滚不会撤销数据库变化或已发生的外部操作。") }
        .sheet(isPresented: $model.showVerification) { verification }
        .sheet(isPresented: Binding(get: { model.logs != nil }, set: { if !$0 { model.logs = nil } })) {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("本地设备日志").font(.headline); Spacer(); Button("关闭") { model.logs = nil } }
                Text("可能包含任务内容，请在分享前自行检查。").font(.caption).foregroundStyle(.secondary)
                ScrollView([.horizontal, .vertical]) {
                    Text(model.logs?.isEmpty == false ? model.logs! : "暂无日志").font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
            }.padding(20).frame(width: 620, height: 420)
        }
        .sheet(isPresented: $model.showInvitationHelp) {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("从哪里获取连接邀请？").font(.headline); Spacer(); Button("关闭") { model.showInvitationHelp = false } }
                Text("邀请由部署 Dock 服务的人提供，用来告诉这台 Mac 连接哪个服务、使用哪个设备身份。").font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                Text("请服务管理员生成连接邀请链接。打开链接并选择“在 Harness Dock 中打开”，或复制链接后在这里粘贴。若服务器由你部署，在服务器执行 invite 命令生成邀请。").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button(model.copiedInvitationRequest ? "已复制申请内容" : "复制邀请申请", action: model.copyInvitationRequest).buttonStyle(.borderedProminent)
                Link("查看服务端配对说明", destination: URL(string: "https://github.com/hutian-ai/harness-dock/blob/main/apps/docs-site/README.md#pairing")!).font(.system(size: 12))
                Text("已经接入过的 Mac 优先使用自动检测到的旧设备，无需再领取邀请。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(24).frame(width: 410)
        }
    }
    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 23, weight: .medium)).foregroundStyle(.teal)
            VStack(alignment: .leading, spacing: 2) {
                Text("Harness Dock").font(.system(size: 14, weight: .semibold))
                Text("这台 Mac 的连接与后台状态").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).help("刷新设备状态").accessibilityLabel("刷新设备状态").disabled(model.busy)
        }.padding(.horizontal, 20).padding(.vertical, 16)
    }
    private var onboarding: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 7) {
                Text("连接这台 Mac").font(.system(size: 23, weight: .semibold))
                Text("通过邀请连接服务，让应用使用这台 Mac 上的原生 Harness。").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if model.scanning {
                HStack(spacing: 10) { ProgressView().controlSize(.small); Text("正在检测这台 Mac 的已有连接…").font(.system(size: 12)).foregroundStyle(.secondary) }
            } else if !model.discovered.isEmpty && !model.connectingNew && model.pairing == nil {
                Text("发现已有设备，直接使用原连接").font(.system(size: 12, weight: .medium))
                VStack(spacing: 0) {
                    ForEach(model.discovered) { found in
                        Button { model.useDevice(found.configPath) } label: {
                            HStack(spacing: 11) {
                                Image(systemName: "desktopcomputer").font(.system(size: 20)).foregroundStyle(.teal)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(found.server).font(.system(size: 12, weight: .medium)).lineLimit(1).truncationMode(.middle)
                                    Text(found.connected ? "已连接 · 保留原设备身份" : found.running ? "后台运行中 · 等待连接" : "已有配置 · 可继续接入").font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 5)
                                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.secondary)
                            }.padding(14).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("使用已有设备 \(found.server)")
                    }
                }.background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                Text("不会重新配对，原任务记录和原生 Harness 登录继续保留。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("连接其他服务") { model.connectingNew = true }.buttonStyle(.link).font(.system(size: 12))
            } else {
                if let invitation = model.pairing {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("确认连接到此服务", systemImage: "link").font(.system(size: 12, weight: .medium)).foregroundStyle(.teal)
                        Text(invitation.server).font(.system(size: 17, weight: .medium)).lineLimit(2)
                        Text("连接后，该服务获授权的应用可以使用这台 Mac 上受支持的原生 Harness 执行任务。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button("更换邀请", action: model.clearInvitation).buttonStyle(.link).font(.system(size: 11))
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                    Button(action: model.setup) {
                        HStack { Spacer(); Text(model.busy ? "正在接入…" : "连接这台 Mac"); Image(systemName: "arrow.right"); Spacer() }.padding(.vertical, 5)
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                } else {
                    VStack(alignment: .leading, spacing: 9) {
                        Label("还没有连接到服务", systemImage: "desktopcomputer").font(.system(size: 13, weight: .medium))
                        Text("打开服务管理员发来的邀请链接，即可连接。已经复制链接？也可以在这里粘贴。").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                    TextField("邀请链接", text: $model.invitationInput).textFieldStyle(.roundedBorder).onSubmit { model.previewInvitation() }
                    Button {
                        if model.invitationInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { model.pasteInvitation() }
                        else { model.previewInvitation() }
                    } label: {
                        HStack { Spacer(); Text(model.invitationInput.isEmpty ? "粘贴邀请链接" : "继续"); Image(systemName: "arrow.right"); Spacer() }.padding(.vertical, 5)
                    }.buttonStyle(.borderedProminent).controlSize(.large)
                    Button("还没有邀请？查看获取方式") { model.showInvitationHelp = true }.buttonStyle(.link).font(.system(size: 12))
                }
                Text("复用本机 Harness 的安装与登录，首次接入无需选择项目目录。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !model.discovered.isEmpty {
                    Button("返回已有连接") { model.connectingNew = false; model.clearInvitation() }.buttonStyle(.link).font(.system(size: 12))
                }
            }
            if model.discoveryIncomplete {
                Text("部分旧配置未能读取，可重新检测或在设置中导入。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            DisclosureGroup("设置与维护") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("执行起始目录").font(.system(size: 11, weight: .medium))
                            Text(model.workURL.path).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(); Button("更改", action: model.chooseDirectory).controlSize(.small)
                    }
                    Text("命令与相对路径从这里开始；普通连接无需修改。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Divider()
                    HStack {
                        Text(model.caURL?.lastPathComponent ?? "私有 CA 证书（可选）").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(); Button(model.caURL == nil ? "选择" : "更换", action: model.chooseCA).controlSize(.small)
                        if model.caURL != nil { Button("移除") { model.caURL = nil }.controlSize(.small) }
                    }
                    Text("普通公开证书无需设置。").font(.system(size: 11)).foregroundStyle(.secondary)
                    Divider()
                    Button("导入旧版邀请文件（JSON）…", action: model.choosePairing).buttonStyle(.link).font(.system(size: 11))
                    Button("手动导入已有设备配置…", action: model.adopt).buttonStyle(.link).font(.system(size: 11))
                    Button("重新检测本机设备") { Task { await model.scanDevices() } }.buttonStyle(.link).font(.system(size: 11)).disabled(model.scanning)
                    Divider()
                    quitButton
                }.padding(.top, 12)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
            HStack(spacing: 16) {
                Button("检查本机环境", action: model.openLocalChecks).buttonStyle(.link)
                Button("查看日志", action: model.readLogs).buttonStyle(.link)
            }.font(.system(size: 12))
            if model.device.configured {
                Button("返回设备状态") { model.resumeSetup = false; model.clearInvitation() }.buttonStyle(.link).font(.system(size: 12))
            }
        }.disabled(model.busy)
    }
    private var device: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(model.statusColor).frame(width: 9, height: 9).padding(.top, 7)
                VStack(alignment: .leading, spacing: 5) {
                    Text(model.statusTitle).font(.system(size: 21, weight: .semibold))
                    Text(model.device.server ?? "").font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Text(model.statusDetail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            VStack(spacing: 0) {
                dataRow("设备后台", value: model.backgroundStateLabel, symbol: "power")
                Divider().padding(.leading, 36)
                dataRow("设备执行", value: model.executionStateLabel, symbol: "waveform.path")
            }.padding(.horizontal, 12).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
            if model.localTestNeedsAttention {
                Button(action: model.openLocalChecks) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: model.selfTestRunning ? "clock" : "exclamationmark.circle").foregroundStyle(.orange).padding(.top, 1)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.localTestNoticeTitle).font(.system(size: 12, weight: .medium)).foregroundStyle(.primary)
                            Text(model.localTestNoticeDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 3)
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 8))
            }
            if model.device.connectionIssue != nil {
                message(model.device.connectionIssue == "configuration_mismatch" ? "保存的服务地址与后台不一致，请检查本机环境。" : "请检查网络、服务地址与设备配对。", symbol: "wifi.exclamationmark", color: .orange)
            }
            if model.device.running != true && model.device.managed == true {
                Button("启动后台") { model.action("start") }.buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(model.busy || model.maintenanceBlocked)
            } else if model.device.managed != true && model.device.externalInstallation != true {
                Button("继续连接这台 Mac", action: model.continueSetup).buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.maintenanceBlocked)
            }
            HStack(spacing: 16) {
                Button("检查本机环境", action: model.openLocalChecks).buttonStyle(.link)
                Button("查看日志", action: model.readLogs).buttonStyle(.link)
            }.font(.system(size: 12)).disabled(model.busy)
            if model.canUpgradeBackground {
                Button("后台可更新至应用版本") { model.showDetails = true }.buttonStyle(.link).font(.system(size: 11))
            }
            DisclosureGroup("设置与维护", isExpanded: $model.showDetails) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.backgroundVersionDetail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Toggle("登录后自动启动后台", isOn: Binding(get: { model.device.autostart == true }, set: { model.action("autostart", fields: ["enabled": $0]) }))
                        .toggleStyle(.switch).controlSize(.small).font(.system(size: 12))
                        .disabled(model.busy || model.maintenanceBlocked || model.device.managed != true)
                    if let reason = model.maintenanceBlockReason { message(reason, symbol: "clock", color: .orange) }
                    if model.device.managed == true {
                        HStack(spacing: 10) {
                            Button("停止后台") { model.action("stop") }.disabled(model.device.running != true)
                            if model.canUpgradeBackground { Button("更新后台…") { maintenance = "upgrade"; confirmMaintenance = true } }
                            Button("回滚…") { maintenance = "rollback"; confirmMaintenance = true }.disabled(model.device.canRollback != true)
                        }.disabled(model.busy || model.maintenanceBlocked).controlSize(.small)
                    } else {
                        Text(model.device.externalInstallation == true ? "请通过原安装入口维护此后台。" : "连接中断后可继续使用已保存的身份，无需再次领取邀请。")
                            .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Divider()
                    installationDetail("执行起始目录", value: model.device.cwd)
                    installationDetail("设备 ID", value: model.device.nodeId)
                    Button("手动导入其他设备配置…", action: model.adopt).buttonStyle(.link).disabled(model.busy || model.selfTestRunning || model.selfTestStartUnconfirmed)
                    Divider()
                    quitButton
                }.padding(.top, 10)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
    private var quitButton: some View {
        Button("退出 LaunchApp", action: quit).buttonStyle(.plain)
            .help("退出菜单栏客户端，设备后台继续运行").disabled(model.busy)
    }
    private var footer: some View {
        HStack {
            Text("\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0") · macOS arm64").font(.system(size: 11)).foregroundStyle(.tertiary)
            Spacer()
            if model.device.running == true { Text("后台独立运行").font(.system(size: 11)).foregroundStyle(.secondary) }
            Button("收起面板", action: hide).buttonStyle(.plain).font(.system(size: 11)).help("收起弹层，保留菜单栏图标；设备后台继续运行")
        }.padding(.horizontal, 20).padding(.vertical, 12)
    }
    private var providerSelector: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("本机环境").font(.system(size: 12, weight: .medium))
                Spacer()
                Text("选择要检查的环境").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            if model.providerChoices.isEmpty {
                Text("暂无可选环境").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            ForEach(model.providerChoices) { provider in
                Button { model.selectProvider(provider.key) } label: {
                    HStack(spacing: 9) {
                        Image(systemName: model.selectedProvider == provider.key ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(model.selectedProvider == provider.key ? .teal : .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(provider.displayName).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                if provider.experimental == true { Text("实验").font(.system(size: 11)).foregroundStyle(.secondary) }
                            }
                            Text(provider.version ?? "版本未报告").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(model.installationStatus(provider)).font(.system(size: 11)).foregroundStyle(provider.status == "installed" ? .teal : .secondary)
                    }.padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(!model.canSelectProvider)
                    .accessibilityLabel("选择 \(model.installationLabel(provider))")
                    .accessibilityValue(model.selectedProvider == provider.key ? "已选择" : "未选择")
            }
            Text(model.selectedProviderDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let installation = model.selectedInstallation {
                DisclosureGroup("安装详情") {
                    VStack(alignment: .leading, spacing: 8) {
                        installationDetail("版本", value: installation.version)
                        installationDetail("发现来源", value: installation.source)
                        installationDetail("可执行文件", value: installation.executable)
                        installationDetail("原生 Home", value: installation.home)
                    }.padding(.top, 8)
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }.padding(.vertical, 12)
    }
    private func installationDetail(_ title: String, value: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            Text(value?.isEmpty == false ? value! : "未报告").font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var verification: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("检查本机环境").font(.headline)
                Spacer()
                Button("完成") { model.showVerification = false }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Label(model.refreshError != nil ? "设备状态尚未读回" : model.device.running == true ? "设备后台运行中" : "设备后台已停止", systemImage: model.refreshError == nil && model.device.running == true ? "checkmark.circle.fill" : "power")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(model.refreshError == nil && model.device.running == true ? .teal : .secondary)
                    providerSelector
                    Divider()
                    HStack {
                        Text("安装与连接诊断").font(.system(size: 13, weight: .semibold))
                        Spacer()
                        Button(model.checks.isEmpty ? "运行诊断" : "重新诊断", action: model.diagnose).disabled(model.busy || model.selfTestRunning || model.selfTestStartUnconfirmed)
                    }
                    Text("诊断检查安装与连接，不使用模型额度。").font(.system(size: 11)).foregroundStyle(.secondary)
                    if !model.checks.isEmpty { diagnostics }
                    Divider()
                    HStack {
                        Text("模型回显测试").font(.system(size: 13, weight: .semibold))
                        Spacer()
                        selfTestButton.buttonStyle(.bordered)
                    }
                    Text(model.selfTestDescription).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    selfTestSummary
                    Text(model.selfTestScopeDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let test = model.selectedSelfTest {
                        DisclosureGroup("本次测试记录") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("执行 ID：\(test.runId)").textSelection(.enabled)
                                if let nativeModel = test.model { Text("模型：\(nativeModel)").textSelection(.enabled) }
                            }.font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).padding(.top, 8)
                        }.font(.system(size: 11))
                    }
                    Divider()
                    DisclosureGroup("开发者：应用端到端测试") {
                        VStack(alignment: .leading, spacing: 10) {
                            if let command = model.selectedAcceptanceCommand {
                                Text(model.selectedAcceptanceDescription ?? "此环境提供了额外验收入口。请先核对命令中的路径与身份；真实执行会使用模型额度。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                Text(command).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                Button(model.copiedTestCommand ? "已复制验收命令" : "复制验收命令", action: model.copyTestCommand)
                            } else {
                                Text("此环境尚未提供额外验收命令。工具和业务授权需由拥有者应用通过 SDK 按实际用途验证。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            }
                            Text("每台设备只有一个应用拥有者。若该应用正在连接，请从原应用验证；CLI 测试仅供其未连接时使用，或使用隔离测试设备。设备邀请不能作为应用凭据。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }.padding(.top, 10)
                    }.font(.system(size: 12))
                    Divider()
                    Text("关闭面板后，测试仍由设备后台持有。重新打开只读取原测试结果，不会自动重发模型请求。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Link("查看应用接入与测试文档", destination: URL(string: "https://github.com/hutian-ai/harness-dock#开始使用")!).font(.system(size: 12))
                    if let progress = model.busyMessage { message(progress, symbol: "clock", color: .secondary) }
                    if let error = model.error { message(error, symbol: "exclamationmark.triangle", color: .orange) }
                    if let error = model.refreshError { message(error, symbol: "arrow.clockwise", color: .orange) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(24).frame(width: 440, height: 520)
    }
    private var selfTestButton: some View {
        Button(model.selfTestButtonTitle, action: model.startSelfTest).disabled(!model.canStartSelfTest)
    }
    private var selfTestSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                if model.selectedSelfTestRunning || model.selectedSelfTestStartUnconfirmed && model.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: model.selectedSelfTest?.state == "passed" && !model.selectedSelfTestStartUnconfirmed ? "checkmark.circle.fill" : model.selectedSelfTest == nil && !model.selectedSelfTestStartUnconfirmed ? "circle.dashed" : "exclamationmark.circle")
                        .foregroundStyle(model.selfTestColor)
                }
                Text(model.selfTestTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(model.selfTestColor)
            }
            Text(model.selfTestDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let date = model.selfTestCheckedAt { Text("最近测试：\(date)").font(.system(size: 11)).foregroundStyle(.secondary) }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 8))
    }
    private var diagnostics: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(model.checks.filter { $0.state == "pass" }.count) 项通过 · \(model.checks.filter { $0.state == "fail" }.count) 项需检查 · \(model.checks.filter { $0.state == "unknown" }.count) 项未验证").font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            ForEach(model.checks.filter { $0.state == "fail" }) { check in diagnosticRow(check) }
            DisclosureGroup("查看全部诊断结果") {
                VStack(alignment: .leading, spacing: 10) { ForEach(model.checks) { check in diagnosticRow(check) } }.padding(.top, 8)
            }.font(.system(size: 11))
        }
    }
    private func diagnosticRow(_ check: Check) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Image(systemName: check.state == "pass" ? "checkmark.circle.fill" : check.state == "fail" ? "exclamationmark.circle.fill" : "minus.circle")
                    .foregroundStyle(check.state == "pass" ? .teal : check.state == "fail" ? .orange : .secondary)
                Text(checkTitle(check.check)).font(.system(size: 11))
                Spacer()
                Text(check.state == "pass" ? "通过" : check.state == "fail" ? "需检查" : "未验证").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            if check.state != "pass" {
                Text(checkNext(check.check)).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 22)
            }
        }
    }
    private func checkNext(_ code: String) -> String {
        if let provider = model.providerChoices.first(where: { "\($0.key)_installation" == code }) {
            return "请在此 Mac 安装并登录 \(provider.displayName)，再重新诊断；原生路径需由设备所有者配置。"
        }
        switch code {
        case "native_installation": return "请先安装并登录要使用的原生 Harness，再重新诊断。"
        case "native_auth_and_protocol": return "选择已安装的 Harness 后可测试对应的本机模型回显。工具与应用授权按实际用途分别验证。"
        case "daemon": return "后台尚未启动，请返回面板启动设备；已有安装请通过原入口启动。"
        case "daemon_configuration": return "已保存配置与后台不一致，请联系部署者核对服务地址。"
        case "device_authentication": return "请核对网络、服务器与设备授权，必要时联系服务管理员。"
        case "server_health": return model.device.connected == true ? "设备连接已确认，此入口的健康检查尚未确认。可让管理员核对独立的健康检查地址。" : "请检查网络、服务地址与健康检查入口。"
        case "server_transport": return "请检查网络和服务地址；私有 CA 需由管理员提供可信证书。"
        case "device_protocol": return "请让管理员确认服务端与设备版本兼容。"
        case "workdir": return "工作目录不可用，请检查该目录是否仍存在、当前用户是否可访问。"
        case "supported_device": return "当前仅支持 macOS 13+、Apple Silicon。"
        case "runtime": return "随包运行时不可用，请向部署者获取完整客户端。"
        case "configuration": return "请让部署者检查配置权限，设备配置应仅供当前用户读取。"
        case "unresolved_execution": return "应用任务请回到发起应用查询原执行；本机检查请查看此处的原检查记录。核对后再维护后台，不重发请求。"
        default: return "请查看本地日志，或联系部署者协助检查。分享日志前检查敏感内容。"
        }
    }
    private func dataRow(_ title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16)
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value).lineLimit(1).truncationMode(.middle)
        }.font(.system(size: 12)).padding(.vertical, 13)
    }
    private func message(_ text: String, symbol: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: symbol).padding(.top, 1)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }.font(.system(size: 11)).foregroundStyle(color)
    }
    private func checkTitle(_ code: String) -> String {
        if let provider = model.providerChoices.first(where: { "\($0.key)_installation" == code }) { return "\(provider.displayName) 安装" }
        return ["configuration": "设备配置", "runtime": "随包运行时", "supported_device": "设备平台", "workdir": "工作目录",
         "daemon": "本地后台进程", "daemon_configuration": "后台配置一致性", "device_authentication": "设备配对与连接",
         "server_transport": "服务器 TLS / 网络", "device_protocol": "协议版本", "server_health": "服务器健康检查",
         "native_installation": "原生助手安装", "native_auth_and_protocol": "登录、模型与工具（需独立验收）",
         "unresolved_execution": "执行结果待核对", "device": "设备诊断"][code] ?? "其他检查"
    }
}
