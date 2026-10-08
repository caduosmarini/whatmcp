import Foundation
import SQLite3
import Darwin

// Private inherited stdin/stdout, no listener, install, privilege elevation or TCC mutation.
struct Request: Decodable { let sourceHome: String; let output: String; let mediaOutput: String; let expiresAt: Double }
struct Failure: Error { let reason: String }
let fm = FileManager.default
func fail(_ text: String) throws -> Never { throw Failure(reason: text) }
func noLinks(_ path: String) throws {
    var url = URL(fileURLWithPath: path).standardizedFileURL
    while url.path != "/" {
        if fm.fileExists(atPath: url.path), (try url.resourceValues(forKeys: [.isSymbolicLinkKey])).isSymbolicLink == true { try fail("Symbolic links are not allowed in capture paths") }
        url.deleteLastPathComponent()
    }
}
func metadata(_ path: String) throws -> String {
    try noLinks(path)
    guard fm.fileExists(atPath: path) else { return "missing" }
    let a = try fm.attributesOfItem(atPath: path)
    guard a[.type] as? FileAttributeType == .typeRegular else { try fail("Capture source must be a regular file") }
    return "\(a[.systemFileNumber] ?? 0):\(a[.size] ?? 0):\((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0)"
}
func capture(_ request: Request) throws -> [String: Any] {
    let remaining = request.expiresAt / 1000 - Date().timeIntervalSince1970
    guard remaining > 0, remaining <= 301 else { try fail("Capture authorization is expired or invalid") }
    let deadline = ProcessInfo.processInfo.systemUptime + remaining
    func check() throws { guard ProcessInfo.processInfo.systemUptime < deadline, Date().timeIntervalSince1970 * 1000 < request.expiresAt else { try fail("Capture authorization expired") } }
    guard request.sourceHome.hasPrefix("/"), request.output.hasPrefix("/"), request.mediaOutput.hasPrefix("/") else { try fail("Capture paths must be absolute") }
    let group = URL(fileURLWithPath: request.sourceHome).appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared")
    let output = URL(fileURLWithPath: request.output).standardizedFileURL
    let media = URL(fileURLWithPath: request.mediaOutput).standardizedFileURL
    guard !output.path.hasPrefix(group.path + "/"), !media.path.hasPrefix(group.path + "/"), output.path != media.path else { try fail("Output must be separate from WhatsApp") }
    try noLinks(output.path); try noLinks(media.path)
    try fm.createDirectory(at: output, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard try fm.contentsOfDirectory(atPath: output.path).isEmpty else { try fail("Capture output must be empty") }
    try fm.createDirectory(at: media, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    func copy(_ source: String, _ target: String, limit: Int64) throws {
        try check(); try noLinks(source); try noLinks(target)
        let a = try fm.attributesOfItem(atPath: source)
        guard a[.type] as? FileAttributeType == .typeRegular, let size = a[.size] as? NSNumber, size.int64Value <= limit else { try fail("Capture file exceeds size limit") }
        let fd = open(source, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { try fail("Cannot read WhatsApp source; check access permission") }
        let input = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        try fm.createDirectory(at: URL(fileURLWithPath: target).deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let out = open(target, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard out >= 0 else { try fail("Cannot create private capture file") }
        let handle = FileHandle(fileDescriptor: out, closeOnDealloc: true)
        defer { try? input.close(); try? handle.close() }
        var copied: Int64 = 0
        while let chunk = try input.read(upToCount: 65536), !chunk.isEmpty { try check(); copied += Int64(chunk.count); guard copied <= limit else { try fail("Capture file grew beyond size limit") }; try handle.write(contentsOf: chunk) }
        guard copied == size.int64Value else { try fail("Source changed during capture; retry") }
    }
    let live = group.appendingPathComponent("ChatStorage.sqlite").path
    let staging = output.appendingPathComponent("staging")
    let staged = staging.appendingPathComponent("ChatStorage.sqlite").path
    var stable = false
    // Never open the live database in SQLite: even READONLY WAL readers can modify
    // shared-memory metadata. Copy DB+WAL and retry if either changes while copying.
    for _ in 0..<3 {
        try check(); try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let before = try [metadata(live), metadata(live + "-wal")]
        guard before[0] != "missing" else { try fail("WhatsApp ChatStorage.sqlite was not found") }
        try copy(live, staged, limit: 2_147_483_648)
        if before[1] != "missing" { try copy(live + "-wal", staged + "-wal", limit: 2_147_483_648) }
        if before == (try [metadata(live), metadata(live + "-wal")]) { stable = true; break }
    }
    guard stable else { try fail("WhatsApp database kept changing; retry when idle") }
    var source: OpaquePointer?, destination: OpaquePointer?
    guard sqlite3_open_v2(staged, &source, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else { try fail("Cannot open capture copy") }
    defer { sqlite3_close(source); try? fm.removeItem(at: staging) }
    var integrity: OpaquePointer?
    guard sqlite3_prepare_v2(source, "PRAGMA quick_check", -1, &integrity, nil) == SQLITE_OK else { try fail("Invalid capture database") }
    defer { sqlite3_finalize(integrity) }
    guard sqlite3_step(integrity) == SQLITE_ROW, String(cString: sqlite3_column_text(integrity, 0)) == "ok" else { try fail("Capture is inconsistent; retry") }
    let snapshot = output.appendingPathComponent("ChatStorage.sqlite").path
    guard sqlite3_open_v2(snapshot, &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else { try fail("Cannot create snapshot") }
    defer { sqlite3_close(destination) }
    guard let backup = sqlite3_backup_init(destination, "main", source, "main") else { try fail("Cannot prepare SQLite backup") }
    var result: Int32 = SQLITE_OK
    repeat { try check(); result = sqlite3_backup_step(backup, 64) } while result == SQLITE_OK
    let finish = sqlite3_backup_finish(backup)
    guard result == SQLITE_DONE, finish == SQLITE_OK else { try fail("SQLite backup failed") }
    chmod(snapshot, 0o600)
    var rows: OpaquePointer?, copied = 0, missing = 0
    let sql = "SELECT DISTINCT media.ZMEDIALOCALPATH FROM ZWAMESSAGE m JOIN ZWAMEDIAITEM media ON media.Z_PK=m.ZMEDIAITEM WHERE m.ZMESSAGETYPE IN (2,3) AND media.ZMEDIALOCALPATH IS NOT NULL"
    if sqlite3_prepare_v2(source, sql, -1, &rows, nil) == SQLITE_OK {
        defer { sqlite3_finalize(rows) }
        while sqlite3_step(rows) == SQLITE_ROW {
            try check()
            guard let raw = sqlite3_column_text(rows, 0) else { continue }
            let path = String(cString: raw)
            guard !path.hasPrefix("/"), !path.split(separator: "/").contains(".."), !path.contains("\\"), !path.isEmpty else { missing += 1; continue }
            let from = group.appendingPathComponent("Message").appendingPathComponent(path).path
            let to = media.appendingPathComponent(path).path
            if !fm.fileExists(atPath: from) { missing += 1; continue }
            let temporary = to + "." + UUID().uuidString + ".tmp"
            do { try copy(from, temporary, limit: 100_000_000); try noLinks(to); if fm.fileExists(atPath: to) { try fm.removeItem(atPath: to) }; try fm.moveItem(atPath: temporary, toPath: to); copied += 1 }
            catch let e as Failure { try? fm.removeItem(atPath: temporary); if e.reason.contains("expired") { throw e }; missing += 1 }
            catch { try? fm.removeItem(atPath: temporary); missing += 1 }
        }
    }
    return ["snapshot": snapshot, "audioCopied": copied, "audioUnavailable": missing]
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard input.count <= 65536 else { try fail("Capture request too large") }
    let result = try capture(JSONDecoder().decode(Request.self, from: input))
    let bytes = try JSONSerialization.data(withJSONObject: result)
    print(String(decoding: bytes, as: UTF8.self))
} catch {
    let message = (error as? Failure)?.reason ?? "Capture failed; check access and retry"
    fputs(message + "\n", stderr); exit(1)
}
