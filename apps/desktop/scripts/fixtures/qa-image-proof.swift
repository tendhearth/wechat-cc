// Decode only our QA PNG artifacts; this does not access the desktop.
import Foundation
import CoreGraphics
import ImageIO
import CryptoKit

var results: [[String: Any]] = []
for argument in CommandLine.arguments.dropFirst() {
  let file = URL(fileURLWithPath: argument).standardizedFileURL
  precondition(file.path.hasPrefix("/Users/home/cc-ui-lab/"), "QA image must stay inside the mini lab")
  let source = CGImageSourceCreateWithURL(file as CFURL, nil)!
  let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
  let width = image.width, height = image.height
  precondition(width > 0 && height > 0 && width * height < 20_000_000)
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  pixels.withUnsafeMutableBytes { bytes in
    let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  }
  var colors = Set<UInt32>()
  for y in stride(from: 0, to: height, by: max(1, height / 64)) {
    for x in stride(from: 0, to: width, by: max(1, width / 64)) {
      let offset = (y * width + x) * 4
      colors.insert(UInt32(pixels[offset]) << 24 | UInt32(pixels[offset+1]) << 16 | UInt32(pixels[offset+2]) << 8 | UInt32(pixels[offset+3]))
    }
  }
  let digest = SHA256.hash(data: Data(pixels)).map { String(format: "%02x", $0) }.joined()
  results.append(["file": file.lastPathComponent, "width": width, "height": height,
    "sampledColors": colors.count, "pixelSHA256": digest])
}
let data = try! JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
