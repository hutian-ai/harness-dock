import SwiftUI

private struct PanelHeightPreference: PreferenceKey {
    static let defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}

struct PanelView: View {
    @ObservedObject var model: PanelModel
    let resize: (CGFloat) -> Void
    let hide: () -> Void
    let quit: () -> Void
    @State private var maintenance = "upgrade"
    @State private var confirmMaintenance = false
    @State private var homeHeight: CGFloat = 520
    private let poll = Timer.publish(every: 5, on: .main, in: .common).autoconnect()
    private var needsSetup: Bool {
        !model.device.configured || model.resumeSetup || model.pairing != nil && model.device.managed != true
    }
    private var page: String {
        if model.loading { return "loading" }
        if model.showVerification { return "verification" }
        if model.showDetails && !needsSetup { return "settings" }
        return needsSetup ? "setup" : "home"
    }
    private var panelHeight: CGFloat { page == "home" || page == "loading" ? homeHeight : 520 }
    private func measureHeight(_ section: String) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(key: PanelHeightPreference.self, value: ["\(page).\(section)": geometry.size.height])
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            Group {
                if model.showVerification { navigationHeader(model.selectedProviderName) { model.showVerification = false } }
                else if model.showDetails && !needsSetup { navigationHeader("设置与维护") { model.showDetails = false } }
                else { header }
            }.background(measureHeight("header"))
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if model.loading { ProgressView().frame(maxWidth: .infinity, minHeight: 170) }
                    else if model.showVerification { verification }
                    else if model.showDetails && !needsSetup { settings }
                    else if needsSetup { harnessOverview; Divider(); onboarding }
                    else { device }
                    if !model.showVerification || !model.hasSelectedSelfTestFeedback { operationFeedback }
                    if let error = model.refreshError {
                        message(error, symbol: "arrow.clockwise", color: .orange)
                        Button("刷新状态") { Task { await model.refresh() } }
                            .buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12)).disabled(model.busy)
                    }
                }.padding(20).background(measureHeight("content"))
            }
        }
        .frame(width: 400, height: panelHeight)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(PanelTheme.action)
        .onPreferenceChange(PanelHeightPreference.self) { heights in
            guard page == "home", let header = heights["home.header"],
                  let content = heights["home.content"] else { return }
            let fitted = min(520, max(240, ceil(header + content + 1)))
            if abs(homeHeight - fitted) >= 1 { homeHeight = fitted }
        }
        .onAppear { resize(panelHeight) }
        .onChange(of: panelHeight) { resize($0) }
        .task { await model.load() }
        .onReceive(poll) { _ in if model.visible { Task { await model.refresh() } } }
        .onChange(of: model.resumeSetup) { resumed in
            if resumed { model.showVerification = false; model.showDetails = false }
        }
        .confirmationDialog("确认维护设备", isPresented: $confirmMaintenance) {
            Button(maintenance == "rollback" ? "回滚程序版本" : "更新至此应用附带版本") {
                model.action(maintenance)
            }
            Button("取消", role: .cancel) { }
        } message: { Text("仅在设备空闲且没有待核对结果时切换。程序回滚不会撤销数据库变化或已发生的外部操作。") }
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
                Button(model.copiedInvitationRequest ? "已复制申请内容" : "复制邀请申请", action: model.copyInvitationRequest).buttonStyle(PanelPrimaryButtonStyle())
                Link("查看服务端配对说明", destination: URL(string: "https://github.com/hutian-ai/harness-dock/blob/main/apps/docs-site/README.md#pairing")!)
                    .foregroundStyle(PanelTheme.action).font(.system(size: 12))
                Text("已经接入过的 Mac 优先使用自动检测到的旧设备，无需再领取邀请。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(24).frame(width: 410)
        }
    }
    private var header: some View {
        HStack(spacing: 10) {
            PanelBrandMark().frame(width: 30, height: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(PanelTheme.appName).font(.system(size: 16, weight: .semibold)).lineLimit(1)
                Text("让应用调用这台 Mac").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            if model.busy { ProgressView().controlSize(.small) }
            Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).help("刷新设备状态").accessibilityLabel("刷新设备状态").disabled(model.busy)
                .frame(width: 24, height: 24)
            hideButton
        }.padding(.horizontal, 20).padding(.vertical, 16)
    }
    private func navigationHeader(_ title: String, back: @escaping () -> Void) -> some View {
        HStack {
            Button(action: back) {
                Label("返回", systemImage: "chevron.left")
            }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).keyboardShortcut(.cancelAction)
                .frame(width: 64, alignment: .leading)
            Spacer(minLength: 0)
            Text(title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                if model.busy { ProgressView().controlSize(.small) }
                hideButton
            }.frame(width: 64)
        }.font(.system(size: 12)).padding(.horizontal, 20).frame(height: 58)
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
                                Image(systemName: "desktopcomputer").font(.system(size: 20)).foregroundStyle(PanelTheme.action)
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
                Button("连接其他服务") { model.connectingNew = true }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12))
            } else {
                if let invitation = model.pairing {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("确认连接到此服务", systemImage: "link").font(.system(size: 12, weight: .medium)).foregroundStyle(PanelTheme.action)
                        Text(invitation.server).font(.system(size: 17, weight: .medium)).lineLimit(2)
                        Text("连接后，该服务获授权的应用可以使用这台 Mac 上受支持的原生 Harness 执行任务。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button("更换邀请", action: model.clearInvitation).buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 11))
                    }.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                    Button(action: model.setup) {
                        HStack { Spacer(); Text(model.busy ? "正在接入…" : "连接这台 Mac"); Image(systemName: "arrow.right"); Spacer() }.padding(.vertical, 5)
                    }.buttonStyle(PanelPrimaryButtonStyle()).controlSize(.large)
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
                    }.buttonStyle(PanelPrimaryButtonStyle()).controlSize(.large)
                    Button("还没有邀请？查看获取方式") { model.showInvitationHelp = true }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12))
                }
                Text("复用本机 Harness 的安装与登录，首次接入无需选择项目目录。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !model.discovered.isEmpty {
                    Button("返回已有连接") { model.connectingNew = false; model.clearInvitation() }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12))
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
                    Button("导入旧版邀请文件（JSON）…", action: model.choosePairing).buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 11))
                    Button("手动导入已有设备配置…", action: model.adopt).buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 11))
                    Button("重新检测本机设备") { Task { await model.scanDevices() } }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 11)).disabled(model.scanning)
                    Button("查看本地日志", action: model.readLogs).buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 11))
                    Divider()
                    quitButton
                }.padding(.top, 12)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
            if model.device.configured {
                Button("返回设备状态") { model.resumeSetup = false; model.clearInvitation() }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12))
            }
        }.disabled(model.busy)
    }
    private var device: some View {
        VStack(alignment: .leading, spacing: 18) {
            harnessOverview
            Divider()
            serviceConnection
            Divider()
            Button { model.showDetails = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "gearshape").font(.system(size: 17)).foregroundStyle(.secondary)
                    Text("设置与维护").font(.system(size: 13, weight: .medium))
                    Spacer()
                    if model.canUpgradeBackground {
                        Text("可更新").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.secondary)
                }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
    }
    private var harnessOverview: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.harnessSummaryTitle).font(.system(size: 18, weight: .semibold))
            if let detail = model.harnessSummaryDetail {
                Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if !model.providerChoices.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(model.providerChoices.enumerated()), id: \.element.key) { index, provider in
                        if index > 0 { Divider().padding(.leading, 48) }
                        harnessRow(provider)
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.09), lineWidth: 1))
            } else {
                Button("检查安装与连接", action: model.openLocalChecks)
                    .buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12))
            }
            if model.selfTestStartUnconfirmed {
                Button(action: model.openLocalChecks) {
                    Label("核对原测试的启动结果", systemImage: "exclamationmark.circle")
                }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.orange)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func harnessRow(_ provider: ProviderInstallation) -> some View {
        Button { model.openProviderDetails(provider.key) } label: {
            HStack(spacing: 11) {
                Image(systemName: "terminal").font(.system(size: 23, weight: .regular))
                    .foregroundStyle(.secondary).frame(width: 26)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(provider.displayName).font(.system(size: 14, weight: .semibold)).foregroundStyle(.primary)
                        if provider.experimental == true {
                            Text("实验适配").font(.system(size: 10)).foregroundStyle(.secondary)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3), lineWidth: 1))
                                .help("此 Harness 的 Dock 适配目前为实验性；模型回显测试状态单独显示。")
                        }
                    }
                    HStack(spacing: 5) {
                        Text(model.installationStatus(provider)).foregroundStyle(.secondary)
                        if provider.status == "installed" || model.latestSelfTest(for: provider.key) != nil {
                            Text("·").foregroundStyle(.tertiary)
                            if let symbol = model.rowTestSymbol(provider) {
                                Image(systemName: symbol).foregroundStyle(model.rowTestColor(provider))
                            }
                            Text(model.rowTestLabel(provider)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }.font(.system(size: 11))
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.secondary)
            }.padding(12).frame(maxWidth: .infinity, minHeight: 64, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!model.canOpenProviderDetails)
            .accessibilityLabel("\(model.installationLabel(provider))，\(model.rowTestLabel(provider))，查看详情")
    }
    private var serviceConnection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("服务连接").font(.system(size: 13, weight: .medium))
                Spacer()
                Circle().fill(model.connectionColor).frame(width: 7, height: 7)
                Text(model.connectionTitle).font(.system(size: 12)).foregroundStyle(.primary)
            }
            Text(model.device.server ?? "服务地址尚未读回").font(.system(size: 12)).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Text(model.connectionDetail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.device.running != true && model.device.managed == true {
                Button("启动后台") { model.action("start") }.buttonStyle(PanelPrimaryButtonStyle()).controlSize(.large)
                    .disabled(model.busy || model.maintenanceBlocked)
            } else if model.device.managed != true && model.device.externalInstallation != true {
                Button("继续连接这台 Mac", action: model.continueSetup).buttonStyle(PanelPrimaryButtonStyle())
                    .disabled(model.busy || model.maintenanceBlocked)
            }
            if model.device.connectionIssue != nil || model.device.running == true && model.device.connected != true {
                Button("检查连接", action: model.openLocalChecks).buttonStyle(.plain)
                    .foregroundStyle(PanelTheme.action).font(.system(size: 12)).disabled(model.busy)
            }
        }
    }
    private var settings: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("设备后台").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text(model.backgroundStateLabel).font(.system(size: 12)).foregroundStyle(.secondary)
            }
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
            Button(action: model.readLogs) {
                Label("查看本地日志", systemImage: "doc.text")
            }.buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12)).disabled(model.busy)
            Button("安装与连接诊断", action: model.openLocalChecks)
                .buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12)).disabled(model.busy)
            Divider()
            installationDetail("执行起始目录", value: model.device.cwd)
            installationDetail("设备 ID", value: model.device.nodeId)
            Button("手动导入其他设备配置…", action: model.adopt).buttonStyle(.plain).foregroundStyle(PanelTheme.action).font(.system(size: 12)).disabled(model.busy || model.selfTestRunning || model.selfTestStartUnconfirmed)
            Divider()
            Text("\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0") · macOS arm64")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            Text("收起或退出面板后，已启动的设备后台继续独立运行。")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            quitButton
        }
    }
    private var quitButton: some View {
        Button("退出 LaunchApp", action: quit).buttonStyle(.plain)
            .help("退出菜单栏客户端，设备后台继续运行").disabled(model.busy)
    }
    private var hideButton: some View {
        Button(action: hide) {
            Image(systemName: "xmark").font(.system(size: 11, weight: .medium))
                .frame(width: 24, height: 24).contentShape(Rectangle())
        }.buttonStyle(.plain).foregroundStyle(.secondary)
            .accessibilityLabel("收起面板").help("收起弹层，保留菜单栏图标；设备后台继续运行")
    }
    @ViewBuilder private var operationFeedback: some View {
        if let progress = model.busyMessage { message(progress, symbol: "clock", color: .secondary) }
        if let error = model.error { message(error, symbol: "exclamationmark.triangle", color: .orange) }
        if let notice = model.notice { message(notice, symbol: "info.circle", color: .secondary) }
    }
    private var installationSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("本机安装").font(.system(size: 13, weight: .semibold))
            if let installation = model.selectedInstallation {
                detailRow("安装状态", value: model.installationStatus(installation))
                Divider()
                detailRow("版本", value: installation.version ?? "未报告")
                DisclosureGroup("安装详情") {
                    VStack(alignment: .leading, spacing: 10) {
                        installationDetail("发现来源", value: installation.source)
                        installationDetail("可执行文件", value: installation.executable)
                        installationDetail("原生 Home", value: installation.home)
                    }.padding(.top, 8)
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                Text(model.selectedProviderDetail).font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private func detailRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value).textSelection(.enabled)
        }.font(.system(size: 12)).padding(.vertical, 1)
    }
    private func installationDetail(_ title: String, value: String?) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
            Text(value?.isEmpty == false ? value! : "未报告").font(.system(size: 11, design: .monospaced))
                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var verification: some View {
        VStack(alignment: .leading, spacing: 12) {
            installationSummary
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("模型回显测试").font(.system(size: 13, weight: .semibold))
                selfTestSummary
                Text("仅证明本次模型回显，工具与应用授权需分别验证。")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !model.selectedReadOnlyEcho && model.selectedInstallation != nil {
                    Text("沿用原生权限配置，不提供只读保证。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                selfTestButton.buttonStyle(PanelPrimaryButtonStyle()).controlSize(.large)
                if model.hasSelectedSelfTestFeedback { operationFeedback }
                Text("会调用模型并使用账户额度。").font(.system(size: 11)).foregroundStyle(.secondary)
                if let reason = model.maintenanceBlockReason {
                    message(reason, symbol: "clock", color: .orange)
                } else if model.device.running != true {
                    Text("启动设备后台后才能测试。").font(.system(size: 11)).foregroundStyle(.secondary)
                } else if !model.selectedProviderSelfTestSupported {
                    Text("当前后台未提供此 Harness 的模型测试。").font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("安装与连接诊断").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Button(model.checks.isEmpty ? "运行诊断" : "重新诊断", action: model.diagnose)
                        .controlSize(.small).disabled(model.busy || model.selfTestRunning || model.selfTestStartUnconfirmed)
                }
                Text("检查本机环境，不调用模型。").font(.system(size: 11)).foregroundStyle(.secondary)
                if !model.checks.isEmpty { diagnostics }
            }
            Divider()
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 10) {
                    if let test = model.selectedSelfTest {
                        installationDetail("测试 ID", value: test.id)
                        installationDetail("执行 ID", value: test.runId)
                        if let nativeModel = test.model { installationDetail("本次使用的模型", value: nativeModel) }
                    } else if model.selectedSelfTestStartUnconfirmed {
                        installationDetail("待核对的测试 ID", value: model.pendingSelfTestId)
                    } else {
                        Text("尚无此 Harness 的测试记录。").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Text(model.selfTestDescription).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text("关闭面板后，测试仍由设备后台持有。重新打开只读取原结果，不会自动重发模型请求。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 8)
            } label: {
                Label("查看测试记录", systemImage: "clock").foregroundStyle(PanelTheme.action)
            }.font(.system(size: 12))
            developerVerification
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var developerVerification: some View {
        DisclosureGroup("开发者：应用端到端测试") {
            VStack(alignment: .leading, spacing: 10) {
                if let command = model.selectedAcceptanceCommand {
                    Text(model.selectedAcceptanceDescription ?? "此环境提供了额外验收入口。请先核对命令中的路径与身份；真实执行会使用模型额度。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text(command).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Button(model.copiedTestCommand ? "已复制验收命令" : "复制验收命令", action: model.copyTestCommand)
                } else {
                    Text("此环境尚未提供额外验收命令。工具和业务授权需由拥有者应用通过 SDK 按实际用途验证。")
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Text("每台设备只有一个应用拥有者。若该应用正在连接，请从原应用验证；CLI 测试仅供其未连接时使用，或使用隔离测试设备。设备邀请不能作为应用凭据。")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Link("查看应用接入与测试文档", destination: URL(string: "https://github.com/hutian-ai/harness-dock#开始使用")!)
                    .foregroundStyle(PanelTheme.action).font(.system(size: 11))
            }.padding(.top, 10)
        }.font(.system(size: 11)).foregroundStyle(.secondary)
    }
    private var selfTestButton: some View {
        Button(action: model.startSelfTest) {
            Text(model.selfTestButtonTitle).frame(maxWidth: .infinity).padding(.vertical, 2)
        }.disabled(!model.canStartSelfTest)
    }
    private var selfTestSummary: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if model.selectedSelfTestRunning || model.selectedSelfTestStartUnconfirmed && model.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: model.selectedSelfTest?.state == "passed" && !model.selectedSelfTestStartUnconfirmed ? "checkmark.circle.fill" : model.selectedSelfTest == nil && !model.selectedSelfTestStartUnconfirmed ? "circle.dashed" : "exclamationmark.circle")
                        .foregroundStyle(model.selfTestColor)
                }
                Text(model.selfTestTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(.primary)
            }
            if model.selectedSelfTest?.state != "passed" || model.selfTestIsHistorical || model.refreshError != nil || model.selectedSelfTestStartUnconfirmed {
                Text(model.selfTestDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let date = model.selfTestCheckedAt { Text("最近测试：\(date)").font(.system(size: 11)).foregroundStyle(.secondary) }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(PanelTheme.surface).clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.08), lineWidth: 1))
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
                    .foregroundStyle(check.state == "pass" ? PanelTheme.accent : check.state == "fail" ? .orange : .secondary)
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
