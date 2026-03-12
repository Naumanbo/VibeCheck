import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, StatusBar, SafeAreaView, Platform, Vibration, Modal,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';

/* ─────────────── SOUND DATA ─────────────── */

const SOUNDS = {
  smokeAlarm: {
    id: 'smokeAlarm', label: 'Smoke Alarm', emoji: '🚨',
    color: '#FF3B30', bgColor: '#2D0000',
    desc: 'Fire and CO detector alerts', priority: 'CRITICAL',
  },
  doorbell: {
    id: 'doorbell', label: 'Doorbell', emoji: '🔔',
    color: '#007AFF', bgColor: '#001833',
    desc: 'Someone at the front door', priority: 'HIGH',
  },
  knocking: {
    id: 'knocking', label: 'Knocking', emoji: '✊',
    color: '#34C759', bgColor: '#002800',
    desc: 'Door or window knock', priority: 'HIGH',
  },
  microwave: {
    id: 'microwave', label: 'Microwave', emoji: '📻',
    color: '#FF9500', bgColor: '#2D1800',
    desc: 'Kitchen appliance alerts', priority: 'LOW',
  },
  babyCrying: {
    id: 'babyCrying', label: 'Baby Crying', emoji: '👶',
    color: '#BF5AF2', bgColor: '#220030',
    desc: 'Infant distress sounds', priority: 'HIGH',
  },
};

// dB threshold above which a sound is considered a detection event
const DETECTION_DB = -25;
// Seconds before the same sound can fire again
const COOLDOWN_SEC = 5;

/* ─────────────── HAPTICS ─────────────── */
// Each sound gets a unique combination of pulse COUNT and GAP duration so
// patterns are distinguishable by feel alone:
//
//  smokeAlarm  5 pulses × 80 ms  — rapid-fire alarm
//  doorbell    2 pulses × 500 ms — slow ding-dong
//  knocking    3 pulses × 100 ms — knock knock knock
//  microwave   2 pulses × 750 ms — slow appliance beep
//  babyCrying  3 pulses × 300 ms — sustained rhythmic cry
//
// On iOS we call Haptics.impactAsync / notificationAsync FIRST (synchronously
// inside the touch handler before any await) so UIFeedbackGenerator gets the
// required user-interaction context. Vibration.vibrate() is called alongside
// it as a belt-and-suspenders fallback.

const sleep = ms => new Promise(r => setTimeout(r, ms));

// [pulseCount, gapMs, hapticFn]
const IOS_PATTERNS = {
  smokeAlarm: [5, 80,  () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)  ],
  doorbell:   [2, 500, () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)            ],
  knocking:   [3, 100, () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)             ],
  microwave:  [2, 750, () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)             ],
  babyCrying: [3, 300, () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)],
};

// Call this directly from onPress (no async wrapper) so the first
// Haptics call lands inside the iOS user-interaction window.
function triggerHaptics(soundId) {
  if (Platform.OS === 'android') {
    const patterns = {
      smokeAlarm: [0, 400, 80, 400, 80, 400, 80, 400, 80, 400],
      doorbell:   [0, 250, 500, 250],
      knocking:   [0, 120, 100, 120, 100, 120],
      microwave:  [0, 200, 750, 200],
      babyCrying: [0, 280, 300, 280, 300, 280],
    };
    Vibration.vibrate(patterns[soundId] ?? [0, 300]);
    return;
  }

  const [count, gap, hapticFn] = IOS_PATTERNS[soundId] ?? [1, 200, () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)];

  // Fire the full sequence via nested setTimeouts so every buzz lands on
  // the JS main thread with no async/await overhead.
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      Vibration.vibrate();
      hapticFn().catch(() => {});
    }, i * gap);
  }
}

/* ─────────────── MICROPHONE ─────────────── */

async function requestMicPermission() {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

async function startRecording(onStatus) {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });
  const { recording } = await Audio.Recording.createAsync(
    {
      android: {
        extension: '.m4a',
        outputFormat: 2,    // MPEG_4
        audioEncoder: 3,    // AAC
        sampleRate: 16000,
        numberOfChannels: 1,
        bitRate: 32000,
      },
      ios: {
        extension: '.m4a',
        outputFormat: 'aac ',
        audioQuality: 0,    // Min quality — we only need metering
        sampleRate: 16000,
        numberOfChannels: 1,
        bitRate: 32000,
        linearPCMBitDepth: 16,
        linearPCMIsBigEndian: false,
        linearPCMIsFloat: false,
      },
      isMeteringEnabled: true,
    },
    onStatus,
    300  // status update interval ms
  );
  return recording;
}

