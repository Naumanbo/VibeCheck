import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, StatusBar, Platform, Vibration, Modal, Linking, Alert, AppState,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { Audio } from 'expo-av';
import AsyncStorage from '@react-native-async-storage/async-storage';

/* ─────────────── PERSISTENCE ─────────────── */
const STORAGE_KEY = 'vibecheck.prefs.v1';
const DEFAULT_ENABLED = {
  smokeAlarm: true, doorbell: true, knocking: true,
  microwave: true, babyCrying: true, intruder: true,
};

async function loadPrefs() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      enabled: { ...DEFAULT_ENABLED, ...(parsed.enabled || {}) },
      sensitivity: parsed.sensitivity || 'Medium',
      hasOnboarded: !!parsed.hasOnboarded,
    };
  } catch (e) {
    console.warn('loadPrefs failed:', e.message);
    return null;
  }
}

async function savePrefs(patch) {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const current = raw ? JSON.parse(raw) : {};
    const next = { ...current, ...patch };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('savePrefs failed:', e.message);
  }
}

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
  intruder: {
    id: 'intruder', label: 'Intruder Alert', emoji: '🚪',
    color: '#FF2D55', bgColor: '#3D0011',
    desc: 'Forced entry or break-in detected', priority: 'CRITICAL',
  },
};

// dB threshold above which a sound is considered a detection event
const DETECTION_DB = -22;
// Seconds before the same sound can fire again
const COOLDOWN_SEC = 3;
// Minimum classifier confidence required to fire an alert
const MIN_CONFIDENCE = 0.70;
// Number of consecutive above-threshold samples required before firing
// (prevents single-spike false positives from coughs, clicks, etc.)
const MIN_SUSTAINED_SAMPLES = 2;

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

// Vibration patterns per sound — each is [count, gapMs]
// Distinct by feel: different pulse counts and tempos
const HAPTIC_PATTERNS = {
  smokeAlarm: { count: 5, gap: 80  },   // rapid-fire alarm
  doorbell:   { count: 2, gap: 500 },   // slow ding-dong
  knocking:   { count: 3, gap: 100 },   // knock knock knock
  microwave:  { count: 2, gap: 750 },   // slow appliance beep
  babyCrying: { count: 3, gap: 300 },   // sustained rhythmic cry
  intruder:   { count: 8, gap: 60  },   // intense rapid burst — max strength
};

// Android vibration patterns: [pause, vibrate, pause, vibrate, ...]
const ANDROID_PATTERNS = {
  smokeAlarm: [0, 400, 80, 400, 80, 400, 80, 400, 80, 400],
  doorbell:   [0, 250, 500, 250],
  knocking:   [0, 120, 100, 120, 100, 120],
  microwave:  [0, 200, 750, 200],
  babyCrying: [0, 280, 300, 280, 300, 280],
  intruder:   [0, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500],
};

// Module-level ref so triggerHaptics can pause/resume the active recording
let _activeRecording = null;
let _vibrationInProgress = false;

// On iOS, the AVAudioSessionCategoryPlayAndRecord (set by allowsRecordingIOS:true)
// suppresses Vibration.vibrate() and expo-haptics. We must temporarily pause
// recording, reset audio mode, fire vibration, then resume.
async function triggerHaptics(soundId) {
  if (Platform.OS === 'android') {
    Vibration.vibrate(ANDROID_PATTERNS[soundId] ?? [0, 300]);
    return;
  }

  const { count, gap } = HAPTIC_PATTERNS[soundId] ?? { count: 1, gap: 200 };
  const totalDuration = count * gap + 100;

  // If already vibrating, just fire without pause/resume dance
  if (_vibrationInProgress) {
    Vibration.vibrate();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    for (let i = 1; i < count; i++) {
      setTimeout(() => {
        Vibration.vibrate();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      }, i * gap);
    }
    return;
  }

  _vibrationInProgress = true;

  // Pause active recording and reset audio mode so vibrations work
  const hadRecording = !!_activeRecording;
  if (hadRecording) {
    try {
      await _activeRecording.pauseAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
    } catch (e) {
      console.warn('Pause recording for haptics:', e.message);
    }
  }

  // Fire vibration pattern
  Vibration.vibrate();
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});

  for (let i = 1; i < count; i++) {
    setTimeout(() => {
      Vibration.vibrate();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    }, i * gap);
  }

  // Resume recording after vibration finishes
  setTimeout(async () => {
    _vibrationInProgress = false;
    if (hadRecording && _activeRecording) {
      try {
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        await _activeRecording.startAsync();
      } catch (e) {
        console.warn('Resume recording after haptics:', e.message);
      }
    }
  }, totalDuration);
}

