import Foundation
import AVFoundation
import CoreML
import Accelerate

// Mirror React Native's RCT promise block typedefs so this file compiles
// without depending on the React umbrella header being visible to Swift.
typealias PromiseResolveBlock = (Any?) -> Void
typealias PromiseRejectBlock = (String?, String?, Error?) -> Void

@objc(SoundClassifier)
class SoundClassifier: NSObject {

    static let SAMPLE_RATE: Double = 16000
    static let AUDIO_SAMPLES: Int = 164080  // must match convert_to_coreml_v2.py
    // Only feed the most recent ~3 seconds of real audio to the model.
    // Everything earlier gets zero-padded. This prevents the tail of a
    // prior sound event (e.g. a dog bark that was just classified) from
    // contaminating the next classification when sounds fire back-to-back.
    // Matches the server's 4-second trim window, slightly tighter.
    static let RECENT_AUDIO_SAMPLES: Int = 48000  // 3 seconds at 16kHz

    private var model: MLModel?
    private var labels: [String] = []
    private let modelQueue = DispatchQueue(label: "vibecheck.classifier", qos: .userInitiated)

    @objc static func requiresMainQueueSetup() -> Bool { return false }

    private func resourceBundle() -> Bundle {
        // Resources from `s.resource_bundles` land in `VibeCheckNative.bundle`
        // which is either inside the main app bundle (static pod) or inside
        // the pod's framework bundle.
        let selfBundle = Bundle(for: type(of: self))
        let candidates: [URL?] = [
            selfBundle.url(forResource: "VibeCheckNative", withExtension: "bundle"),
            Bundle.main.url(forResource: "VibeCheckNative", withExtension: "bundle"),
        ]
        for url in candidates {
            if let url = url, let b = Bundle(url: url) { return b }
        }
        return selfBundle
    }

    private func ensureLoaded() throws {
        if model != nil { return }

        let bundle = resourceBundle()
        guard let modelURL = bundle.url(forResource: "ASTClassifier", withExtension: "mlmodelc")
            ?? Bundle.main.url(forResource: "ASTClassifier", withExtension: "mlmodelc") else {
            throw NSError(domain: "SoundClassifier", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "ASTClassifier.mlmodelc not found in bundle"])
        }

        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndGPU
        self.model = try MLModel(contentsOf: modelURL, configuration: config)