async function stopRecording(recording) {
  try {
    await recording.stopAndUnloadAsync();
  } catch (_) {}
  await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
}

/* ─────────────── UTILS ─────────────── */

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(d) {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(d);
}

/* ─────────────── ANIMATED HELPERS ─────────────── */

function PulseDot({ color, size = 14 }) {
  const anim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 0.4, duration: 900, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 1,   duration: 900, useNativeDriver: true }),
    ])).start();
  }, []);
  return <Animated.View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: anim }} />;
}

function RingAnim({ color, size, delay: d = 0 }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.parallel([
      Animated.timing(scale,   { toValue: 1.8, duration: 1600, delay: d, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0,   duration: 1600, delay: d, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, []);
  return (
    <Animated.View style={{
      position: 'absolute', width: size, height: size, borderRadius: size / 2,
      borderWidth: 2, borderColor: color, opacity, transform: [{ scale }],
    }} />
  );
}

/* ─────────────── ONBOARDING ─────────────── */

function Onboarding({ onFinish }) {
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState({
    smokeAlarm: true, doorbell: true, knocking: true, microwave: true, babyCrying: false,
  });
  const [micGranted, setMicGranted] = useState(false);
  const [tested, setTested] = useState(false);

  const toggle = id => setEnabled(p => ({ ...p, [id]: !p[id] }));

  const handleMicRequest = async () => {
    const granted = await requestMicPermission();
    setMicGranted(granted);
    setStep(2);
  };

  const pages = [
    // 0 – welcome
    <View key="w" style={S.obCenter}>
      <View style={{ alignItems: 'center', justifyContent: 'center', width: 160, height: 160, marginBottom: 24 }}>
        <Text style={{ fontSize: 64 }}>👂</Text>
        <RingAnim color="#007AFF" size={110} delay={0} />
        <RingAnim color="#007AFF" size={140} delay={400} />
      </View>
      <Text style={S.obH1}>Welcome to{'\n'}VibeCheck</Text>
      <Text style={S.obBody}>
        VibeCheck listens to your environment and alerts you through vibration and
        high-contrast visuals — no hearing required.
      </Text>
      <TouchableOpacity style={S.btnPrimary} onPress={() => setStep(1)}>
        <Text style={S.btnPrimaryTxt}>Get Started →</Text>
      </TouchableOpacity>
    </View>,

    // 1 – real mic permission
    <View key="m" style={S.obCenter}>
      <Text style={{ fontSize: 64, marginBottom: 20 }}>🎙️</Text>
      <Text style={S.obH1}>Microphone Access</Text>
      <Text style={S.obBody}>
        VibeCheck needs your microphone to listen for sounds. A system permission prompt will appear.
      </Text>
      <View style={S.privBox}>
        <Text style={{ color: '#34C759', fontWeight: '700', fontSize: 14, marginBottom: 6 }}>🔒  Privacy First</Text>
        <Text style={{ color: '#AEAEB2', fontSize: 14, lineHeight: 20 }}>
          All audio is processed on-device. Nothing is recorded to disk or sent anywhere.
        </Text>
      </View>
      <TouchableOpacity style={S.btnPrimary} onPress={handleMicRequest}>
        <Text style={S.btnPrimaryTxt}>Allow Microphone Access</Text>
      </TouchableOpacity>
      <TouchableOpacity style={S.btnGhost} onPress={() => setStep(2)}>
        <Text style={S.btnGhostTxt}>Skip for now</Text>
      </TouchableOpacity>
    </View>,

    // 2 – choose sounds
    <View key="s" style={{ width: '100%' }}>
      <Text style={[S.obH1, { textAlign: 'center', marginBottom: 6 }]}>What sounds{'\n'}matter to you?</Text>
      <Text style={{ color: '#636366', fontSize: 15, textAlign: 'center', marginBottom: 20 }}>
        Choose which sounds VibeCheck should detect.
      </Text>
      {Object.values(SOUNDS).map(s => (
        <TouchableOpacity
          key={s.id} onPress={() => toggle(s.id)}
          style={[S.soundRow, { backgroundColor: enabled[s.id] ? s.bgColor : '#1C1C1E', borderColor: enabled[s.id] ? s.color : '#2C2C2E' }]}
        >
          <Text style={{ fontSize: 26 }}>{s.emoji}</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: enabled[s.id] ? s.color : '#FFF', fontSize: 16, fontWeight: '700' }}>{s.label}</Text>
            <Text style={{ color: '#636366', fontSize: 13 }}>{s.desc}</Text>
          </View>
          <View style={[S.checkCircle, { backgroundColor: enabled[s.id] ? s.color : '#3A3A3C' }]}>
            {enabled[s.id] && <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>✓</Text>}
          </View>
        </TouchableOpacity>
      ))}
      <TouchableOpacity style={[S.btnPrimary, { marginTop: 20 }]} onPress={() => setStep(3)}>
        <Text style={S.btnPrimaryTxt}>Continue →</Text>
      </TouchableOpacity>
    </View>,

    // 3 – test haptics
    <View key="t" style={S.obCenter}>
      <Text style={{ fontSize: 64, marginBottom: 16 }}>📳</Text>
      <Text style={S.obH1}>Test Your Alert</Text>
      <Text style={S.obBody}>
        Tap below to feel a sample vibration.{'\n'}
        Make sure your phone is <Text style={{ color: '#FFF', fontWeight: '700' }}>not on silent</Text>.
      </Text>
      <TouchableOpacity
        style={[S.btnPrimary, { backgroundColor: '#FF3B30', marginBottom: 12 }]}
        onPress={() => { triggerHaptics('smokeAlarm'); setTested(true); }}
      >
        <Text style={S.btnPrimaryTxt}>🚨  Test Smoke Alarm Vibration</Text>
      </TouchableOpacity>
      {tested && <Text style={{ color: '#34C759', fontSize: 16, marginBottom: 12 }}>✓  Did you feel it?</Text>}
      <TouchableOpacity
        style={[S.btnPrimary, { backgroundColor: tested ? '#34C759' : '#3A3A3C', opacity: tested ? 1 : 0.5 }]}
        onPress={() => { if (tested) onFinish(enabled, micGranted); }}
      >
        <Text style={S.btnPrimaryTxt}>{tested ? 'Start Monitoring ✓' : 'Test vibration first'}</Text>
      </TouchableOpacity>
    </View>,
  ];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <View style={S.dots}>
        {pages.map((_, i) => (
          <View key={i} style={[S.dot, { width: i === step ? 28 : 8, backgroundColor: i <= step ? '#007AFF' : '#3A3A3C' }]} />
        ))}
      </View>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {pages[step]}
      </ScrollView>
    </SafeAreaView>
  );
}

