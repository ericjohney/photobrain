import ExpoModulesCore
import Foundation

private let migrationDefaultsKey = "com.photobrain.migration.v1"
private let migrationSchemaVersion = 1

private enum MigrationTheme: String, Codable {
  case system
  case light
  case dark
}

private struct MigrationEnvelope: Codable {
  let schemaVersion: Int
  var theme: MigrationTheme
  var activeScanId: UUID?

  private enum CodingKeys: String, CodingKey {
    case schemaVersion
    case theme
    case activeScanId
  }

  init(schemaVersion: Int = migrationSchemaVersion, theme: MigrationTheme, activeScanId: UUID?) {
    self.schemaVersion = schemaVersion
    self.theme = theme
    self.activeScanId = activeScanId
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard
      container.allKeys.count == 3,
      container.contains(.schemaVersion),
      container.contains(.theme),
      container.contains(.activeScanId)
    else {
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Migration envelope fields are invalid")
      )
    }

    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    theme = try container.decode(MigrationTheme.self, forKey: .theme)
    activeScanId = try container.decodeIfPresent(UUID.self, forKey: .activeScanId)
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(schemaVersion, forKey: .schemaVersion)
    try container.encode(theme, forKey: .theme)
    if let activeScanId {
      try container.encode(activeScanId, forKey: .activeScanId)
    } else {
      try container.encodeNil(forKey: .activeScanId)
    }
  }
}

private enum StoredEnvelope {
  case absent
  case invalid
  case valid(MigrationEnvelope)
}

public final class PhotoBrainMigrationBridgeModule: Module {
  private let defaults = UserDefaults.standard
  private let storageQueue = DispatchQueue(label: "com.photobrain.migration-bridge.storage")
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()

  public func definition() -> ModuleDefinition {
    Name("PhotoBrainMigrationBridge")

    AsyncFunction("readEnvelope") { () -> [String: Any] in
      self.storageQueue.sync {
        switch self.readStoredEnvelope() {
        case .absent:
          return ["status": "absent"]
        case .invalid:
          return ["status": "invalid"]
        case .valid(let envelope):
          let activeScanIdValue: Any
          if let activeScanId = envelope.activeScanId {
            activeScanIdValue = activeScanId.uuidString.lowercased()
          } else {
            activeScanIdValue = NSNull()
          }
          return [
            "status": "valid",
            "envelope": [
              "schemaVersion": envelope.schemaVersion,
              "theme": envelope.theme.rawValue,
              "activeScanId": activeScanIdValue
            ]
          ]
        }
      }
    }

    AsyncFunction("initializeEnvelope") {
      (themeValue: String, activeScanIdValue: String?) -> Bool in
      guard let theme = MigrationTheme(rawValue: themeValue) else {
        return false
      }

      let activeScanId: UUID?
      if let activeScanIdValue {
        guard let parsed = UUID(uuidString: activeScanIdValue) else {
          return false
        }
        activeScanId = parsed
      } else {
        activeScanId = nil
      }

      return self.initializeEnvelope(theme: theme, activeScanId: activeScanId)
    }

    AsyncFunction("setTheme") { (themeValue: String) -> Bool in
      guard let theme = MigrationTheme(rawValue: themeValue) else {
        return false
      }
      return self.updateEnvelope { envelope in
        envelope.theme = theme
      }
    }

    AsyncFunction("setActiveScanId") { (activeScanIdValue: String?) -> Bool in
      let activeScanId: UUID?
      if let activeScanIdValue {
        guard let parsed = UUID(uuidString: activeScanIdValue) else {
          return false
        }
        activeScanId = parsed
      } else {
        activeScanId = nil
      }

      return self.updateEnvelope { envelope in
        envelope.activeScanId = activeScanId
      }
    }
  }

  private func readStoredEnvelope() -> StoredEnvelope {
    guard let storedValue = defaults.object(forKey: migrationDefaultsKey) else {
      return .absent
    }
    guard
      let data = storedValue as? Data,
      let jsonObject = try? JSONSerialization.jsonObject(with: data),
      let jsonDictionary = jsonObject as? [String: Any],
      Set(jsonDictionary.keys) == Set(["schemaVersion", "theme", "activeScanId"]),
      let envelope = try? decoder.decode(MigrationEnvelope.self, from: data),
      envelope.schemaVersion == migrationSchemaVersion
    else {
      return .invalid
    }
    return .valid(envelope)
  }

  private func initializeEnvelope(theme: MigrationTheme, activeScanId: UUID?) -> Bool {
    storageQueue.sync {
      guard case .absent = readStoredEnvelope() else {
        return false
      }
      return writeEnvelope(MigrationEnvelope(theme: theme, activeScanId: activeScanId))
    }
  }

  private func updateEnvelope(_ update: (inout MigrationEnvelope) -> Void) -> Bool {
    storageQueue.sync {
      var envelope: MigrationEnvelope
      switch readStoredEnvelope() {
      case .absent:
        envelope = MigrationEnvelope(theme: .system, activeScanId: nil)
      case .invalid:
        return false
      case .valid(let storedEnvelope):
        envelope = storedEnvelope
      }

      update(&envelope)
      return writeEnvelope(envelope)
    }
  }

  private func writeEnvelope(_ envelope: MigrationEnvelope) -> Bool {
    guard let encoded = try? encoder.encode(envelope) else {
      return false
    }
    defaults.set(encoded, forKey: migrationDefaultsKey)
    return true
  }
}
