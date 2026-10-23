import ExpoModulesCore
import DeviceCheck

public class ExpoDeviceCheckModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoDeviceCheck")

    // Generates a short-lived, one-time-use device token for Apple DeviceCheck.
    // The token must be sent to the Elmer backend within ~5 minutes.
    // Rejects with UNSUPPORTED on simulators (DCDevice.current.isSupported = false).
    AsyncFunction("generateTokenAsync") { (promise: Promise) in
      let device = DCDevice.current
      guard device.isSupported else {
        promise.reject(
          "UNSUPPORTED",
          "DeviceCheck is not supported on this device (simulator or unsupported hardware)"
        )
        return
      }
      device.generateToken { data, error in
        if let error = error {
          promise.reject("TOKEN_ERROR", error.localizedDescription)
          return
        }
        guard let data = data else {
          promise.reject("TOKEN_ERROR", "DeviceCheck returned no token data")
          return
        }
        promise.resolve(data.base64EncodedString())
      }
    }
  }
}
