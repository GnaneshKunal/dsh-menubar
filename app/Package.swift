// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DSHMenubar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DSHMenubar",
            path: "Sources/DSHMenubar",
            resources: [
                .copy("Resources/ui.html"),
                .copy("Resources/vendor"),
                .copy("Resources/whale.svg")
            ]
        )
    ]
)
