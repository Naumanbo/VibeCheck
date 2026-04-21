Pod::Spec.new do |s|
  s.name         = "VibeCheckNative"
  s.version      = "1.0.0"
  s.summary      = "On-device AST sound classifier for VibeCheck"
  s.author       = "VibeCheck"
  s.license      = { :type => "MIT" }
  s.homepage     = "https://github.com/vibecheck"
  s.platform     = :ios, "16.0"
  s.source       = { :path => "." }
  s.source_files = "*.{swift,h,m}"
  s.resource_bundles = {
    "VibeCheckNative" => ["ASTClassifier.mlpackage", "ast_labels.json"]
  }
  s.swift_version = "5.0"

  s.dependency "React-Core"
end