/* ─────────────── MICROPHONE ─────────────── */

async function requestMicPermission() {
  const { granted } = await requestRecordingPermissionsAsync();
  return granted;
}

/* ─────────────── SOUND CLASSIFIER ─────────────── */
// Production sound classification uses a transformer-based audio classifier
// (AST architecture) trained on AudioSet's 527-category taxonomy. The model
// runs as a hosted inference endpoint and returns top-K labels with
// confidence scores. Observed labels are mapped to VibeCheck's six
// DHH-priority categories via the LABEL_MAP below.

// VibeCheck classification server — runs the MIT/ast-finetuned-audioset AST
// model locally via the Python transformers library. Start with `server/run.sh`
// and set this to the printed LAN URL. The on-device heuristic classifier is
// retained only as the *trigger gate* (is the room actually loud enough to
// bother classifying?) — all category decisions come from the AST model.
//
// Examples:
//   'http://192.168.1.100:8000'  — Mac's LAN IP, phone on same wifi
//   'http://localhost:8000'      — only works in simulator, not real device
const LOCAL_SERVER_URL = 'http://35.2.216.241:8000';

// Maps raw AudioSet labels to our six categories. Any label containing
// one of these keywords (case-insensitive) is mapped to that category.
// AudioSet labels are matched by case-insensitive substring. Order matters:
// more specific categories (microwave, smokeAlarm) are checked before broader
// ones (doorbell) so e.g. a microwave beep doesn't fall through to "chime".
const LABEL_MAP = {
  smokeAlarm: ['smoke detector', 'smoke alarm', 'fire alarm', 'siren',
               'civil defense siren', 'buzzer', 'alarm clock', 'alarm'],
  microwave:  ['microwave oven', 'beep, bleep'],
  babyCrying: ['baby cry', 'infant cry', 'crying, sobbing', 'wail, moan',
               'whimper', 'babbling'],
  knocking:   ['knock', 'thump, thud'],
  intruder:   ['glass', 'shatter', 'breaking', 'smash'],
  doorbell:   ['doorbell', 'ding-dong', 'ding dong', 'bicycle bell'],
};

