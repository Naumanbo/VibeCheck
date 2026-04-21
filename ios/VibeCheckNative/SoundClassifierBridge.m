#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SoundClassifier, NSObject)

RCT_EXTERN_METHOD(classifyFile:(NSString *)filePath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