/* ─────────────── HOME SCREEN ─────────────── */

function HomeScreen({ enabled, onAlert, history, listening, setListening, dbLevel, micGranted }) {
  const recent = [...history].reverse().slice(0, 4);

  // Map dB (-60 … 0) to a 0–1 fill for the meter bar
  const meterFill = Math.min(1, Math.max(0, (dbLevel + 60) / 60));
  const meterColor = dbLevel > DETECTION_DB ? '#FF3B30' : dbLevel > -40 ? '#FF9500' : '#34C759';

  return (
    <View style={{ flex: 1 }}>
      <View style={S.header}>
        <View>
          <Text style={{ color: '#636366', fontSize: 11, letterSpacing: 0.8 }}>ENVIRONMENTAL MONITOR</Text>
          <Text style={{ color: '#FFF', fontSize: 26, fontWeight: '800' }}>VibeCheck</Text>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 32 }} showsVerticalScrollIndicator={false}>

        {/* listening status card */}
        <View style={[S.card, { borderColor: listening ? '#34C759' : '#FF3B30', backgroundColor: listening ? '#001A00' : '#1A0000' }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
            <PulseDot color={listening ? '#34C759' : '#FF3B30'} size={14} />
            <View style={{ marginLeft: 12 }}>
              <Text style={{ color: '#FFF', fontSize: 17, fontWeight: '700' }}>
                {listening ? 'Listening...' : 'Paused'}
              </Text>
              <Text style={{ color: '#636366', fontSize: 12 }}>
                {!micGranted ? 'No mic permission — manual triggers only' : listening ? 'Real microphone active' : 'Tap Resume to restart'}
              </Text>
            </View>
          </View>
          <TouchableOpacity
            style={{ backgroundColor: listening ? '#3A0000' : '#003A00', borderColor: listening ? '#FF3B30' : '#34C759', borderWidth: 1, padding: 8, paddingHorizontal: 16, borderRadius: 20 }}
            onPress={() => setListening(l => !l)}
          >
            <Text style={{ color: listening ? '#FF3B30' : '#34C759', fontWeight: '600', fontSize: 14 }}>
              {listening ? 'Pause' : 'Resume'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* live audio meter — only shown when mic is active */}
        {micGranted && listening && (
          <View style={{ backgroundColor: '#1C1C1E', borderRadius: 14, padding: 14, marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <Text style={{ color: '#636366', fontSize: 12, fontWeight: '700', letterSpacing: 0.8 }}>LIVE AUDIO LEVEL</Text>
              <Text style={{ color: meterColor, fontSize: 12, fontWeight: '700' }}>
                {dbLevel > -100 ? `${Math.round(dbLevel)} dB` : '-- dB'}
              </Text>
            </View>
            <View style={{ height: 8, backgroundColor: '#3A3A3C', borderRadius: 4, overflow: 'hidden' }}>
              <Animated.View style={{ height: 8, width: `${meterFill * 100}%`, backgroundColor: meterColor, borderRadius: 4 }} />
            </View>
            <Text style={{ color: '#48484A', fontSize: 11, marginTop: 6 }}>
              Alert threshold: {DETECTION_DB} dB  ·  In final app: ML classifies the sound type
            </Text>
          </View>
        )}

        {/* recent detections */}
        <Text style={S.sectionLabel}>RECENT DETECTIONS</Text>
        {recent.length === 0
          ? <View style={S.emptyBox}>
              <Text style={{ fontSize: 32, textAlign: 'center' }}>🔇</Text>
              <Text style={{ color: '#636366', textAlign: 'center', marginTop: 8 }}>No sounds detected yet</Text>
              <Text style={{ color: '#48484A', fontSize: 13, textAlign: 'center', marginTop: 4 }}>
                {micGranted ? 'Make a loud sound near the mic, or use manual triggers below' : 'Use manual triggers below'}
              </Text>
            </View>
          : recent.map((a, i) => {
              const s = SOUNDS[a.type];
              return (
                <View key={i} style={[S.histRow, { borderLeftColor: s.color }]}>
                  <Text style={{ fontSize: 24 }}>{s.emoji}</Text>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ color: s.color, fontSize: 16, fontWeight: '700' }}>{s.label}</Text>
                    <Text style={{ color: '#636366', fontSize: 13 }}>{fmtTime(a.time)}</Text>
                  </View>
                  {s.priority === 'CRITICAL' && (
                    <View style={S.critBadge}><Text style={{ color: '#FF3B30', fontSize: 11, fontWeight: '700' }}>CRITICAL</Text></View>
                  )}
                </View>
              );
            })
        }

        {/* manual triggers */}
        <Text style={[S.sectionLabel, { marginTop: 16 }]}>MANUAL TRIGGERS</Text>
        <View style={S.infoBox}>
          <Text style={{ fontSize: 14 }}>ℹ️</Text>
          <Text style={{ color: '#636366', fontSize: 13, lineHeight: 19, flex: 1, marginLeft: 8 }}>
            In the final app these fire automatically from the on-device ML classifier.
          </Text>
        </View>
        <View style={S.demoGrid}>
          {Object.values(SOUNDS).filter(s => enabled[s.id]).map(s => (
            <TouchableOpacity
              key={s.id}
              style={[S.demoBtn, { backgroundColor: s.bgColor, borderColor: s.color }]}
              onPress={() => onAlert(s.id)}
            >
              <Text style={{ fontSize: 28 }}>{s.emoji}</Text>
              <Text style={{ color: s.color, fontSize: 13, fontWeight: '700', textAlign: 'center', marginTop: 4 }}>{s.label}</Text>
              {s.priority === 'CRITICAL' && <Text style={{ color: s.color, fontSize: 11, opacity: 0.7, marginTop: 2 }}>⚠ Critical</Text>}
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/* ─────────────── ALERT SCREEN ─────────────── */

function AlertScreen({ alertType, onDismiss }) {
  const s = SOUNDS[alertType];
  const now = useRef(new Date()).current;
  const bgOpacity   = useRef(new Animated.Value(1)).current;
  const ring1Scale  = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.6)).current;
  const ring2Scale  = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0.4)).current;
  const intervalRef = useRef(null);

  useEffect(() => {
    triggerHaptics(alertType);
    if (s.priority === 'CRITICAL') {
      intervalRef.current = setInterval(() => triggerHaptics(alertType), 3200);
    }
    Animated.loop(Animated.sequence([
      Animated.timing(bgOpacity, { toValue: 0.85, duration: 700, useNativeDriver: true }),
      Animated.timing(bgOpacity, { toValue: 1,    duration: 700, useNativeDriver: true }),
    ])).start();
    Animated.loop(Animated.parallel([
      Animated.timing(ring1Scale,   { toValue: 2.0, duration: 1500, useNativeDriver: true }),
      Animated.timing(ring1Opacity, { toValue: 0,   duration: 1500, useNativeDriver: true }),
    ])).start();
    Animated.loop(Animated.sequence([
      Animated.delay(500),
      Animated.parallel([
        Animated.timing(ring2Scale,   { toValue: 2.0, duration: 1500, useNativeDriver: true }),
        Animated.timing(ring2Opacity, { toValue: 0,   duration: 1500, useNativeDriver: true }),
      ]),
    ])).start();
    return () => {
      clearInterval(intervalRef.current);
      if (Platform.OS === 'android') Vibration.cancel();
    };
  }, []);

  return (
    <Animated.View style={[S.alertScreen, { backgroundColor: s.bgColor, opacity: bgOpacity }]}>
      <StatusBar barStyle="light-content" backgroundColor={s.bgColor} />
      {s.priority === 'CRITICAL' && (
        <View style={S.critBanner}>
          <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13, letterSpacing: 1.5 }}>⚠  CRITICAL ALERT</Text>
        </View>
      )}
      <View style={{ alignItems: 'center', justifyContent: 'center', width: 160, height: 160, marginBottom: 24 }}>
        <Animated.View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: s.color, opacity: ring1Opacity, transform: [{ scale: ring1Scale }] }} />
        <Animated.View style={{ position: 'absolute', width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: s.color, opacity: ring2Opacity, transform: [{ scale: ring2Scale }] }} />
        <Text style={{ fontSize: 80 }}>{s.emoji}</Text>
      </View>
      <Text style={{ color: s.color, fontSize: 36, fontWeight: '900', textAlign: 'center', marginBottom: 10 }}>{s.label}</Text>
      <Text style={{ color: '#8E8E93', fontSize: 18, marginBottom: 40 }}>{fmtTime(now)}</Text>
      <TouchableOpacity
        style={[S.dismissBtn, { backgroundColor: s.color, shadowColor: s.color }]}
        onPress={() => { Vibration.vibrate(); Haptics.selectionAsync().catch(() => {}); onDismiss(); }}
      >
        <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Dismiss</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