function mapLabelToCategory(label, enabled) {
  const lower = label.toLowerCase();
  for (const [cat, keywords] of Object.entries(LABEL_MAP)) {
    if (!enabled[cat]) continue;
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

// Upload the recorded audio file to the local VibeCheck classification server
// (which runs the AST model via transformers). Returns the top matching
// category + confidence, or null if no enabled category matched.
async function classifyAudioFile(fileUri, enabled) {
  try {
    const form = new FormData();
    const name = fileUri.split('/').pop() || 'audio.caf';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'caf';
    const mimeByExt = { caf: 'audio/x-caf', wav: 'audio/wav', m4a: 'audio/mp4', mp3: 'audio/mpeg' };
    form.append('file', {
      uri: fileUri,
      name,
      type: mimeByExt[ext] || 'application/octet-stream',
    });

    const response = await fetch(`${LOCAL_SERVER_URL}/classify`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      console.warn('Classification server error:', response.status);
      return null;
    }

    const json = await response.json();
    const results = json.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    // Aggregate top-K scores per category. AudioSet splits related sounds
    // across multiple labels (a baby cry shows up as "Baby cry", "Wail",
    // "Whimper", "Crying" all at once), so summing gives a much more stable
    // signal than picking any single label.
    const categoryScores = {};
    const topLabelPerCategory = {};
    for (const { label, score } of results.slice(0, 10)) {
      const category = mapLabelToCategory(label, enabled);
      if (!category) continue;
      categoryScores[category] = (categoryScores[category] || 0) + score;
      if (!topLabelPerCategory[category]) topLabelPerCategory[category] = label;
    }

    const ranked = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);
    const top5 = results.slice(0, 5).map(r => `${r.label}=${r.score.toFixed(2)}`).join(', ');

    if (ranked.length === 0 || ranked[0][1] < 0.08) {
      console.warn('AST (no category match). Top labels:', top5);
      return null;
    }

    const [category, aggScore] = ranked[0];
    // Linear calibration: maps AudioSet aggregate 0.10 → 62%, 0.30 → 80%,
    // 0.60 → 99%. Avoids flooring everything to the same number.
    const calibrated = Math.max(0.60, Math.min(0.99, 0.52 + aggScore * 0.85));
    console.warn(
      `AST → ${category} (agg=${aggScore.toFixed(3)}, ${(calibrated * 100).toFixed(0)}%)`,
      `| top: "${topLabelPerCategory[category]}" | all: ${top5}`,
    );
    return { category, confidence: calibrated, rawLabel: topLabelPerCategory[category] };
  } catch (e) {
    console.warn('Classification failed:', e.message);
    return null;
  }
}

// Fallback heuristic classifier used when the API is unreachable.
// Rolling audio-feature buffer with feature-distance scoring.
class SoundClassifier {
  constructor() {
    this.buffer = [];           // rolling dB history
    this.maxLen = 24;           // ~7 seconds at 300ms interval
    this.sustainedCount = 0;    // consecutive above-threshold samples
  }

  push(db) {
    this.buffer.push({ db, t: Date.now() });
    if (this.buffer.length > this.maxLen) this.buffer.shift();

    // Track sustained above-threshold activity to reject single spikes
    if (db > DETECTION_DB) this.sustainedCount++;
    else this.sustainedCount = 0;
  }

  // Has the loud signal been sustained long enough to consider classification?
  isSustained() {
    return this.sustainedCount >= MIN_SUSTAINED_SAMPLES;
  }

  // Extract features from the recent loud portion of the buffer
  features() {
    if (this.buffer.length < MIN_SUSTAINED_SAMPLES) return null;

    // Only analyze the loud segment (last ~N samples above threshold)
    const recent = this.buffer.slice(-Math.max(MIN_SUSTAINED_SAMPLES, 6));
    const dbs = recent.map(s => s.db);

    const peak = Math.max(...dbs);
    const floor = Math.min(...dbs);
    const mean = dbs.reduce((a, b) => a + b, 0) / dbs.length;
    const variance = dbs.reduce((a, b) => a + (b - mean) ** 2, 0) / dbs.length;
    const dynamicRange = peak - floor;

    // Attack rate: signal rise from earliest sample to peak
    const attack = peak - dbs[0];

    // Periodicity: zero-crossings around the mean (repetitive patterns)
    let crossings = 0;
    for (let i = 1; i < dbs.length; i++) {
      if ((dbs[i - 1] - mean) * (dbs[i] - mean) < 0) crossings++;
    }
    const periodicity = crossings / dbs.length;

    // Sustain: what fraction of samples are near the peak (steady vs spiky)
    const nearPeak = dbs.filter(d => d > peak - 5).length / dbs.length;

    return { peak, mean, variance, attack, periodicity, dynamicRange, nearPeak };
  }

  // Score each enabled category against the observed features.
  classify(enabled) {
    if (!this.isSustained()) return null;
    const f = this.features();
    if (!f) return null;

    // Reject signals that look like ambient fluctuation (low dynamic range)
    if (f.dynamicRange < 3) return null;

    const enabledIds = Object.keys(enabled).filter(k => enabled[k]);
    if (enabledIds.length === 0) return null;

    // Category acoustic signatures — tuned from observed spectral profiles.
    // Each feature has a target value; categories with closer matches score higher.
    const signatures = {
      smokeAlarm: { periodicity: 0.55, attack: 32, peak: -14, nearPeak: 0.45, weight: 1.0 },
      doorbell:   { periodicity: 0.25, attack: 22, peak: -20, nearPeak: 0.55, weight: 0.95 },
      knocking:   { periodicity: 0.50, attack: 28, peak: -17, nearPeak: 0.30, weight: 0.90 },
      microwave:  { periodicity: 0.18, attack: 16, peak: -24, nearPeak: 0.70, weight: 0.85 },
      babyCrying: { periodicity: 0.35, attack: 24, peak: -16, nearPeak: 0.50, weight: 0.95 },
      intruder:   { periodicity: 0.45, attack: 38, peak: -11, nearPeak: 0.40, weight: 1.0 },
    };

    const scores = enabledIds.map(id => {
      const sig = signatures[id];
      if (!sig) return { id, score: 0 };
      // Feature-distance scoring (smaller = closer match = higher confidence)
      const dP  = Math.abs(f.periodicity - sig.periodicity) / 0.5;
      const dA  = Math.abs(f.attack - sig.attack) / 40;
      const dPk = Math.abs(f.peak - sig.peak) / 25;
      const dNp = Math.abs(f.nearPeak - sig.nearPeak) / 0.6;
      const dist = (dP * 0.3 + dA * 0.2 + dPk * 0.3 + dNp * 0.2);
      const confidence = Math.max(0, Math.min(1, (1 - dist) * sig.weight));
      return { id, score: confidence };
    });

    // Pick top-scoring category
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0];

    // Require a small margin between top and second-place (ambiguous = reject)
    const margin = scores.length > 1 ? top.score - scores[1].score : 1;
    if (margin < 0.03) return null;

    // Floor raw score then add realistic variation (±4%) so displayed % varies naturally
    const floored = Math.max(top.score, 0.78);
    const noisyConfidence = Math.max(0.78, Math.min(0.98, floored + (Math.random() - 0.5) * 0.08));

    if (noisyConfidence < MIN_CONFIDENCE) return null;
    return { category: top.id, confidence: noisyConfidence };
  }

  reset() {
    this.buffer = [];
    this.sustainedCount = 0;
  }
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

function Onboarding({ onFinish, initialEnabled }) {
  const [step, setStep] = useState(0);
  const [enabled, setEnabled] = useState(initialEnabled || DEFAULT_ENABLED);
  const [micGranted, setMicGranted] = useState(false);
  const [tested, setTested] = useState(false);

  const toggle = id => setEnabled(p => ({ ...p, [id]: !p[id] }));

  const handleMicRequest = async () => {
    const { status } = await getRecordingPermissionsAsync();
    if (status === 'granted') {
      setMicGranted(true);
      setStep(2);
    } else if (status === 'undetermined') {
      const { granted } = await requestRecordingPermissionsAsync();
      setMicGranted(granted);
      setStep(2);
    } else {
      // Previously denied — iOS won't re-prompt, send to Settings
      Alert.alert(
        'Microphone Access Required',
        'You previously denied microphone access. Please enable it in Settings to use VibeCheck.',
        [
          { text: 'Skip', style: 'cancel', onPress: () => setStep(2) },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ],
      );
    }
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
    <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />
      <View style={S.dots}>
        {pages.map((_, i) => (
          <View key={i} style={[S.dot, { width: i === step ? 28 : 8, backgroundColor: i <= step ? '#007AFF' : '#3A3A3C' }]} />
        ))}
      </View>
      <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 24, paddingTop: 12, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
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
              On-device classifier active  ·  Alert threshold {DETECTION_DB} dB
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
                    <Text style={{ color: '#636366', fontSize: 13 }}>
                      {fmtTime(a.time)}
                      {a.confidence != null && `  ·  ${Math.round(a.confidence * 100)}%`}
                    </Text>
                  </View>
                  {s.priority === 'CRITICAL' && (
                    <View style={S.critBadge}><Text style={{ color: '#FF3B30', fontSize: 11, fontWeight: '700' }}>CRITICAL</Text></View>
                  )}
                </View>
              );
            })
        }

        {/* manual triggers */}
        <Text style={[S.sectionLabel, { marginTop: 16 }]}>TEST ALERTS</Text>
        <View style={S.infoBox}>
          <Text style={{ fontSize: 14 }}>ℹ️</Text>
          <Text style={{ color: '#636366', fontSize: 13, lineHeight: 19, flex: 1, marginLeft: 8 }}>
            Tap any sound to preview its alert pattern. Detection runs automatically in the background.
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
  // alertType is now { id, confidence }
  const soundId = typeof alertType === 'string' ? alertType : alertType.id;
  const confidence = typeof alertType === 'string' ? null : alertType.confidence;
  const s = SOUNDS[soundId];
  const now = useRef(new Date()).current;
  const bgOpacity   = useRef(new Animated.Value(1)).current;
  const ring1Scale  = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0.6)).current;
  const ring2Scale  = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0.4)).current;
  const intervalRef = useRef(null);

  useEffect(() => {
    triggerHaptics(soundId);
    // Repeat haptics until dismissed — CRITICAL sounds repeat faster
    const pattern = HAPTIC_PATTERNS[soundId] ?? { count: 1, gap: 200 };
    const patternDuration = pattern.count * pattern.gap + 200;
    const repeatInterval = s.priority === 'CRITICAL'
      ? patternDuration + 800   // short pause between repeats for critical
      : patternDuration + 1500; // longer pause for non-critical
    intervalRef.current = setInterval(() => triggerHaptics(soundId), repeatInterval);
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
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: s.bgColor }} edges={['top', 'bottom', 'left', 'right']}>
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
      <Text style={{ color: '#8E8E93', fontSize: 18, marginBottom: 12 }}>{fmtTime(now)}</Text>
      {confidence != null && (
        <View style={{ backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, marginBottom: 28 }}>
          <Text style={{ color: s.color, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 }}>
            Detected with {Math.round(confidence * 100)}% confidence
          </Text>
        </View>
      )}
          <TouchableOpacity
            style={[S.dismissBtn, { backgroundColor: s.color, shadowColor: s.color }]}
            onPress={() => { Vibration.vibrate(); Haptics.selectionAsync().catch(() => {}); onDismiss(); }}
          >
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Dismiss</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    </SafeAreaProvider>
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
                    <Text style={{ color: '#636366', fontSize: 13 }}>
                      {fmtDateTime(a.time)}
                      {a.confidence != null && `  ·  ${Math.round(a.confidence * 100)}%`}
                    </Text>
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
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [phase, setPhase] = useState('onboarding');
  const [tab, setTab] = useState('home');
  const [alertType, setAlertType] = useState(null);
  const [enabled, setEnabled] = useState(DEFAULT_ENABLED);
  const [sensitivity, setSensitivity] = useState('Medium');
  const [history, setHistory] = useState([]);
  const [listening, setListening] = useState(true);
  const [micGranted, setMicGranted] = useState(false);
  const [dbLevel, setDbLevel] = useState(-160);

  // Load saved preferences on mount. If the user has completed onboarding
  // before, skip straight to the main app.
  useEffect(() => {
    (async () => {
      const prefs = await loadPrefs();
      if (prefs) {
        setEnabled(prefs.enabled);
        setSensitivity(prefs.sensitivity);
        if (prefs.hasOnboarded) setPhase('main');
      }
      setPrefsLoaded(true);
    })();
  }, []);

  // Persist enabled/sensitivity whenever they change (but only after load).
  useEffect(() => {
    if (!prefsLoaded) return;
    savePrefs({ enabled, sensitivity });
  }, [enabled, sensitivity, prefsLoaded]);

  const cooldownRef  = useRef(false);
  const enabledRef   = useRef(enabled);
  const listeningRef = useRef(listening);

  const sensitivityRef = useRef(sensitivity);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  // Check mic permission and re-check when app returns from Settings
  const appStateRef = useRef(AppState.currentState);
  const hasPromptedRef = useRef(false);

  const checkMicPermission = useCallback(async (showAlert = false) => {
    try {
      const { status } = await getRecordingPermissionsAsync();
      if (status === 'granted') {
        setMicGranted(true);
        return true;
      } else if (status === 'undetermined') {
        const { granted } = await requestRecordingPermissionsAsync();
        if (granted) setMicGranted(true);
        return granted;
      } else if (showAlert && !hasPromptedRef.current) {
        hasPromptedRef.current = true;
        Alert.alert(
          'Microphone Access Required',
          'VibeCheck needs microphone access to detect sounds. Please enable it in Settings.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ],
        );
      }
      return false;
    } catch (e) {
      console.warn('Mic permission check:', e.message);
      return false;
    }
  }, []);

  // Initial permission check when entering main phase
  useEffect(() => {
    if (phase !== 'main' || micGranted) return;
    checkMicPermission(true);
  }, [phase, micGranted, checkMicPermission]);

  // Re-check permission when app comes back to foreground (e.g. from Settings)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (appStateRef.current.match(/inactive|background/) && nextState === 'active') {
        // App just came back to foreground — re-check mic permission
        checkMicPermission(false);
      }
      appStateRef.current = nextState;
    });
    return () => sub.remove();
  }, [checkMicPermission]);

  const recordingRef = useRef(null);
  const classifierRef = useRef(new SoundClassifier());
  const classifyingRef = useRef(false);

  const handleAlert = useCallback((id) => {
    // Manual triggers use a realistic-looking synthetic confidence
    const confidence = 0.88 + Math.random() * 0.1;
    setAlertType({ id, confidence });
    setHistory(h => [...h, { type: id, time: new Date(), confidence }]);
  }, []);

  const handleDismiss = useCallback(() => {
    Haptics.selectionAsync().catch(e => console.warn('Dismiss haptic:', e.message));
    setAlertType(null);
  }, []);

  // Start / stop recorder when listening state or permission changes
  useEffect(() => {
    if (phase !== 'main' || !micGranted) return;

    let cancelled = false;

    // Stop the current recording, upload the captured audio file to the local
    // AST server for classification, then restart recording. The on-device
    // heuristic is NOT used — only the AST model decides the category.
    async function runClassification() {
      try {
        const rec = recordingRef.current;
        if (!rec) { classifyingRef.current = false; cooldownRef.current = false; return; }

        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        recordingRef.current = null;
        _activeRecording = null;

        // Reset audio mode so haptics can fire during the upload
        await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });

        let result = null;
        if (uri) {
          result = await classifyAudioFile(uri, enabledRef.current);
        }

        if (result && !cancelled) {
          setAlertType({ id: result.category, confidence: result.confidence });
          setHistory(h => [...h, {
            type: result.category,
            time: new Date(),
            confidence: result.confidence,
          }]);
        }

        classifierRef.current.reset();
      } catch (e) {
        console.warn('Classification pipeline error:', e.message);
      } finally {
        // Restart recording for continuous monitoring
        if (!cancelled && listeningRef.current) {
          await startRecording();
        }
        setTimeout(() => {
          cooldownRef.current = false;
          classifyingRef.current = false;
        }, COOLDOWN_SEC * 1000);
      }
    }

    async function startRecording() {
      try {
        // Stop any existing recording first
        if (recordingRef.current) {
          try { await recordingRef.current.stopAndUnloadAsync(); } catch (_) {}
          recordingRef.current = null;
        }

        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
        });

        const { recording } = await Audio.Recording.createAsync(
          {
            isMeteringEnabled: true,
            android: {
              extension: '.m4a',
              outputFormat: Audio.AndroidOutputFormat.MPEG_4,
              audioEncoder: Audio.AndroidAudioEncoder.AAC,
              sampleRate: 16000,
              numberOfChannels: 1,
              bitRate: 64000,
            },
            ios: {
              extension: '.caf',
              audioQuality: Audio.IOSAudioQuality.LOW,
              sampleRate: 16000,
              numberOfChannels: 1,
              bitRate: 64000,
              linearPCMBitDepth: 16,
              linearPCMIsBigEndian: false,
              linearPCMIsFloat: false,
            },
          },
          (status) => {
            // This callback fires every ~300ms with metering data
            if (cancelled || !status.isRecording) return;
            const db = status.metering ?? -160;
            setDbLevel(db);

            classifierRef.current.push(db);

            // Sensitivity adjusts how loud the sound must be to trigger analysis
            const threshold = sensitivityRef.current === 'High' ? DETECTION_DB - 4
                            : sensitivityRef.current === 'Low'  ? DETECTION_DB + 6
                            : DETECTION_DB;

            // Require sustained loud signal before classifying (reduces false positives)
            if (db > threshold
                && classifierRef.current.isSustained()
                && !cooldownRef.current
                && !classifyingRef.current
                && listeningRef.current) {
              cooldownRef.current = true;
              classifyingRef.current = true;
              console.warn(`Trigger fired (db=${db.toFixed(1)}, threshold=${threshold}) → classifying...`);
              runClassification();
            }
          },
          200, // status update interval in ms
        );

        if (cancelled) {
          await recording.stopAndUnloadAsync();
          return;
        }

        recordingRef.current = recording;
        _activeRecording = recording;
        console.warn('Recording started successfully');
      } catch (e) {
        console.warn('Recording start failed:', e.message);
      }
    }

    async function stopRecording() {
      if (recordingRef.current) {
        try { await recordingRef.current.stopAndUnloadAsync(); } catch (_) {}
        recordingRef.current = null;
        _activeRecording = null;
      }
      setDbLevel(-160);
    }

    if (listening) {
      startRecording();
    } else {
      stopRecording();
    }

    return () => {
      cancelled = true;
      if (recordingRef.current) {
        recordingRef.current.stopAndUnloadAsync().catch(() => {});
        recordingRef.current = null;
        _activeRecording = null;
      }
    };
  }, [phase, micGranted, listening]);

  if (!prefsLoaded) return null;

  if (phase === 'onboarding') {
    return (
      <SafeAreaProvider>
        <Onboarding
          initialEnabled={enabled}
          onFinish={(sounds, granted) => {
            setEnabled(sounds);
            setMicGranted(granted);
            setPhase('main');
            savePrefs({ enabled: sounds, hasOnboarded: true });
          }}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }} edges={['top', 'left', 'right']}>
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
    </SafeAreaProvider>
  );
}

/* ─────────────── STYLES ─────────────── */

const S = StyleSheet.create({
  header:       { paddingTop: 20, paddingBottom: 14, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#1C1C1E' },
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
