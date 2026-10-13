import CoreLocation
import UIKit

/// GPS til web-appen. Uden for en tur kører den kun, mens appen er fremme.
/// Under en tur kører den også i baggrunden (blå pille i statuslinjen), og positionerne gemmes,
/// til web-appen er fremme igen – også hvis iOS lukker appen imens.
final class LocationService: NSObject, CLLocationManagerDelegate {
    struct Fix: Codable { let lat: Double; let lon: Double; let acc: Double; let t: Double }

    private let manager = CLLocationManager()
    private let pendingKey = "ravjagt.pendingFixes"
    private let trackingKey = "ravjagt.tracking"
    private(set) var tracking: Bool

    /// Kaldes med nye positioner, når appen er fremme
    var deliver: (([Fix]) -> Void)?
    var deliverHeading: ((Double) -> Void)?

    override init() {
        tracking = UserDefaults.standard.bool(forKey: trackingKey)
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5
        manager.activityType = .fitness
        manager.pausesLocationUpdatesAutomatically = false
        manager.headingFilter = 3
    }

    /// Appen er fremme: vis din position og kompasretning
    func startForeground() {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { manager.startUpdatingHeading() }
        if tracking { enableBackground(true) }
    }

    /// Appen er i baggrunden: stop GPS'en, medmindre en tur er i gang
    func enterBackground() {
        manager.stopUpdatingHeading()
        if !tracking { manager.stopUpdatingLocation() }
    }

    func startTrip() {
        tracking = true
        UserDefaults.standard.set(true, forKey: trackingKey)
        enableBackground(true)
        manager.startUpdatingLocation()
    }

    func stopTrip() {
        tracking = false
        UserDefaults.standard.set(false, forKey: trackingKey)
        enableBackground(false)
        if UIApplication.shared.applicationState != .active { manager.stopUpdatingLocation() }
    }

    private func enableBackground(_ on: Bool) {
        // Kræver "location" i UIBackgroundModes og tilladelse "Mens appen bruges" (eller "Altid")
        guard manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways else { return }
        manager.allowsBackgroundLocationUpdates = on
        manager.showsBackgroundLocationIndicator = on
    }

    /// Seneste kendte position – sendes, når web-appen melder klar, så den ikke skal vente på en ny
    var lastFix: Fix? {
        guard let l = manager.location, l.horizontalAccuracy >= 0 else { return nil }
        return Fix(lat: l.coordinate.latitude, lon: l.coordinate.longitude, acc: l.horizontalAccuracy, t: l.timestamp.timeIntervalSince1970 * 1000)
    }

    /// Positioner fra baggrunden, som web-appen ikke har fået endnu
    func takePending() -> [Fix] {
        guard let data = UserDefaults.standard.data(forKey: pendingKey),
              let fixes = try? JSONDecoder().decode([Fix].self, from: data) else { return [] }
        UserDefaults.standard.removeObject(forKey: pendingKey)
        return fixes
    }

    private func storePending(_ new: [Fix]) {
        var all = takePendingWithoutClearing()
        all.append(contentsOf: new)
        if all.count > 20000 { all.removeFirst(all.count - 20000) }
        if let data = try? JSONEncoder().encode(all) { UserDefaults.standard.set(data, forKey: pendingKey) }
    }

    private func takePendingWithoutClearing() -> [Fix] {
        guard let data = UserDefaults.standard.data(forKey: pendingKey) else { return [] }
        return (try? JSONDecoder().decode([Fix].self, from: data)) ?? []
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            manager.startUpdatingLocation()
            if tracking { enableBackground(true) }
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let fixes = locations
            .filter { $0.horizontalAccuracy >= 0 }
            .map { Fix(lat: $0.coordinate.latitude, lon: $0.coordinate.longitude, acc: $0.horizontalAccuracy, t: $0.timestamp.timeIntervalSince1970 * 1000) }
        guard !fixes.isEmpty else { return }
        if UIApplication.shared.applicationState == .active, let deliver {
            deliver(fixes)
        } else if tracking {
            storePending(fixes)
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        let h = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        deliverHeading?(h)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}
