import SwiftUI

struct PanelView: View {
    @ObservedObject var model: PanelModel
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
        .frame(width: 400, height: 580)
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
                Text("这台 Mac 的执行设备").font(.system(size: 11)).foregroundStyle(.secondary)
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
                Text("连接本机 Codex").font(.system(size: 23, weight: .semibold))
                Text("把这台 Mac 上的 Codex 接入你的应用。").font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("需要 macOS 13+、Apple Silicon，并已安装和登录 Codex。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
                                    Text(found.connected ? "已连接 · 保留原设备身份" : found.running ? "后台运行中 · 等待连接" : "已有配置 · 可继续接入").font(.system(size: 10)).foregroundStyle(.secondary)
                                }
                                Spacer(minLength: 5)
                                Image(systemName: "chevron.right").font(.system(size: 11)).foregroundStyle(.secondary)
                            }.padding(14).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("使用已有设备 \(found.server)")
                    }
                }.background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
                Text("不会重新配对，原任务记录和 Codex 登录继续保留。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button("连接其他服务") { model.connectingNew = true }.buttonStyle(.link).font(.system(size: 12))
            } else {
                if let invitation = model.pairing {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("确认连接到此服务", systemImage: "link").font(.system(size: 12, weight: .medium)).foregroundStyle(.teal)
                        Text(invitation.server).font(.system(size: 17, weight: .medium)).lineLimit(2)
                        Text("连接后，该服务获授权的应用可以使用这台 Mac 的 Codex 执行任务。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
                Text("复用本机 Codex 的安装与登录，首次接入无需选择项目目录。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if !model.discovered.isEmpty {
                    Button("返回已有连接") { model.connectingNew = false; model.clearInvitation() }.buttonStyle(.link).font(.system(size: 12))
                }
            }
            if model.discoveryIncomplete {
                Text("部分旧配置未能读取，可重新检测或在高级设置中导入。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            DisclosureGroup("高级设置") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("执行起始目录").font(.system(size: 11, weight: .medium))
                            Text(model.workURL.path).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(); Button("更改", action: model.chooseDirectory).controlSize(.small)
                    }
                    Text("自动使用默认目录。命令与相对路径从这里开始；普通连接无需修改。").font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Divider()
                    HStack {
                        Text(model.caURL?.lastPathComponent ?? "私有 CA 证书（可选）").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(); Button(model.caURL == nil ? "选择" : "更换", action: model.chooseCA).controlSize(.small)
                        if model.caURL != nil { Button("移除") { model.caURL = nil }.controlSize(.small) }
                    }
                    Text("普通公开证书无需设置。").font(.system(size: 10)).foregroundStyle(.secondary)
                    Divider()
                    Button("导入旧版邀请文件（JSON）…", action: model.choosePairing).buttonStyle(.link).font(.system(size: 11))
                    Button("手动导入已有设备配置…", action: model.adopt).buttonStyle(.link).font(.system(size: 11))
                    Button("重新检测本机设备") { Task { await model.scanDevices() } }.buttonStyle(.link).font(.system(size: 11)).disabled(model.scanning)
                }.padding(.top, 12)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
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
                    Text(model.statusDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            VStack(spacing: 0) {
                dataRow("执行环境", value: "Codex · 本机原生", symbol: "terminal")
                Divider().padding(.leading, 36)
                dataRow("设备执行", value: "\(model.device.active ?? 0) 运行中 · \(model.device.unresolved ?? 0) 结果待核对", symbol: "waveform.path")
            }.padding(.horizontal, 12).background(Color(nsColor: .controlBackgroundColor)).clipShape(RoundedRectangle(cornerRadius: 10))
            HStack(spacing: 8) {
                if model.device.running != true && model.device.managed == true {
                    Button("启动设备") { model.action("start") }.buttonStyle(.borderedProminent).disabled(model.maintenanceBlocked)
                }
                if model.device.running == true {
                    selfTestButton.buttonStyle(.borderedProminent)
                } else {
                    selfTestButton
                }
                Button("诊断", action: model.diagnose).disabled(model.selfTestRunning || model.selfTestStartUnconfirmed)
                Button("日志", action: model.readLogs)
            }.controlSize(.regular).disabled(model.busy)
            HStack(alignment: .top, spacing: 10) {
                Text("会实际调用一次模型并使用账户额度。").font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button("测试详情") { model.showVerification = true }.buttonStyle(.link).font(.system(size: 11))
            }
            if model.device.selfTest != nil || model.selfTestStartUnconfirmed { selfTestSummary }
            if model.device.connectionIssue != nil {
                message(model.device.connectionIssue == "configuration_mismatch" ? "保存的服务地址与正在运行的设备不一致，请先诊断。" : "连接尚未建立，请检查网络、服务地址与设备配对。", symbol: "wifi.exclamationmark", color: .orange)
            }
            HStack {
                Toggle("登录后自动启动设备", isOn: Binding(get: { model.device.autostart == true }, set: { model.action("autostart", fields: ["enabled": $0]) }))
                    .toggleStyle(.switch).controlSize(.small)
            }.font(.system(size: 12)).disabled(model.busy || model.maintenanceBlocked || model.device.managed != true)
            if model.device.managed != true && model.device.externalInstallation != true {
                message("设备身份已保存。使用此应用管理，可继续完成安装或迁移已有后台，并保留身份与执行记录。", symbol: "arrow.triangle.2.circlepath", color: .secondary)
                Button("使用此应用管理…", action: model.continueSetup).disabled(model.busy || model.maintenanceBlocked)
            }
            if model.maintenanceBlocked {
                message(model.refreshError != nil ? "最新状态尚未读回，维护操作暂不可用。" : model.selfTestRunning || model.selfTestStartUnconfirmed ? "测试进行中或启动结果待核对，暂不能停机、切换版本或修改自启。" : "执行进行中或有结果待核对，暂不能停机、切换版本或修改自启。", symbol: "clock", color: .orange)
            }
            if !model.checks.isEmpty { diagnostics }
            DisclosureGroup("设备详情与维护", isExpanded: $model.showDetails) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("执行起始目录：\(model.device.cwd ?? "")").font(.system(size: 10, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Text("设备 ID：\(model.device.nodeId ?? "")").font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                    if model.device.managed == true {
                        HStack {
                            Button("停止设备") { model.action("stop") }.disabled(model.device.running != true)
                            Button("更新至应用版本…") { maintenance = "upgrade"; confirmMaintenance = true }
                            Button("回滚…") { maintenance = "rollback"; confirmMaintenance = true }.disabled(model.device.canRollback != true)
                        }.disabled(model.busy || model.maintenanceBlocked).controlSize(.small)
                    } else {
                        Text(model.device.externalInstallation == true ? "此设备使用其他安装位置，请通过原安装入口维护。" : "首次安装中断后，可直接使用已保存的身份继续，无需再次领取邀请。").font(.caption).fixedSize(horizontal: false, vertical: true)
                    }
                    Button("手动导入其他设备配置…", action: model.adopt).buttonStyle(.link).disabled(model.busy)
                }.padding(.top, 10)
            }.font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }
    private var footer: some View {
        HStack {
            Text("\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0") · Codex").font(.system(size: 10)).foregroundStyle(.tertiary)
            Spacer()
            if model.device.running == true { Text("后台将继续运行").font(.system(size: 10)).foregroundStyle(.secondary) }
            Button("退出面板", action: quit).buttonStyle(.plain).font(.system(size: 11)).help("只退出面板；已启动的设备后台独立运行").disabled(model.busy)
        }.padding(.horizontal, 20).padding(.vertical, 12)
    }
    private var verification: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("测试详情").font(.headline)
                Spacer()
                Button("完成") { model.showVerification = false }.keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Label(model.refreshError != nil ? "设备状态尚未读回" : model.device.connected == true ? "设备连接已确认" : "先启动设备并连接服务", systemImage: model.refreshError == nil && model.device.connected == true ? "checkmark.circle.fill" : "network")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(model.refreshError == nil && model.device.connected == true ? .teal : .secondary)
                    selfTestSummary
                    HStack {
                        selfTestButton.buttonStyle(.borderedProminent)
                        Spacer()
                    }
                    Text("会实际调用一次模型并使用账户额度。测试使用原生只读模式核对一次回显，不会授予额外工具权限。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text("测试只证明本机 Codex 的模型执行。设备连接单独显示；应用授权、具体工具、浏览器和插件需按实际用途验证。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let test = model.device.selfTest {
                        DisclosureGroup("本次测试记录") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("执行 ID：\(test.runId)").textSelection(.enabled)
                                if let nativeModel = test.model { Text("模型：\(nativeModel)").textSelection(.enabled) }
                            }.font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).padding(.top, 8)
                        }.font(.system(size: 11))
                    }
                    Divider()
                    HStack {
                        Text("检查本机环境").font(.system(size: 13, weight: .semibold))
                        Spacer()
                        Button(model.checks.isEmpty ? "运行诊断" : "重新诊断", action: model.diagnose).disabled(model.busy || model.selfTestRunning)
                    }
                    Text("诊断检查安装与连接，不发送模型请求。").font(.system(size: 11)).foregroundStyle(.secondary)
                    if !model.checks.isEmpty { diagnostics }
                    DisclosureGroup("开发者：应用端到端测试") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("在已构建的源码目录使用管理员提供的应用 client.json。先把命令中的路径替换为实际文件；测试会调用模型并使用账户额度。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            Button(model.copiedTestCommand ? "已复制测试命令" : "复制此设备的测试命令", action: model.copyTestCommand).disabled(model.device.nodeId == nil)
                            Text("测试核对两轮回显和同一会话续接。需要验证审批时，在交互终端追加 --approval，由你选择原生选项。").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
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
        }.padding(24).frame(width: 440, height: 490)
    }
    private var selfTestButton: some View {
        Button(model.selfTestButtonTitle, action: model.startSelfTest).disabled(!model.canStartSelfTest)
    }
    private var selfTestSummary: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                if model.selfTestRunning || model.selfTestStartUnconfirmed && model.busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: model.device.selfTest?.state == "passed" && !model.selfTestStartUnconfirmed ? "checkmark.circle.fill" : model.device.selfTest == nil && !model.selfTestStartUnconfirmed ? "circle.dashed" : "exclamationmark.circle")
                        .foregroundStyle(model.selfTestColor)
                }
                Text(model.selfTestTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(model.selfTestColor)
            }
            Text(model.selfTestDetail).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let date = model.selfTestCheckedAt { Text("最近测试：\(date)").font(.system(size: 10)).foregroundStyle(.secondary) }
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
                Text(check.state == "pass" ? "通过" : check.state == "fail" ? "需检查" : "未验证").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            if check.state != "pass" {
                Text(checkNext(check.check)).font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.leading, 22)
            }
        }
    }
    private func checkNext(_ code: String) -> String {
        switch code {
        case "codex_installation": return "请在此 Mac 安装并登录 Codex，再重新诊断。"
        case "native_auth_and_protocol": return "可直接点击“测试 Codex”验证本机模型执行。具体工具与应用授权按实际用途验证。"
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
        case "unresolved_execution": return "回到发起应用查询原执行记录，核对结果后再维护设备。"
        default: return "请查看本地日志，或联系部署者协助检查。分享日志前检查敏感内容。"
        }
    }
    private func dataRow(_ title: String, value: String, symbol: String) -> some View {
        HStack(spacing: 9) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 16)
            Text(title).foregroundStyle(.secondary)
            Spacer()
            Text(value).lineLimit(1).truncationMode(.middle)
        }.font(.system(size: 11)).padding(.vertical, 13)
    }
    private func message(_ text: String, symbol: String, color: Color) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: symbol).padding(.top, 1)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }.font(.system(size: 11)).foregroundStyle(color)
    }
    private func checkTitle(_ code: String) -> String {
        ["configuration": "设备配置", "runtime": "随包运行时", "supported_device": "设备平台", "workdir": "工作目录",
         "daemon": "本地后台进程", "daemon_configuration": "后台配置一致性", "device_authentication": "设备配对与连接",
         "server_transport": "服务器 TLS / 网络", "device_protocol": "协议版本", "server_health": "服务器健康检查",
         "codex_installation": "Codex 安装", "native_auth_and_protocol": "登录、模型与工具（需独立验收）",
         "unresolved_execution": "执行结果待核对", "device": "设备诊断"][code] ?? "其他检查"
    }
}