        let labelsURL = bundle.url(forResource: "ast_labels", withExtension: "json")
            ?? Bundle.main.url(forResource: "ast_labels", withExtension: "json")
        if let url = labelsURL,
           let data = try? Data(contentsOf: url),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            let n = dict.count
            var arr = [String](repeating: "", count: n)
            for (k, v) in dict {
                if let i = Int(k), i >= 0 && i < n {
                    arr[i] = v
                }
            }
            self.labels = arr
        }
    }

    /// Read the recorded audio file, downmix to mono, resample to 16 kHz,
    /// and return a Float32 buffer of length exactly AUDIO_SAMPLES (trim/pad).
    private func loadAudio(url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let sourceFormat = file.processingFormat

        guard let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                               sampleRate: Self.SAMPLE_RATE,
                                               channels: 1,
                                               interleaved: false) else {
            throw NSError(domain: "SoundClassifier", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot create 16kHz mono format"])
        }

        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw NSError(domain: "SoundClassifier", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot build audio converter"])
        }

        let sourceFrameCount = AVAudioFrameCount(file.length)
        guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                                  frameCapacity: sourceFrameCount) else {
            throw NSError(domain: "SoundClassifier", code: 4, userInfo: nil)
        }
        try file.read(into: sourceBuffer)

        // Output buffer: capacity a bit larger than needed in case of conversion jitter.
        let expectedOutFrames = AVAudioFrameCount(
            Double(sourceFrameCount) * Self.SAMPLE_RATE / sourceFormat.sampleRate + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat,
                                               frameCapacity: expectedOutFrames) else {
            throw NSError(domain: "SoundClassifier", code: 5, userInfo: nil)
        }

        var didProvide = false
        var convError: NSError?
        let status = converter.convert(to: outBuffer, error: &convError) { _, outStatus in
            if didProvide {
                outStatus.pointee = .endOfStream
                return nil
            }
            didProvide = true
            outStatus.pointee = .haveData
            return sourceBuffer
        }
        if status == .error || convError != nil {
            throw convError ?? NSError(domain: "SoundClassifier", code: 6,
                                       userInfo: [NSLocalizedDescriptionKey: "Converter failed"])
        }

        let outFrames = Int(outBuffer.frameLength)
        guard let ch = outBuffer.floatChannelData?[0] else {
            throw NSError(domain: "SoundClassifier", code: 7, userInfo: nil)
        }

        // Take only the last RECENT_AUDIO_SAMPLES of real audio and place them
        // at the START of the 10.25s buffer (zero-pad the end). This mirrors
        // the HuggingFace ASTFeatureExtractor's pad-at-end convention used by
        // the original server, and it caps how far back in time the model can
        // "see" — so a sound that ended 5+ seconds ago can't bias the current
        // classification.
        var samples = [Float](repeating: 0, count: Self.AUDIO_SAMPLES)
        let recent = min(outFrames, Self.RECENT_AUDIO_SAMPLES)
        let srcStart = outFrames - recent
        for i in 0..<recent {
            samples[i] = ch[srcStart + i]
        }

        return samples
    }

    private func softmax(_ logits: [Float]) -> [Float] {
        guard let maxVal = logits.max() else { return logits }
        var shifted = logits.map { $0 - maxVal }
        var expVals = [Float](repeating: 0, count: shifted.count)
        var count = Int32(shifted.count)
        vvexpf(&expVals, &shifted, &count)
        let sum = expVals.reduce(0, +)
        guard sum > 0 else { return logits }
        return expVals.map { $0 / sum }
    }

    @objc(classifyFile:resolver:rejecter:)
    func classifyFile(_ filePath: String,
                      resolver resolve: @escaping PromiseResolveBlock,
                      rejecter reject: @escaping PromiseRejectBlock) {

        modelQueue.async {
            do {
                try self.ensureLoaded()
                guard let model = self.model else {
                    reject("E_NO_MODEL", "Model failed to load", nil); return
                }

                // Normalize file path — JS sometimes passes "file:///..."
                let rawPath: String
                if filePath.hasPrefix("file://") {
                    rawPath = URL(string: filePath)?.path ?? filePath
                } else {
                    rawPath = filePath
                }
                let url = URL(fileURLWithPath: rawPath)

                let samples = try self.loadAudio(url: url)

                // Build MLMultiArray of shape (1, AUDIO_SAMPLES)
                let shape: [NSNumber] = [1, NSNumber(value: Self.AUDIO_SAMPLES)]
                let input = try MLMultiArray(shape: shape, dataType: .float32)
                let ptr = input.dataPointer.bindMemory(to: Float.self, capacity: Self.AUDIO_SAMPLES)
                for i in 0..<Self.AUDIO_SAMPLES {
                    ptr[i] = samples[i]
                }

                let featureProvider = try MLDictionaryFeatureProvider(dictionary: ["audio": input])
                let output = try model.prediction(from: featureProvider)

                guard let logitsArr = output.featureValue(for: "logits")?.multiArrayValue else {
                    reject("E_NO_OUTPUT", "Model has no 'logits' output", nil); return
                }

                let n = logitsArr.count
                var logits = [Float](repeating: 0, count: n)
                let lp = logitsArr.dataPointer.bindMemory(to: Float.self, capacity: n)
                for i in 0..<n { logits[i] = lp[i] }

                let probs = self.softmax(logits)

                // Top-10
                let topK = 10
                let indexed = probs.enumerated().map { ($0.offset, $0.element) }
                let sorted = indexed.sorted { $0.1 > $1.1 }.prefix(topK)

                var results: [[String: Any]] = []
                for (i, p) in sorted {
                    let label = (i < self.labels.count && !self.labels[i].isEmpty)
                        ? self.labels[i] : "class_\(i)"
                    results.append(["label": label, "score": Double(p)])
                }
                resolve(["results": results])
            } catch {
                reject("E_CLASSIFY", error.localizedDescription, error as NSError)
            }
        }
    }
}