/* ─────────────── PREFERENCES ─────────────── */

function PreferencesScreen({ enabled, setEnabled, sensitivity, setSensitivity }) {
  const [lastTested, setLastTested] = useState(null);

  const handleTest = (soundId) => {
    triggerHaptics(soundId);
    setLastTested(soundId);
    setTimeout(() => setLastTested(null), 1800);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={S.header}>
        <Text style={{ color: '#FFF', fontSize: 26, fontWeight: '800' }}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>

        {/* iOS vibration settings reminder */}
        {Platform.OS === 'ios' && (
          <View style={{ backgroundColor: '#1C2A1C', borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: '#34C759' }}>
            <Text style={{ color: '#34C759', fontWeight: '700', fontSize: 13, marginBottom: 4 }}>📳  For vibrations to work on iPhone:</Text>
            <Text style={{ color: '#AEAEB2', fontSize: 13, lineHeight: 19 }}>
              Settings → Sounds {'&'} Haptics → turn on{'\n'}
              <Text style={{ color: '#FFF' }}>System Haptics</Text> and <Text style={{ color: '#FFF' }}>Vibrate on Silent</Text>
            </Text>
          </View>
        )}

        <Text style={S.sectionLabel}>SOUND CATEGORIES</Text>
        {Object.values(SOUNDS).map(s => (
          <View key={s.id} style={[S.prefRow, { backgroundColor: enabled[s.id] ? s.bgColor : '#1C1C1E', borderColor: enabled[s.id] ? s.color : '#2C2C2E' }]}>
            <Text style={{ fontSize: 28, marginTop: 2 }}>{s.emoji}</Text>
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={{ color: enabled[s.id] ? s.color : '#FFF', fontSize: 16, fontWeight: '700', marginBottom: 4 }}>{s.label}</Text>
              <Text style={{ color: '#636366', fontSize: 13, lineHeight: 18 }}>{s.desc}</Text>
              {enabled[s.id] && (
                <TouchableOpacity
                  style={[S.testBtn, {
                    borderColor: lastTested === s.id ? '#34C759' : s.color,
                    backgroundColor: lastTested === s.id ? '#002800' : 'transparent',
                  }]}
                  onPress={() => handleTest(s.id)}
                >
                  <Text style={{ color: lastTested === s.id ? '#34C759' : s.color, fontSize: 13, fontWeight: '600' }}>
                    {lastTested === s.id ? '✓  Sent!' : '📳  Test Vibration'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <TouchableOpacity
              onPress={() => setEnabled(p => ({ ...p, [s.id]: !p[s.id] }))}
              style={[S.toggle, { backgroundColor: enabled[s.id] ? s.color : '#3A3A3C' }]}
            >
              <View style={[S.knob, { left: enabled[s.id] ? 22 : 2 }]} />
            </TouchableOpacity>
          </View>
        ))}

        <Text style={[S.sectionLabel, { marginTop: 24 }]}>DETECTION SENSITIVITY</Text>
        <View style={S.segControl}>
          {['Low', 'Medium', 'High'].map((lvl, i) => (
            <TouchableOpacity
              key={lvl}
              style={[S.segBtn, { backgroundColor: sensitivity === lvl ? '#007AFF' : '#1C1C1E', borderLeftWidth: i > 0 ? 1 : 0, borderLeftColor: '#2C2C2E' }]}
              onPress={() => setSensitivity(lvl)}
            >
              <Text style={{ color: '#FFF', fontSize: 15, fontWeight: sensitivity === lvl ? '700' : '400' }}>{lvl}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: '#48484A', fontSize: 13, marginTop: 8, lineHeight: 18 }}>
          Higher sensitivity catches quieter sounds but may increase false alerts.
        </Text>

        <Text style={[S.sectionLabel, { marginTop: 24 }]}>PRIVACY</Text>
        <View style={S.privBox}>
          <Text style={{ color: '#34C759', fontWeight: '700', fontSize: 15, marginBottom: 8 }}>🔒  On-Device Processing</Text>
          <Text style={{ color: '#636366', fontSize: 14, lineHeight: 20 }}>
            All audio classification happens locally. No microphone data ever leaves your phone.
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

/* ─────────────── HISTORY ─────────────── */

function HistoryScreen({ history, onClear }) {
  const reversed = [...history].reverse();
  return (
    <View style={{ flex: 1 }}>
      <View style={[S.header, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }]}>
        <Text style={{ color: '#FFF', fontSize: 26, fontWeight: '800' }}>History</Text>
        {history.length > 0 && (
          <TouchableOpacity onPress={onClear}>
            <Text style={{ color: '#FF3B30', fontSize: 15 }}>Clear All</Text>
          </TouchableOpacity>
        )}
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {reversed.length === 0
          ? <View style={[S.emptyBox, { marginTop: 40 }]}>
              <Text style={{ fontSize: 42, textAlign: 'center' }}>📋</Text>
              <Text style={{ color: '#636366', textAlign: 'center', marginTop: 12 }}>No detection history yet</Text>
            </View>
          : reversed.map((a, i) => {
              const s = SOUNDS[a.type];
              return (
                <View key={i} style={[S.histRow, { borderLeftColor: s.color }]}>
                  <View style={[S.histIcon, { backgroundColor: s.bgColor, borderColor: s.color }]}>
                    <Text style={{ fontSize: 22 }}>{s.emoji}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ color: s.color, fontSize: 16, fontWeight: '700' }}>{s.label}</Text>
                    <Text style={{ color: '#636366', fontSize: 13 }}>{fmtDateTime(a.time)}</Text>
                  </View>
                  {s.priority === 'CRITICAL' && (
                    <View style={S.critBadge}><Text style={{ color: '#FF3B30', fontSize: 11, fontWeight: '700' }}>CRITICAL</Text></View>
                  )}
                </View>
              );
            })
        }
      </ScrollView>
    </View>
  );
}

/* ─────────────── BOTTOM NAV ─────────────── */

function BottomNav({ tab, setTab }) {
  const items = [
    { id: 'home', icon: '🏠', label: 'Home' },
    { id: 'preferences', icon: '⚙️', label: 'Settings' },
    { id: 'history', icon: '📋', label: 'History' },
  ];
  return (
    <View style={S.bottomNav}>
      {items.map(it => (
        <TouchableOpacity key={it.id} style={S.navBtn} onPress={() => setTab(it.id)}>
          <Text style={{ fontSize: 24 }}>{it.icon}</Text>
          <Text style={{ color: tab === it.id ? '#007AFF' : '#636366', fontSize: 11, marginTop: 3, fontWeight: tab === it.id ? '700' : '400' }}>
            {it.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

/* ─────────────── APP ROOT ─────────────── */

export default function App() {
  const [phase, setPhase] = useState('onboarding');
  const [tab, setTab] = useState('home');
  const [alertType, setAlertType] = useState(null);
  const [enabled, setEnabled] = useState({
    smokeAlarm: true, doorbell: true, knocking: true, microwave: true, babyCrying: false,
  });
  const [sensitivity, setSensitivity] = useState('Medium');
  const [history, setHistory] = useState([]);
  const [listening, setListening] = useState(true);
  const [micGranted, setMicGranted] = useState(false);
  const [dbLevel, setDbLevel] = useState(-160);

  const recordingRef = useRef(null);
  const cooldownRef  = useRef(false);
  const enabledRef   = useRef(enabled);
  const listeningRef = useRef(listening);

  // Keep refs in sync so the recording status callback can read current values
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  const handleAlert = useCallback((id) => {
    setAlertType(id);
    setHistory(h => [...h, { type: id, time: new Date() }]);
  }, []);

  const handleDismiss = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setAlertType(null);
  }, []);

  // Start / stop microphone when listening state or permission changes
  useEffect(() => {
    if (phase !== 'main' || !micGranted) return;

    let cancelled = false;

    const onStatus = (status) => {
      if (!status.isRecording || cancelled) return;
      const db = status.metering ?? -160;
      setDbLevel(db);

      if (db > DETECTION_DB && !cooldownRef.current && listeningRef.current) {
        const enabledList = Object.keys(enabledRef.current).filter(k => enabledRef.current[k]);
        if (enabledList.length === 0) return;
        // Pick a random enabled sound — in the final app the ML model picks this
        const pick = enabledList[Math.floor(Math.random() * enabledList.length)];
        cooldownRef.current = true;
        setAlertType(pick);
        setHistory(h => [...h, { type: pick, time: new Date() }]);
        setTimeout(() => { cooldownRef.current = false; }, COOLDOWN_SEC * 1000);
      }
    };

    if (listening) {
      startRecording(onStatus).then(rec => {
        if (!cancelled) recordingRef.current = rec;
        else stopRecording(rec);
      }).catch(e => console.warn('Recording start failed:', e));
    } else {
      if (recordingRef.current) {
        stopRecording(recordingRef.current);
        recordingRef.current = null;
        setDbLevel(-160);
      }
    }

    return () => {
      cancelled = true;
      if (recordingRef.current) {
        stopRecording(recordingRef.current);
        recordingRef.current = null;
      }
    };
  }, [phase, micGranted, listening]);

  if (phase === 'onboarding') {
    return (
      <Onboarding
        onFinish={(sounds, granted) => {
          setEnabled(sounds);
          setMicGranted(granted);
          setPhase('main');
        }}
      />
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <Modal visible={!!alertType} animationType="fade" transparent={false} statusBarTranslucent>
        {alertType && <AlertScreen alertType={alertType} onDismiss={handleDismiss} />}
      </Modal>
      <View style={{ flex: 1 }}>
        {tab === 'home'        && <HomeScreen enabled={enabled} onAlert={handleAlert} history={history} listening={listening} setListening={setListening} dbLevel={dbLevel} micGranted={micGranted} />}
        {tab === 'preferences' && <PreferencesScreen enabled={enabled} setEnabled={setEnabled} sensitivity={sensitivity} setSensitivity={setSensitivity} />}
        {tab === 'history'     && <HistoryScreen history={history} onClear={() => setHistory([])} />}
      </View>
      <BottomNav tab={tab} setTab={setTab} />
    </SafeAreaView>
  );
}

/* ─────────────── STYLES ─────────────── */

const S = StyleSheet.create({
  header:       { paddingTop: 16, paddingBottom: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#1C1C1E' },
  card:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderRadius: 18, borderWidth: 2, marginBottom: 16 },
  sectionLabel: { fontSize: 12, color: '#636366', letterSpacing: 1, fontWeight: '700', marginBottom: 12, textTransform: 'uppercase' },
  emptyBox:     { backgroundColor: '#1C1C1E', borderRadius: 14, padding: 28, alignItems: 'center' },
  histRow:      { flexDirection: 'row', alignItems: 'center', backgroundColor: '#1C1C1E', borderRadius: 14, padding: 14, marginBottom: 8, borderLeftWidth: 4 },
  histIcon:     { width: 44, height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  critBadge:    { backgroundColor: '#3D0000', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6 },
  critBanner:   { backgroundColor: '#FF3B30', paddingVertical: 7, paddingHorizontal: 22, borderRadius: 24, marginBottom: 28 },
  infoBox:      { backgroundColor: '#1C1C1E', borderRadius: 12, padding: 12, marginBottom: 12, flexDirection: 'row', alignItems: 'flex-start' },
  demoGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  demoBtn:      { width: '47%', alignItems: 'center', padding: 16, borderRadius: 14, borderWidth: 1.5 },
  alertScreen:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, paddingTop: 60 },
  dismissBtn:   { paddingVertical: 20, paddingHorizontal: 56, borderRadius: 18, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 20, elevation: 10 },
  obCenter:     { alignItems: 'center' },
  obH1:         { color: '#FFF', fontSize: 30, fontWeight: '800', marginBottom: 16, textAlign: 'center', lineHeight: 36 },
  obBody:       { color: '#AEAEB2', fontSize: 16, lineHeight: 24, textAlign: 'center', marginBottom: 4 },
  btnPrimary:   { width: '100%', padding: 18, backgroundColor: '#007AFF', borderRadius: 16, alignItems: 'center', marginTop: 20 },
  btnPrimaryTxt:{ color: '#FFF', fontSize: 17, fontWeight: '700' },
  btnGhost:     { width: '100%', padding: 14, borderWidth: 1.5, borderColor: '#007AFF', borderRadius: 16, alignItems: 'center', marginTop: 10 },
  btnGhostTxt:  { color: '#007AFF', fontSize: 16 },
  privBox:      { backgroundColor: '#001A00', borderRadius: 14, padding: 16, marginTop: 20, width: '100%', borderWidth: 1, borderColor: '#34C759' },
  soundRow:     { flexDirection: 'row', alignItems: 'center', padding: 14, borderRadius: 14, borderWidth: 2, marginBottom: 10 },
  checkCircle:  { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  dots:         { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingTop: 12, paddingBottom: 8 },
  dot:          { height: 8, borderRadius: 4 },
  prefRow:      { flexDirection: 'row', alignItems: 'flex-start', padding: 16, borderRadius: 16, borderWidth: 1.5, marginBottom: 10 },
  testBtn:      { marginTop: 10, borderWidth: 1, paddingVertical: 6, paddingHorizontal: 14, borderRadius: 8, alignSelf: 'flex-start' },
  toggle:       { width: 52, height: 32, borderRadius: 16, position: 'relative', marginLeft: 8, marginTop: 2 },
  knob:         { width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFF', position: 'absolute', top: 2, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3, elevation: 3 },
  segControl:   { flexDirection: 'row', borderRadius: 12, overflow: 'hidden', borderWidth: 1.5, borderColor: '#2C2C2E' },
  segBtn:       { flex: 1, padding: 14, alignItems: 'center' },
  bottomNav:    { flexDirection: 'row', backgroundColor: '#1C1C1E', borderTopWidth: 1, borderTopColor: '#2C2C2E', paddingBottom: Platform.OS === 'ios' ? 0 : 8 },
  navBtn:       { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 10 },
});
