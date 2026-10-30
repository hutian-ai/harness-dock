import Foundation
import SwiftUI

/// Synthetic snapshots and an isolated helper only: never call a model or read the user's configuration.
@main struct PanelModelChecks {
    private static func installation(_ key: String, status: String) -> ProviderInstallation {
        ProviderInstallation(key: key, displayName: key == "codex" ? "Codex" : "dsh", status: status,
            selfTestSupported: status == "installed", version: nil, source: nil, executable: nil, home: nil,
            selfTestKind: key == "codex" ? "read-only-echo" : "native-echo", acceptanceCommand: nil,
            acceptanceDescription: nil, experimental: key == "dsh")
    }

    private static func snapshot(_ id: String, provider: String?, daemon: String = "current", state: String = "passed", startedAt: Double) -> SelfTestSnapshot {
        SelfTestSnapshot(id: id, runId: "synthetic-\(id)", daemonId: daemon, state: state,
            phase: state == "running" ? "executing" : "finished", startedAt: startedAt,
            finishedAt: state == "running" ? nil : startedAt + 1, model: nil, code: nil, provider: provider)
    }

    @MainActor private static func helperModel(at resources: URL, node: URL, receiptUnavailable: Bool) throws -> PanelModel {
        let daemon = resources.appendingPathComponent("daemon")
        let runtime = daemon.appendingPathComponent("runtime")
        let distribution = daemon.appendingPathComponent("dist")
        try FileManager.default.createDirectory(at: runtime, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: distribution, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: runtime.appendingPathComponent("node"), withDestinationURL: node)
        try Data(#"{"private":true,"type":"commonjs"}"#.utf8).write(to: daemon.appendingPathComponent("package.json"))
        let script = #"""
        const fs = require('node:fs');
        const path = require('node:path');
        const receiptUnavailable = \#(receiptUnavailable ? "true" : "false");
        const state = {
          configured: true, running: true, connected: true, daemonId: 'synthetic-current',
          providers: [
            {key: 'dsh', displayName: 'dsh', status: 'installed', selfTestSupported: true},
            {key: 'codex', displayName: 'Codex', status: 'installed', selfTestSupported: true}
          ],
          selfTests: [], selfTestProviders: ['dsh', 'codex'], active: 0, unresolved: 0
        };
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => {
          const request = JSON.parse(input);
          fs.appendFileSync(path.join(__dirname, 'requests.jsonl'), JSON.stringify({operation: request.operation, provider: request.provider}) + '\n');
          const send = value => process.stdout.write(JSON.stringify(value));
          if (request.operation === 'test') return send({ok: false, error: 'fixture_mutation_disabled'});
          if (request.operation === 'test-status') {
            if (receiptUnavailable) return send({ok: false, error: 'helper_timeout'});
            return send({ok: true, value: {...state, selfTestReceipt: {id: request.testId, provider: request.provider, found: false}}});
          }
          if (request.operation === 'status') return send({ok: true, value: state});
          if (request.operation === 'doctor') return send({ok: true, value: {checks: []}});
          return send({ok: false, error: 'fixture_mutation_disabled'});
        });
        """#
        try Data(script.utf8).write(to: distribution.appendingPathComponent("panel-cli.js"))
        let model = PanelModel(resources: resources, configOverride: resources.appendingPathComponent("synthetic-config.json").path)
        model.loading = false
        model.device = DeviceState(configured: true, running: true, connected: true, daemonId: "synthetic-current",
            providers: [installation("dsh", status: "installed"), installation("codex", status: "installed")],
            selfTests: [], selfTestProviders: ["dsh", "codex"])
        return model
    }

    @MainActor private static func waitForOperation(_ model: PanelModel) async throws {
        for _ in 0..<1000 {
            if !model.busy { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        preconditionFailure("Synthetic helper operation did not finish")
    }

    private static func operations(at resources: URL) throws -> [String] {
        let log = try String(contentsOf: resources.appendingPathComponent("daemon/dist/requests.jsonl"), encoding: .utf8)
        return try log.split(separator: "\n").compactMap { line in
            (try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["operation"] as? String
        }
    }

    @MainActor private static func checkTestFeedback(in temporary: URL, node: URL) async throws {
        let rejectedResources = temporary.appendingPathComponent("rejected-test")
        let rejected = try helperModel(at: rejectedResources, node: node, receiptUnavailable: false)
        assert(rejected.canStartSelfTest)
        rejected.startSelfTest()
        assert(rejected.busy && rejected.selfTestFeedbackProvider == "dsh" && rejected.hasSelectedSelfTestFeedback,
            "Test feedback context is available immediately at admission")
        try await waitForOperation(rejected)
        assert(rejected.error == PanelFailure(code: "fixture_mutation_disabled").localizedDescription,
            "An absent receipt must not erase the original start rejection")
        assert(rejected.selfTestFeedbackProvider == "dsh" && rejected.hasSelectedSelfTestFeedback,
            "The rejection stays attached to the selected Harness")
        assert(rejected.notice?.contains("已确认") == true && rejected.notice?.contains("未启动") == true)
        assert(rejected.notice?.contains("重新点击") == false, "A rejected preview must not encourage repeated submissions")
        assert(rejected.pendingSelfTestId == nil && rejected.pendingSelfTestProvider == nil && rejected.canStartSelfTest,
            "Only confirmed absence clears the pending receipt")
        let rejectedOperations = try operations(at: rejectedResources)
        assert(rejectedOperations == ["test", "test-status"], "A rejection is queried once without replay")
        rejected.diagnose()
        assert(rejected.selfTestFeedbackProvider == nil && !rejected.hasSelectedSelfTestFeedback,
            "Another action clears the previous test feedback context")
        try await waitForOperation(rejected)

        let uncertainResources = temporary.appendingPathComponent("uncertain-test")
        let uncertain = try helperModel(at: uncertainResources, node: node, receiptUnavailable: true)
        uncertain.startSelfTest()
        try await waitForOperation(uncertain)
        let originalId = uncertain.pendingSelfTestId
        assert(originalId != nil && uncertain.pendingSelfTestProvider == "dsh")
        assert(uncertain.error != nil && uncertain.refreshError != nil && uncertain.hasSelectedSelfTestFeedback,
            "Missing receipt evidence retains both feedback and uncertainty")
        assert(!uncertain.canStartSelfTest && uncertain.maintenanceBlocked)
        uncertain.startSelfTest()
        await uncertain.refresh()
        assert(uncertain.pendingSelfTestId == originalId && uncertain.pendingSelfTestProvider == "dsh",
            "Refresh preserves the original test identity")
        let uncertainOperations = try operations(at: uncertainResources)
        assert(uncertainOperations.filter { $0 == "test" }.count == 1,
            "An uncertain request is never resubmitted")
        assert(uncertainOperations.filter { $0 == "test-status" }.count == 2,
            "Only read-only receipt reconciliation is repeated")
        uncertain.openProviderDetails("codex")
        assert(!uncertain.hasSelectedSelfTestFeedback && uncertain.selfTestFeedbackProvider == "dsh")
        assert(uncertain.pendingSelfTestId == originalId && uncertain.pendingSelfTestProvider == "dsh" && !uncertain.canStartSelfTest,
            "Browsing another Harness cannot transfer pending ownership or enable a new test")
    }

    @MainActor static func main() async throws {
        let temporary = URL(fileURLWithPath: CommandLine.arguments[1])
        let model = PanelModel(resources: temporary, configOverride: temporary.appendingPathComponent("synthetic-config.json").path)
        model.loading = false
        assert(model.device.providers == nil && !model.harnessSummaryTitle.contains("0"), "Missing discovery is not zero installed Harnesses")

        model.device = DeviceState(configured: true, running: true, connected: true, daemonId: "current",
            selfTest: snapshot("legacy-only", provider: nil, daemon: "prior", startedAt: 1000))
        model.openLocalChecks()
        assert(model.showVerification && model.selectedProvider == "codex" && model.selectedProviderName == "Codex", "Legacy Codex history remains readable without installation metadata")
        assert(model.selectedSelfTest?.id == "legacy-only" && model.selfTestIsHistorical)
        assert(model.providerChoices.isEmpty && !model.harnessSummaryTitle.contains("0") && !model.canStartSelfTest, "History is not installation or execution readiness evidence")
        model.device.selfTests = [snapshot("latest-without-installation", provider: "dsh", startedAt: 2000)]
        assert(model.selectedProvider == "dsh" && model.selectedSelfTest?.id == "latest-without-installation", "History fallback uses the latest per-Harness record")
        assert(model.providerChoices.isEmpty && !model.canStartSelfTest)

        let codex = installation("codex", status: "installed")
        let dsh = installation("dsh", status: "installed")
        model.device = DeviceState(configured: true, managed: true, running: true, connected: true, daemonId: "current",
            providers: [codex, installation("dsh", status: "not_found")], selfTestProviders: ["codex", "dsh"])
        assert(model.installedProviderCount == 1, "The supported adapter list is not the installed count")
        model.device.providers = [codex, installation("dsh", status: "disabled")]
        assert(model.installedProviderCount == 1, "Disabled installations are excluded")
        model.device.providers = [installation("codex", status: "unknown"), installation("dsh", status: "unknown")]
        assert(!model.harnessSummaryTitle.contains("0"), "Failed discovery must not report an empty device")
        model.device.providers = [codex, installation("dsh", status: "unknown")]
        assert(model.installedProviderCount == 1 && model.harnessSummaryDetail != nil, "Partial discovery preserves known installations and uncertainty")

        model.device.providers = [codex, dsh]
        model.device.selfTest = snapshot("legacy", provider: nil, daemon: "prior", startedAt: 1000)
        model.device.selfTests = [snapshot("codex", provider: "codex", startedAt: 2000), snapshot("dsh", provider: "dsh", startedAt: 3000)]
        assert(model.allSelfTests.count == 3 && model.latestSelfTest(for: "codex")?.id == "codex", "Legacy records merge without replacing per-Harness latest records")
        assert(model.latestSelfTest(for: "dsh")?.id == "dsh")
        model.openProviderDetails("codex")
        assert(model.rowTestColor(codex) == PanelTheme.accent && !model.selfTestIsHistorical)
        model.refreshError = "synthetic-unavailable"
        assert(model.harnessSummaryTitle.hasPrefix("上次") && model.installedProviderCount == 2, "Refresh failure keeps a clearly historical installation count")
        assert(model.rowTestColor(codex) != PanelTheme.accent && model.selfTestColor != PanelTheme.accent, "Stale success cannot be presented as current")
        model.refreshError = nil
        model.device.daemonId = "restarted"
        assert(model.selfTestIsHistorical && model.rowTestColor(codex) != PanelTheme.accent, "A prior daemon's result is historical")
        model.device.daemonId = nil
        assert(model.selfTestIsHistorical, "No current daemon identity cannot confirm current success")

        model.device.daemonId = "current"
        model.device.selfTest = nil
        model.device.selfTests = [snapshot("running", provider: "codex", state: "running", startedAt: 4000)]
        model.openProviderDetails("dsh")
        assert(model.selectedProvider == "dsh" && model.showVerification, "Another installation can be inspected read-only")
        assert(model.latestSelfTest(for: "codex")?.id == "running" && model.selfTestRunning, "Browsing preserves the running test and its owner")
        assert(!model.canStartSelfTest && model.maintenanceBlocked, "Another Harness's running test blocks all starts and maintenance")
        assert(model.pendingSelfTestId == nil && model.pendingSelfTestProvider == nil, "Browsing does not create a request or change receipt ownership")
        model.openLocalChecks()
        assert(model.selectedProvider == "codex", "An attention action returns to the original test")

        model.device.selfTests = []
        model.device.active = 1
        assert(!model.canStartSelfTest && model.maintenanceBlocked, "Application execution still blocks testing and maintenance")
        model.device.active = 0
        model.device.unresolved = 1
        assert(!model.canStartSelfTest && model.maintenanceBlocked, "Unknown application execution still blocks testing and maintenance")
        assert(model.connectionTitle == "已连接", "Execution uncertainty does not rewrite the service connection fact")
        model.device.unresolved = 0
        assert(model.canStartSelfTest && !model.maintenanceBlocked)
        try await checkTestFeedback(in: temporary, node: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("PASS panel presentation model boundaries")
    }
}
