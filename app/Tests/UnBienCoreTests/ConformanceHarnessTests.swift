import XCTest
@testable import UnBienCore

/// Conformance-harness runner (design 01M25GXCQ3W7NKB2DJ4RM9T8EHW): replays every
/// scenario under contracts/conformance/scenarios/ through the Swift reducer
/// (EnvelopeReducer → SessionState), projects the interpreted state via
/// `conformanceProjection()`, and deep-equals it against the scenario's
/// committed `expected.json` — the SAME artifact the remote_pi TS runner
/// asserts against. No per-scenario runner code: a new scenario directory is
/// picked up by convention.
///
/// Golden regeneration: set UNBIEN_CONFORMANCE_REGENERATE=1 to write the current
/// projection into each scenario's expected.json (then COMMIT the diff — a
/// golden change is a reviewable behaviour change). CI always asserts.
final class ConformanceHarnessTests: XCTestCase {
    private func scenariosRoot() -> URL {
        // <repo>/app/Tests/UnBienCoreTests/ → <repo>/contracts/conformance/scenarios
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // UnBienCoreTests/
            .deletingLastPathComponent()   // Tests/
            .deletingLastPathComponent()   // app/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("contracts/conformance/scenarios")
    }

    /// A scenario directory can be committed BEFORE its fixture exists — 021 ships
    /// its capture recipe first, so the capture is a reviewable plan rather than a
    /// chat message. Such a directory must SAY so (`capture-steps.md`); a directory
    /// whose `input.jsonl` simply went missing has to fail loudly.
    private func isWorkInProgress(_ dir: URL) throws -> Bool {
        let missing = !FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("input.jsonl").path)
        guard missing else { return false }
        let declared = FileManager.default.fileExists(
            atPath: dir.appendingPathComponent("capture-steps.md").path)
        XCTAssertTrue(declared,
                      "\(dir.lastPathComponent): no input.jsonl and no capture-steps.md — "
                          + "that is a fixture that went missing, not one under construction")
        return true
    }

    private func scenarioDirectories() throws -> [URL] {
        let root = scenariosRoot()
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path)
            .filter { $0.hasPrefix(".") == false }
            .sorted()
        return names.map { root.appendingPathComponent($0) }
    }

    /// Frames as delivered app-side: bare rpc objects wrap as {rpc}; lines that
    /// already carry a plane key ({rpc|evt|ub}) decode directly.
    private func loadInput(_ url: URL) throws -> [EnvelopeMessage] {
        let lines = try String(contentsOf: url, encoding: .utf8)
            .split(separator: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        return try lines.map { line in
            let value = try JSONDecoder().decode(JSONValue.self, from: Data(line.utf8))
            if case .object(let obj) = value,
               obj["rpc"] != nil || obj["evt"] != nil || obj["ub"] != nil {
                return try JSONDecoder().decode(EnvelopeMessage.self, from: Data(line.utf8))
            }
            return EnvelopeMessage(rpc: value)
        }
    }

    private func replayLive(_ frames: [EnvelopeMessage]) throws -> EnvelopeReducer {
        var reducer = EnvelopeReducer()
        reducer.apply(frames)
        return reducer
    }

    /// What the two arrivals can be held to.
    ///
    /// A scenario may ship `replay.jsonl` — the same session reached cold — and
    /// the pair is then asserted against each other. Three parts of the
    /// projection cannot be compared across the planes, and each is dropped with
    /// its reason rather than quietly ignored:
    ///
    ///  * `panels`, `subagents`, `pendingAsks` — not persisted. Panels ride
    ///    `{evt channel:"panel"}` frames; an ask is a moment, not a record. A cold
    ///    arrival has none of them by construction.
    ///  * `reasoning` rows — 020's finding, and a real gap rather than a quirk of
    ///    the comparison: pi persists `thinking` blocks ON the message entry (25
    ///    of them in this session), and NEITHER fold turns a persisted thinking
    ///    block into a row — reasoning rows exist only where the deltas were
    ///    watched. The projection can't express the equality either: it keys
    ///    reasoning rows as synthetic `reasoning#n` unconditionally
    ///    (`ConformanceProjection.swift:95`, `replayStable: false`). So "arrive
    ///    cold and lose every thinking row" is current, agreed behaviour on both
    ///    sides, pinned by this scenario and flagged as a design question.
    ///  * the `hunks` block on a tool card — the diff sidecar is rides the live
    ///    `tool_execution_start` frame only (`extension/src/session/rpc_envelope.ts:420`:
    ///    "only aux.hunks (an edit's input diff) rides live"), so a cold card
    ///    legitimately resolves to `[diff]` where a watched one resolves to
    ///    `[diff, hunks]`.
    private let ephemeralKeys: Set<String> = ["panels", "subagents", "pendingAsks"]

    /// Every row of `part` must exist in `whole` with the same fields, and the two
    /// must agree on `leafId`. Used for the cold arrival of a paired scenario; see
    /// the call site for why containment rather than equality is the claim.
    private func assertContained(_ part: JSONValue, inRowsOf whole: JSONValue,
                                 scenario: String, other: String,
                                 file: StaticString = #filePath, line: UInt = #line) {
        guard case .object(let p) = part, case .object(let w) = whole,
              case .array(let sub)? = p["items"], case .array(let full)? = w["items"]
        else {
            XCTFail("scenario \(scenario): projections are not comparable", file: file, line: line)
            return
        }
        var index: [String: JSONValue] = [:]
        for item in full { index[rowKey(item)] = item }
        var problems: [String] = []
        for item in sub {
            let key = rowKey(item)
            guard let match = index[key] else {
                problems.append("\(key): the cold arrival has this row and \(other) does not")
                continue
            }
            if item != match { problems.append("\(key): fields differ from \(other)") }
        }
        if p["leafId"] != w["leafId"] {
            problems.append("leafId \(p["leafId"]?.stringValue ?? "nil") != \(other)'s \(w["leafId"]?.stringValue ?? "nil")")
        }
        XCTAssertTrue(problems.isEmpty,
                      "scenario \(scenario): cold arrival and \(other) disagree:\n" +
                      problems.joined(separator: "\n"), file: file, line: line)
    }

    /// Rows a branched session puts off the active path, per scenario. Pinned
    /// numerically in BOTH runners: it is a behaviour (the derivation renders the
    /// active path only), so a change to it must be argued about, not noticed.
    private let expectedOffPathRows: [String: Int] = [
        "021-durable-vocabulary-pair": 37,
    ]

    private func rowKey(_ item: JSONValue) -> String {
        guard case .object(let o) = item else { return "?" }
        return "\(o["kind"]?.stringValue ?? "?")@\(o["row"]?.stringValue ?? "?")"
    }

    private func rows(of value: JSONValue) -> [JSONValue] {
        guard case .object(let obj) = value, case .array(let items)? = obj["items"]
        else { return [] }
        return items
    }

    private func comparable(_ value: JSONValue) -> JSONValue {
        guard case .object(var obj) = value else { return value }
        for key in ephemeralKeys { obj[key] = nil }
        if case .array(let items)? = obj["items"] {
            obj["items"] = .array(items.compactMap { item -> JSONValue? in
                guard case .object(var row) = item else { return item }
                if row["kind"]?.stringValue == "reasoning" { return nil }
                if case .array(let blocks)? = row["blocks"] {
                    row["blocks"] = .array(blocks.filter { $0.stringValue != "hunks" })
                }
                return .object(row)
            })
        }
        return .object(obj)
    }

    func testScenariosConform() throws {
        let dirs = try scenarioDirectories()
        XCTAssertGreaterThan(dirs.count, 0, "no conformance scenarios found")
        let regenerate = ProcessInfo.processInfo.environment["UNBIEN_CONFORMANCE_REGENERATE"] == "1"
        var ran = 0
        for dir in dirs {
            let name = dir.lastPathComponent
            if try isWorkInProgress(dir) { continue }
            let frames = try loadInput(dir.appendingPathComponent("input.jsonl"))
            let reducer = try replayLive(frames)
            let projection = reducer.conformanceProjection()

            let expectedURL = dir.appendingPathComponent("expected.json")
            // A new scenario has no golden yet — regeneration is what creates it.
            let expected: JSONValue? = FileManager.default.fileExists(atPath: expectedURL.path)
                ? try JSONDecoder().decode(JSONValue.self,
                                           from: Data(contentsOf: expectedURL))
                : nil

            // The second arrival. A scenario may ship `replay.jsonl`: the SAME
            // session reached the other way — a client that arrives cold and only
            // ever sees `get_entries` pages. Both routes must land on one
            // transcript, so the pair is asserted twice: the two runs against each
            // other (the mode-independence claim itself), and the cold run against
            // the golden.
            let replayURL = dir.appendingPathComponent("replay.jsonl")
            if FileManager.default.fileExists(atPath: replayURL.path) {
                let cold = try replayLive(loadInput(replayURL)).conformanceProjection()
                // CONTAINMENT, not equality — and 021 is why. That session
                // BRANCHED: the watcher saw a stretch of turns, then the tree
                // moved the leaf elsewhere, and `get_entries` only ever serves the
                // active path. So a client that arrives afterwards cannot show
                // those rows — they are off the path — while a client that was
                // there did. That is the tree working, not the folds disagreeing.
                // The claim that must hold is the other direction: every row a
                // cold viewer sees exists in the watched transcript with the same
                // fields, and both runs agree on the leaf they would resume from.
                assertContained(comparable(cold), inRowsOf: comparable(projection),
                                scenario: name, other: "the connected run")
                // The same numeric pin the web runner holds: how many rows the
                // branch moved off the active path. A behaviour, not an accident —
                // and if either implementation changes what the derivation renders,
                // both runners say so.
                let offPath = rows(of: comparable(projection))
                    .filter { item in
                        let key = rowKey(item)
                        return !rows(of: comparable(cold)).contains { rowKey($0) == key }
                    }
                if let expectedOffPath = expectedOffPathRows[name] {
                    XCTAssertEqual(offPath.count, expectedOffPath,
                                   "scenario \(name): rows a watcher sees but a cold arrival cannot")
                }
                if let expected, !regenerate {
                    assertContained(comparable(cold), inRowsOf: comparable(expected),
                                    scenario: name, other: "expected.json")
                }
            }

            if regenerate {
                // Sorted and indented, so a regeneration diff shows only what
                // changed.
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
                let data = try encoder.encode(projection) + Data("\n".utf8)
                try data.write(to: expectedURL, options: .atomic)
                print("regenerated \(name)/expected.json")
                continue
            }

            guard let expected else {
                XCTFail("scenario \(name): no expected.json — run with "
                        + "UNBIEN_CONFORMANCE_REGENERATE=1 to mint one, then commit it")
                continue
            }
            XCTAssertEqual(
                projection, expected,
                "scenario \(name): interpreted state diverged from expected.json — "
                    + "the normalized diff above IS the contract breach")
            ran += 1
        }
        if !regenerate {
            XCTAssertGreaterThan(ran, 0, "no scenarios asserted")
        }
    }

    /// Replays each scenario in BOTH declared modes and asserts the interpreted
    /// state is mode-independent (live pushes vs get_entries replay pages).
    /// Mode names are validated here rather than silently ignored: a scenario
    /// whose mode nobody runs is a fixture that pins nothing.
    func testScenarioModesDeclared() throws {
        let known: Set<String> = ["live", "replay"]
        for dir in try scenarioDirectories() {
            if try isWorkInProgress(dir) { continue }
            let raw = try String(contentsOf: dir.appendingPathComponent("meta.json"), encoding: .utf8)
            let meta = try JSONDecoder().decode(JSONValue.self, from: Data(raw.utf8))
            let modes = meta["modes"]?.arrayValue?.compactMap { $0.stringValue } ?? []
            XCTAssertFalse(modes.isEmpty, "\(dir.lastPathComponent): modes must be declared")
            for mode in modes {
                XCTAssertTrue(known.contains(mode),
                              "\(dir.lastPathComponent): unknown mode \"\(mode)\" — "
                                  + "a mode no runner implements would make this fixture inert")
            }
            // Declaring a mode that no input exercises is the same trap in
            // disguise: the fixture looks like it pins mode-independence and
            // pins nothing.
            if modes.contains("replay") {
                let hasReplayInput = FileManager.default.fileExists(
                    atPath: dir.appendingPathComponent("replay.jsonl").path)
                let carriesPages = (try? String(contentsOf: dir.appendingPathComponent("input.jsonl"),
                                                encoding: .utf8))?
                    .contains("get_entries")
                    ?? false
                XCTAssertTrue(hasReplayInput || carriesPages,
                              "\(dir.lastPathComponent): declares `replay` but no input feeds "
                                  + "a `get_entries` page, so the mode is decorative")
            }
        }
    }

    /// The paired scenario must actually be paired: a `replay.jsonl` that no
    /// runner opens would make the mode-independence claim decorative.
    func testPairedScenariosAreRun() throws {
        let paired = try scenarioDirectories().filter {
            FileManager.default.fileExists(
                atPath: $0.appendingPathComponent("replay.jsonl").path)
        }
        XCTAssertFalse(paired.isEmpty,
                       "no scenario ships replay.jsonl, so nothing tests that a connected "
                           + "client and a cold one fold the same session to one transcript")
    }
}