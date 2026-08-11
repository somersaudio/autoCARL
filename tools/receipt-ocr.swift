// receipt-ocr — tiny CLI wrapper around Apple Vision text recognition.
//
//   usage: receipt-ocr <image-path>
//   output: recognized lines, top-to-bottom, one per line on stdout
//
// Compiled as a universal binary into resources/bin/receipt-ocr by
// `npm run build:ocr` (see package.json). The app shells out to it for every
// image receipt — OCR stays fully on-device, no cloud, no API keys.
import Foundation
import Vision
import AppKit

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: receipt-ocr <image-path>\n".data(using: .utf8)!)
    exit(2)
}
let url = URL(fileURLWithPath: args[1])
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("receipt-ocr: could not read image\n".data(using: .utf8)!)
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    FileHandle.standardError.write("receipt-ocr: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(4)
}

// Sort top-to-bottom (Vision's normalized origin is bottom-left).
let observations = (request.results ?? []).sorted { $0.boundingBox.midY > $1.boundingBox.midY }
let lines = observations.compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
