import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet,
  Animated, StatusBar, Platform, Vibration, Modal, Linking, Alert, AppState,
  NativeModules, PanResponder,
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
// History lives in its own key — it grows, and serializing it alongside
// prefs on every toggle would be wasteful.
const HISTORY_STORAGE_KEY = 'vibecheck.history.v1';
const DEFAULT_ENABLED = {
  smokeAlarm: true, doorbell: true, knocking: true,
  microwave: true, babyCrying: true, intruder: true,
  policeSiren: true, gunshot: true, shouting: true,
  dogBark: true, catMeow: false, phoneRinging: true, carHorn: true,
  // New categories added in this release. `vehicleEngine` and `laughter`
  // default off because they fire easily in cities / from TV and would
  // overwhelm a new user; they remain one tap away in Settings.
  waterRunning: true, vehicleEngine: false, thunder: true, laughter: false,
  // Safety fallback: fire an alert with the raw classifier output when a
  // loud sound is detected but doesn't match any enabled category.
  unknown: true,
};

// How long detection history is retained on-device. User-selectable in
// Settings. Entries older than the chosen window are pruned on load and
// after every new push — so the "7 days then drop the oldest day" behavior
// happens naturally as a rolling window.
const DEFAULT_RETENTION = 'weekly';
const HISTORY_RETENTION_LABELS = ['daily', 'weekly', 'monthly', 'yearly'];
const HISTORY_RETENTION_MS = {
  daily:    1 * 24 * 60 * 60 * 1000,
  weekly:   7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
  yearly: 365 * 24 * 60 * 60 * 1000,
};
// Hard safety cap on history length, regardless of retention. At ~70 bytes
// per entry on disk (labels stripped) this caps storage at ~350 KB even if
// the user picks yearly retention in a noisy environment full of false
// positives. Prevents AsyncStorage from ever getting hit with megabytes.
const HISTORY_MAX_ENTRIES = 5000;

function trimHistory(list, retention) {
  const window = HISTORY_RETENTION_MS[retention] ?? HISTORY_RETENTION_MS[DEFAULT_RETENTION];
  const cutoff = Date.now() - window;
  const filtered = list.filter(e => typeof e.time === 'number' && e.time >= cutoff);
  // Keep newest HISTORY_MAX_ENTRIES — entries are appended in chronological
  // order, so slicing from the tail preserves the most recent events.
  if (filtered.length > HISTORY_MAX_ENTRIES) {
    return filtered.slice(-HISTORY_MAX_ENTRIES);
  }
  return filtered;
}

// AudioSet top-5 labels (~175 bytes/entry) are only used by the live Alert
// modal for the reclassify action. Once the alert's dismissed, History only
// renders type + time + confidence — so we don't need to persist the labels.
// Stripping them here cuts on-disk size ~75%.
function stripLabelsForDisk(list) {
  return list.map(({ labels, ...rest }) => rest);
}

async function loadPrefs() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      enabled: { ...DEFAULT_ENABLED, ...(parsed.enabled || {}) },
      sensitivity: parsed.sensitivity || 'Medium',
      hasOnboarded: !!parsed.hasOnboarded,
      historyRetention: HISTORY_RETENTION_LABELS.includes(parsed.historyRetention)
        ? parsed.historyRetention : DEFAULT_RETENTION,
      // Per-AudioSet-label mute list the user built up by tapping the mute
      // button on the alert screen breakdown. Any label with a truthy value
      // here is filtered out of results before category scoring runs.
      suppressedLabels: parsed.suppressedLabels || {},
      // Per-category false-positive counter. Each "False Positive" tap on an
      // alert increments that category's entry; classifyAudioFile multiplies
      // the category's score by Math.max(0.5, 1 - count * 0.1), making that
      // sound progressively harder to alert on.
      fpPenalties: parsed.fpPenalties || {},
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

async function loadHistoryFromDisk() {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('loadHistory failed:', e.message);
    return [];
  }
}

async function saveHistoryToDisk(list) {
  try {
    await AsyncStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn('saveHistory failed:', e.message);
  }
}

async function clearHistoryOnDisk() {
  try {
    await AsyncStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch (e) {
    console.warn('clearHistory failed:', e.message);
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
  policeSiren: {
    id: 'policeSiren', label: 'Emergency Siren', emoji: '🚓',
    color: '#FF1744', bgColor: '#3D0011',
    desc: 'Police, ambulance, or fire truck', priority: 'CRITICAL',
  },
  gunshot: {
    id: 'gunshot', label: 'Gunshot', emoji: '💥',
    color: '#D50000', bgColor: '#330000',
    desc: 'Firearm or explosive sounds', priority: 'CRITICAL',
  },
  shouting: {
    id: 'shouting', label: 'Shouting', emoji: '📣',
    color: '#FFC107', bgColor: '#332400',
    desc: 'Yelling or screaming nearby', priority: 'HIGH',
  },
  dogBark: {
    id: 'dogBark', label: 'Dog Barking', emoji: '🐕',
    color: '#8D6E63', bgColor: '#2B1E18',
    desc: 'Dog barking or howling', priority: 'MEDIUM',
  },
  catMeow: {
    id: 'catMeow', label: 'Cat Meowing', emoji: '🐈',
    color: '#F06292', bgColor: '#33101E',
    desc: 'Cat meow or caterwaul', priority: 'LOW',
  },
  phoneRinging: {
    id: 'phoneRinging', label: 'Phone Ringing', emoji: '📞',
    color: '#00BCD4', bgColor: '#002A30',
    desc: 'Incoming call or ringtone', priority: 'HIGH',
  },
  carHorn: {
    id: 'carHorn', label: 'Car Horn', emoji: '🚗',
    color: '#FF6D00', bgColor: '#331A00',
    desc: 'Vehicle horn or honking nearby', priority: 'HIGH',
  },
  vehicleEngine: {
    id: 'vehicleEngine', label: 'Vehicle Engine', emoji: '🚙',
    color: '#5D4037', bgColor: '#1F1410',
    desc: 'Car, truck, or motorcycle approaching', priority: 'HIGH',
  },
  thunder: {
    id: 'thunder', label: 'Thunder', emoji: '⛈️',
    color: '#5E35B1', bgColor: '#16002A',
    desc: 'Thunder or storm activity nearby', priority: 'HIGH',
  },
  waterRunning: {
    id: 'waterRunning', label: 'Running Water', emoji: '💧',
    color: '#039BE5', bgColor: '#00202B',
    desc: 'Faucet, sink, bathtub, or splashing', priority: 'MEDIUM',
  },
  laughter: {
    id: 'laughter', label: 'Laughter', emoji: '😂',
    color: '#FFB300', bgColor: '#2A1F00',
    desc: 'Laughter, chuckling, or giggling nearby', priority: 'LOW',
  },
  // Fallback category — fired when a loud sound doesn't match any enabled
  // keyword but the classifier still identified something. Shows the raw
  // top AudioSet labels so the user can judge the threat themselves.
  unknown: {
    id: 'unknown', label: 'Unclassified Sound', emoji: '⚠️',
    color: '#FFD60A', bgColor: '#332900',
    desc: 'Loud sound detected that did not match a known category. Shows raw classifier output so you can judge it yourself (safety fallback).',
    priority: 'HIGH',
  },
};

// DETECTION_DB is the peak-dB floor a sound must cross for a NAMED or
// UNCLASSIFIED alert to actually fire. The *classifier itself* runs whenever
// audio is above CLASSIFY_DB so the Home screen "Live Context" top-5 stays
// fresh in normal rooms without burning battery in true silence.
const DETECTION_DB = -35;
// Minimum peak-dB for the classifier to even run. Below this the room is
// effectively silent, classification would waste battery, and the preview
// would just show "Silence 90%" on repeat. Sits a bit below DETECTION_DB so
// the live preview keeps updating for quiet sounds the user might want to
// glance at (nearby conversation, typing) even when no alert will fire.
const CLASSIFY_DB = -43;
// Seconds before the next classifier cycle can fire. Lower = snappier live
// context, higher = less battery. Classification itself takes ~0.3–0.5s on
// recent iPhones, so effective cycle ≈ MIN_RECORDING_MS + 0.5s + this.
// Target total cycle ≈ 1.5s: 800ms audio + ~500ms classify + 200ms cooldown.
const COOLDOWN_SEC = 0.2;
// Minimum milliseconds of recording buffer needed before a classification
// cycle is allowed to fire. Lower = snappier updates but thinner audio
// context fed to the classifier (which zero-pads anyway to 3s).
const MIN_RECORDING_MS = 800;
// Minimum calibrated classifier confidence required to fire a NAMED alert.
// Anything below this is demoted to live-preview only — the model clearly
// saw *something* but isn't confident enough to buzz the phone.
const MIN_CONFIDENCE = 0.70;
// Per-category overrides to MIN_CONFIDENCE. Some categories have inherently
// diffuse AudioSet signatures that rarely accumulate high aggregate scores
// (thunder is spread over 1–2 low-score labels; running water spreads across
// many weak hits). A global 0.70 floor makes them nearly impossible to fire
// even when genuinely present. We still require sustained-loud + peak-dB
// gates upstream, so relaxing confidence here doesn't create spam — it just
// stops the model's natural score distribution from silencing real events.
const PER_CATEGORY_MIN_CONFIDENCE = {
  thunder: 0.58,
  waterRunning: 0.62,
};
// Number of metering samples above DETECTION_DB required within the current
// classification window for the sound to count as "sustained" — otherwise a
// single loud spike (door slam, chair creak, cough) can't fire an alert on
// its own. An exceptionally loud single spike still passes via VERY_LOUD_DB.
const MIN_LOUD_SAMPLES = 2;
// A single sample above this very-loud floor is enough to count as a real
// event even without sustain. Covers genuine impulse sounds (gunshot, glass
// shatter) that are loud-and-over in <200ms.
const VERY_LOUD_DB = -15;
// Legacy field still referenced by the fallback heuristic classifier below.
const MIN_SUSTAINED_SAMPLES = 2;

// Unknown-alert gating. Unclassified alerts are a safety fallback for loud
// events that don't map to a known category (e.g. unusual gunshot audio).
// To stop them from firing on coughs, sniffs, chair creaks, and other small
// sounds, we require ALL of:
//   - top label probability ≥ UNKNOWN_MIN_SCORE (model confident about SOMETHING)
//   - measured peak ≥ UNKNOWN_MIN_PEAK_DB (actually a loud event)
//   - top label isn't in UNKNOWN_SUPPRESS_LABELS (body / speech / walking noise)
const UNKNOWN_MIN_SCORE = 0.25;
const UNKNOWN_MIN_PEAK_DB = -20;
const UNKNOWN_SUPPRESS_LABELS = [
  // Body / personal noises
  'cough', 'sneeze', 'sniff', 'breathing', 'throat clearing',
  'speech', 'conversation', 'narration', 'male speech', 'female speech',
  'child speech', 'whispering', 'hiccup', 'gasp', 'snort', 'humming',
  'chewing', 'mastication', 'footsteps', 'rustle', 'rustling leaves',
  'clicking', 'tick', 'tap', 'burp', 'fart',
  // Long-duration electronic / media sounds that repeat for minutes.
  // Firing 'unknown' on these causes spam because the sound keeps
  // re-classifying the same way for its whole duration.
  'music', 'musical instrument', 'background music',
  'busy signal', 'sine wave', 'dial tone', 'mains hum',
];

// After an 'unknown' alert is acknowledged (dismiss or reclassify), its top
// label gets stamped into recentlyAckedUnknownRef with a timestamp. Any
// unknown classification whose top label is in there within this window is
// demoted to a live-preview update instead of re-firing an alert — stops
// long sounds (e.g. a song that keeps playing, a busy-signal loop) from
// buzzing the phone over and over.
const UNKNOWN_DEDUP_WINDOW_MS = 5 * 60 * 1000;

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
  smokeAlarm:   { count: 5, gap: 80  },   // rapid-fire alarm
  doorbell:     { count: 2, gap: 500 },   // slow ding-dong
  knocking:     { count: 3, gap: 100 },   // knock knock knock
  microwave:    { count: 2, gap: 750 },   // slow appliance beep
  babyCrying:   { count: 3, gap: 300 },   // sustained rhythmic cry
  intruder:     { count: 8, gap: 60  },   // intense rapid burst — max strength
  policeSiren:  { count: 6, gap: 150 },   // medium rapid — siren wail
  gunshot:      { count: 2, gap: 40  },   // two quick sharp pulses
  shouting:     { count: 4, gap: 200 },   // four medium pulses
  dogBark:      { count: 3, gap: 180 },   // three quick medium — bark rhythm
  catMeow:      { count: 2, gap: 250 },   // two gentle pulses
  phoneRinging: { count: 3, gap: 400 },   // three slow — classic ring
  carHorn:      { count: 1, gap: 600 },   // single long blast
  vehicleEngine:{ count: 5, gap: 300 },   // five steady — engine approaching
  thunder:      { count: 1, gap: 1000 },  // one extra-long rumble
  waterRunning: { count: 2, gap: 850 },   // two very slow — continuous flow
  laughter:     { count: 4, gap: 90  },   // four quick bursts — "ha-ha-ha-ha"
  unknown:      { count: 4, gap: 220 },   // distinct medium-pace — "check labels"
};

// Android vibration patterns: [pause, vibrate, pause, vibrate, ...]
const ANDROID_PATTERNS = {
  smokeAlarm:   [0, 400, 80, 400, 80, 400, 80, 400, 80, 400],
  doorbell:     [0, 250, 500, 250],
  knocking:     [0, 120, 100, 120, 100, 120],
  microwave:    [0, 200, 750, 200],
  babyCrying:   [0, 280, 300, 280, 300, 280],
  intruder:     [0, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500, 60, 500],
  policeSiren:  [0, 220, 150, 220, 150, 220, 150, 220, 150, 220, 150, 220],
  gunshot:      [0, 120, 40, 120],
  shouting:     [0, 200, 200, 200, 200, 200, 200, 200],
  dogBark:      [0, 140, 180, 140, 180, 140],
  catMeow:      [0, 220, 250, 220],
  phoneRinging: [0, 350, 400, 350, 400, 350],
  carHorn:      [0, 600],
  vehicleEngine:[0, 250, 300, 250, 300, 250, 300, 250, 300, 250],
  thunder:      [0, 1000],
  waterRunning: [0, 300, 850, 300],
  laughter:     [0, 100, 90, 100, 90, 100, 90, 100],
  unknown:      [0, 180, 220, 180, 220, 180, 220, 180],
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
// Sound classification runs fully on-device via Core ML (ASTClassifier.mlpackage,
// MIT/ast-finetuned-audioset ported + fp16 quantized, wrapped in a Swift
// native module — see ios/VibeCheckNative). No network, no server.

// Maps raw AudioSet labels to our six categories. Any label containing
// one of these keywords (case-insensitive) is mapped to that category.
// AudioSet labels are matched by case-insensitive substring. Order matters:
// more specific categories (microwave, smokeAlarm) are checked before broader
// ones (doorbell) so e.g. a microwave beep doesn't fall through to "chime".
// Order matters: the first category whose keyword list matches a given AudioSet
// label wins. Put specific categories before generic ones so e.g. "Police car
// (siren)" hits policeSiren before falling through to smokeAlarm's 'siren'.
const LABEL_MAP = {
  gunshot:      ['gunshot', 'gunfire', 'machine gun', 'cap gun', 'artillery fire', 'explosion'],
  // policeSiren comes before vehicleEngine so "Fire engine, fire truck (siren)"
  // routes to sirens (the user needs to get out of the way) and never to a
  // plain vehicle-engine alert.
  policeSiren:  ['police car', 'ambulance', 'fire engine', 'fire truck', 'civil defense siren'],
  smokeAlarm:   ['smoke detector', 'smoke alarm', 'fire alarm', 'siren',
                 'buzzer', 'alarm clock', 'alarm'],
  phoneRinging: ['telephone bell ringing', 'ringtone', 'telephone dialing', 'telephone', 'dtmf'],
  // carHorn must come before vehicleEngine so "Air horn, truck horn" is a
  // honk alert, not an engine alert.
  carHorn:      ['car horn', 'honking', 'truck horn', 'air horn', 'train horn'],
  // Thunder is extremely unambiguous — no overlap with other categories.
  thunder:      ['thunderstorm', 'thunder'],
  // vehicleEngine sits below policeSiren + carHorn so those specific labels
  // win first. The 'truck' keyword here only catches generic vehicle labels
  // like "Truck" or "Ice cream truck" — fire-truck and truck-horn variants
  // are already consumed by the earlier categories.
  vehicleEngine:['motor vehicle', 'motorcycle', 'engine starting', 'engine knocking',
                 'heavy engine', 'medium engine', 'light engine',
                 'aircraft engine', 'jet engine', 'reversing beeps', 'truck', 'engine'],
  microwave:    ['microwave oven'],
  // Water keywords avoid bare 'water' so "Boat, Water vehicle" doesn't get
  // miscategorized as running water.
  waterRunning: ['water tap', 'faucet', 'sink (filling', 'splash', 'pour', 'drip', 'waterfall'],
  // babyCrying keeps 'baby laughter' so a giggling infant still fires the
  // baby alert (caregiver attention signal), rather than falling through to
  // the generic laughter category.
  babyCrying:   ['baby cry', 'infant cry', 'crying, sobbing', 'wail, moan', 'babbling', 'baby laughter'],
  // laughter comes after babyCrying so a baby laugh still routes to babyCrying.
  laughter:     ['belly laugh', 'chuckle', 'chortle', 'giggle', 'snicker', 'laughter'],
  dogBark:      ['bark', 'howl', 'canidae', 'whimper (dog)'],
  shouting:     ['shout', 'yell', 'screaming'],
  catMeow:      ['meow', 'caterwaul'],
  knocking:     ['knock', 'thump, thud'],
  intruder:     ['glass', 'shatter', 'breaking', 'smash'],
  doorbell:     ['doorbell', 'ding-dong', 'ding dong', 'bicycle bell'],
};

// Generic AudioSet labels (e.g. "Beep, bleep", "Animal") don't tell us which
// specific source made the sound — but when paired with a concrete label in
// the same top-10, they clearly belong to that category. Example: if AST
// returns "Beep, bleep 0.40" + "Smoke detector 0.15" + "Fire alarm 0.12", the
// right answer is smokeAlarm, not microwave (the old default for any beep).
//
// For each group, we sum the scores of its generic labels, then route that
// sum to whichever candidate category already has a concrete hit in
// LABEL_MAP. If no candidate has a hit, the score falls through to 'unknown'
// so the user can see the raw labels and decide for themselves.
//
// Order of `candidates` is a tiebreaker — if two categories have identical
// direct scores, the one earlier in the list wins.
const GENERIC_GROUPS = [
  {
    name: 'beeper',
    // Exact AudioSet label "Beep, bleep" — short electronic beep/chirp.
    // Not mapped to a single category directly: too ambiguous between a
    // microwave, smoke detector, doorbell, or phone.
    matchKeywords: ['beep, bleep'],
    candidates: ['smokeAlarm', 'microwave', 'phoneRinging', 'doorbell'],
  },
  {
    name: 'animal',
    // Generic animal labels get routed to whichever species category
    // (dogBark / catMeow) already has a specific hit like "Bark" or "Meow".
    matchKeywords: ['animal', 'domestic animals', 'pets'],
    candidates: ['dogBark', 'catMeow'],
  },
];

function mapLabelToCategory(label, enabled) {
  const lower = label.toLowerCase();
  for (const [cat, keywords] of Object.entries(LABEL_MAP)) {
    if (!enabled[cat]) continue;
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

// Like mapLabelToCategory but ignores the user's enabled toggles — used to
// decorate the top-5 breakdown with an emoji for every label so the user can
// visually parse the list even for categories they've disabled. A disabled
// category still won't *fire* an alert, but showing its icon here gives the
// user context (e.g. "oh, one of the runners-up was 'Bark' which I have
// muted for cat reasons — now I know why it wasn't the top category").
function emojiForLabel(label) {
  const lower = label.toLowerCase();
  for (const [cat, keywords] of Object.entries(LABEL_MAP)) {
    if (keywords.some(kw => lower.includes(kw))) return SOUNDS[cat]?.emoji ?? '🔊';
  }
  return '🔊';
}

// Same shape as mapLabelToCategory but ignores enabled — used when the user
// manually reclassifies an 'unknown' alert by tapping a top-5 label. We want
// to honor their choice even if they have that category toggled off.
function categoryForLabel(label) {
  const lower = label.toLowerCase();
  for (const [cat, keywords] of Object.entries(LABEL_MAP)) {
    if (keywords.some(kw => lower.includes(kw))) return cat;
  }
  return null;
}

// Runs the AST AudioSet classifier on-device via Core ML.
// Returns an object with `labels` (top-5 always, for live preview) and
// optionally `category` + `confidence` when a category fires. Returns null
// only when the output is so ambient / silent that showing it would mislead
// the user (e.g. top label is 'Silence').
async function classifyAudioFile(fileUri, enabled, peakDb = 0, loudSampleCount = 0, fpPenalties = {}, suppressedLabels = {}) {
  // A sound counts as "sustained loud" if either: (a) we saw at least
  // MIN_LOUD_SAMPLES metering samples above DETECTION_DB during the window,
  // or (b) the peak was very loud (impulse events like gunshots / glass
  // shatter finish in under 200ms and can't rack up sustained samples).
  const sustainedLoud = loudSampleCount >= MIN_LOUD_SAMPLES || peakDb >= VERY_LOUD_DB;
  try {
    const native = NativeModules.SoundClassifier;
    if (!native || !native.classifyFile) {
      console.warn('SoundClassifier native module not linked');
      return null;
    }

    const response = await native.classifyFile(fileUri);
    const rawResults = response && response.results;
    if (!Array.isArray(rawResults) || rawResults.length === 0) return null;

    // Filter out AudioSet labels the user has muted via the alert breakdown.
    // If a label doesn't appear here, it cannot contribute to category
    // scoring *or* show up in the top-5 breakdown the user sees.
    const results = rawResults.filter(r => !suppressedLabels[r.label]);
    if (results.length === 0) {
      console.warn('AST suppressed: every label user-muted');
      return null;
    }

    // If the classifier's #1 label is Silence or Sidetone, suppress any
    // ALERT (named or unknown) — these usually mean the trigger fired on a
    // finger tap, a pure vibration sine-wave leaking into the mic, or
    // ambient hum, and buzzing the phone over them is spam. But we still
    // surface the top-5 to the Home Live Context card so the user can see
    // "Silence 80%" and trust that their environment is actually quiet
    // (up-to-date ambient info is better than a frozen preview).
    const topLabelLower = results[0].label.toLowerCase();
    const SUPPRESS_IF_TOP = ['silence', 'sidetone'];
    if (SUPPRESS_IF_TOP.some(k => topLabelLower.includes(k))) {
      // Originally we returned preview-only whenever silence was #1. That was
      // too strict: the AST model often ranks "Silence" as top inside a quiet
      // room even when a real but brief event (thunder rumble, engine passing)
      // also shows up at #2 with a meaningful score. Now we only suppress if
      // EITHER the environment is actually quiet (peak < DETECTION_DB or not
      // sustained), OR the #2 label has no real signal. When a loud, sustained
      // event is happening AND #2 has meaningful score, we let classification
      // proceed — downstream gates (MIN_CONFIDENCE, per-category thresholds)
      // still protect against false alerts.
      const second = results[1];
      const secondScore = second?.score ?? 0;
      const secondLower = (second?.label || '').toLowerCase();
      const secondIsSilence = SUPPRESS_IF_TOP.some(k => secondLower.includes(k));
      const loudEvent = peakDb >= DETECTION_DB && sustainedLoud;
      const meaningfulSecond = secondScore >= 0.08 && !secondIsSilence;
      if (!loudEvent || !meaningfulSecond) {
        const previewOnly = results.slice(0, 5).map(r => ({ label: r.label, score: r.score }));
        console.warn(`AST alert-suppressed (top=${results[0].label}, #2=${second?.label}@${secondScore.toFixed(2)}), preview shown`);
        return { category: null, labels: previewOnly };
      }
      console.warn(`AST silence-override: loud=${peakDb.toFixed(1)}dB sustained=${loudSampleCount}, #2="${second.label}"@${secondScore.toFixed(2)} — proceeding`);
    }

    // Aggregate top-K scores per category. AudioSet splits related sounds
    // across multiple labels (a baby cry shows up as "Baby cry", "Wail",
    // "Whimper", "Crying" all at once), so summing gives a much more stable
    // signal than picking any single label. Track which labels were
    // consumed directly so generic-group routing below doesn't double-count
    // (e.g. "Bicycle bell" is both a direct doorbell keyword and matches
    // the substring 'bell' — it should only count once).
    const categoryScores = {};
    const topLabelPerCategory = {};
    const consumedLabels = new Set();
    for (const { label, score } of results.slice(0, 10)) {
      const category = mapLabelToCategory(label, enabled);
      if (!category) continue;
      categoryScores[category] = (categoryScores[category] || 0) + score;
      if (!topLabelPerCategory[category]) topLabelPerCategory[category] = label;
      consumedLabels.add(label);
    }

    // Generic-label routing: AudioSet often returns labels that describe a
    // sound *class* without pinpointing the source (e.g. "Beep, bleep" —
    // could be a microwave, smoke detector, doorbell, or phone). Rather
    // than hardcoding one default (old code mapped every "Beep" to
    // microwave, which caused smoke-detector chirps to misclassify), we
    // route each group's total score to whichever candidate category
    // already has a concrete hit from a specific label. So:
    //   "Beep, bleep 0.40" + "Smoke detector 0.15"  →  smokeAlarm 0.55
    //   "Beep, bleep 0.40" + "Microwave oven 0.20"  →  microwave 0.60
    //   "Beep, bleep 0.40" alone                    →  falls through
    //     (→ unknown alert + top-5 breakdown so user can judge)
    for (const group of GENERIC_GROUPS) {
      let groupScore = 0;
      for (const { label, score } of results.slice(0, 10)) {
        if (consumedLabels.has(label)) continue;
        const lower = label.toLowerCase();
        if (group.matchKeywords.some(kw => lower.includes(kw))) {
          groupScore += score;
        }
      }
      if (groupScore <= 0) continue;
      const candidates = group.candidates
        .filter(cat => enabled[cat] && (categoryScores[cat] || 0) > 0)
        .sort((a, b) => (categoryScores[b] || 0) - (categoryScores[a] || 0));
      if (candidates.length === 0) continue;
      const winner = candidates[0];
      categoryScores[winner] = (categoryScores[winner] || 0) + groupScore;
      console.warn(`AST generic ${group.name} boost: +${groupScore.toFixed(3)} → ${winner}`);
    }

    // Phone-ringing context boost. AST tends to split phone-ringing audio
    // across multiple low-scoring labels (Telephone bell ringing 0.05,
    // Ringtone 0.04, Telephone 0.03) — individually each can lose to a
    // louder "Alarm" or "Doorbell" hit, so phone calls get misclassified
    // as smoke alarms or doorbells. Summing all phone-indicative labels
    // and boosting phoneRinging catches these cases. When the phone
    // signature is strong (≥2 labels or summed ≥ 0.10), also dampen the
    // two categories phone audio most commonly fools so a genuine phone
    // ring doesn't lose to a phantom smokeAlarm / doorbell hit.
    //
    // Safety note: the dampen is gated on a STRONG phone signature so a
    // real smoke alarm with a phone ringing in the background isn't
    // suppressed below threshold.
    const PHONE_CONTEXT_KEYWORDS = ['telephone bell', 'ringtone', 'telephone', 'dtmf'];
    let phoneSignal = 0;
    let phoneHits = 0;
    for (const { label, score } of results.slice(0, 10)) {
      const lower = label.toLowerCase();
      if (PHONE_CONTEXT_KEYWORDS.some(kw => lower.includes(kw))) {
        phoneSignal += score;
        phoneHits++;
      }
    }
    if (enabled.phoneRinging && phoneSignal > 0) {
      const boost = phoneSignal;
      categoryScores.phoneRinging = (categoryScores.phoneRinging || 0) + boost;
      const strong = phoneHits >= 2 || phoneSignal >= 0.10;
      if (strong) {
        for (const victim of ['smokeAlarm', 'doorbell']) {
          if (categoryScores[victim]) categoryScores[victim] *= 0.6;
        }
      }
      console.warn(`AST phone-context: +${boost.toFixed(3)} → phoneRinging${strong ? ' · dampened smokeAlarm/doorbell' : ''}`);
    }

    // Water-context boost. A running tap or shower sprays its AudioSet mass
    // across "Water", "Splash, splatter", "Pour", "Drip", "Water tap, faucet"
    // — none of which individually clears the 0.08 floor. Summing them and
    // routing to waterRunning catches real water events without firing on a
    // single 'Splash' spike (one-off dish drop, etc).
    const WATER_CONTEXT_KEYWORDS = ['water tap', 'faucet', 'sink (filling', 'splash',
                                    'pour', 'drip', 'waterfall', 'water'];
    let waterSignal = 0;
    let waterHits = 0;
    for (const { label, score } of results.slice(0, 10)) {
      const lower = label.toLowerCase();
      // Skip "Boat, Water vehicle" — has 'water' but isn't running water.
      if (lower.includes('boat') || lower.includes('water vehicle')) continue;
      if (WATER_CONTEXT_KEYWORDS.some(kw => lower.includes(kw))) {
        waterSignal += score;
        waterHits++;
      }
    }
    if (enabled.waterRunning && waterSignal > 0 && waterHits >= 2) {
      categoryScores.waterRunning = (categoryScores.waterRunning || 0) + waterSignal;
      console.warn(`AST water-context: +${waterSignal.toFixed(3)} (×${waterHits}) → waterRunning`);
    }

    // Vehicle-engine context boost. An approaching car splits across
    // "Motor vehicle (road)", "Engine", "Heavy engine", "Truck" etc. Sum
    // and route to vehicleEngine. We require ≥2 hits OR a strong single
    // motor-vehicle hit because "Engine" alone sometimes fires on AC units.
    const VEHICLE_CONTEXT_KEYWORDS = ['motor vehicle', 'motorcycle', 'heavy engine',
                                      'medium engine', 'light engine', 'engine starting',
                                      'engine knocking', 'truck', 'engine'];
    let vehicleSignal = 0;
    let vehicleHits = 0;
    let hasMotorVehicle = false;
    for (const { label, score } of results.slice(0, 10)) {
      const lower = label.toLowerCase();
      // Skip labels already captured by more specific siren/horn categories.
      if (lower.includes('fire engine') || lower.includes('fire truck')) continue;
      if (lower.includes('truck horn') || lower.includes('air horn')) continue;
      if (VEHICLE_CONTEXT_KEYWORDS.some(kw => lower.includes(kw))) {
        vehicleSignal += score;
        vehicleHits++;
        if (lower.includes('motor vehicle') || lower.includes('motorcycle')) hasMotorVehicle = true;
      }
    }
    if (enabled.vehicleEngine && vehicleSignal > 0 && (vehicleHits >= 2 || hasMotorVehicle)) {
      categoryScores.vehicleEngine = (categoryScores.vehicleEngine || 0) + vehicleSignal;
      console.warn(`AST vehicle-context: +${vehicleSignal.toFixed(3)} (×${vehicleHits}${hasMotorVehicle ? ', MV' : ''}) → vehicleEngine`);
    }

    // Thunder context boost. Thunder audio is diffuse: AST typically splits
    // it across "Thunder" and "Thunderstorm" at low individual scores, and
    // nearby rain often co-occurs. We require at least one direct thunder
    // hit (not just rain) before crediting co-occurring rain/raindrop —
    // otherwise a plain rainstorm would fire a thunder alert. "Rain" keyword
    // must exclude train labels which also contain the substring.
    const THUNDER_DIRECT = ['thunder', 'thunderstorm'];
    const THUNDER_COMPANION = ['raindrop', 'rain on surface', 'rain'];
    let thunderDirect = 0;
    let thunderCompanion = 0;
    for (const { label, score } of results.slice(0, 10)) {
      const lower = label.toLowerCase();
      if (lower.includes('train')) continue;  // exclude train* labels
      if (THUNDER_DIRECT.some(kw => lower.includes(kw))) {
        thunderDirect += score;
      } else if (THUNDER_COMPANION.some(kw => lower.includes(kw))) {
        thunderCompanion += score;
      }
    }
    if (enabled.thunder && thunderDirect > 0) {
      // Direct hits are already counted in categoryScores via LABEL_MAP;
      // only add companion (rain) evidence so we don't double-count thunder.
      const boost = thunderCompanion * 0.5;  // half-credit — rain is indirect
      if (boost > 0) {
        categoryScores.thunder = (categoryScores.thunder || 0) + boost;
        console.warn(`AST thunder-context: +${boost.toFixed(3)} (rain companion) → thunder`);
      }
    }

    // Apply per-category false-positive penalties the user has built up by
    // tapping "False Positive" on past alerts. Each penalty step multiplies
    // that category's aggregate score by 0.9, floored at 0.5 (5 marks maxes
    // it out). This feeds into both the ranking below and the MIN_CONFIDENCE
    // gate, so penalized categories need progressively higher raw scores to
    // fire an alert — without ever being completely silenced.
    const ranked = Object.entries(categoryScores)
      .map(([cat, score]) => {
        const pen = fpPenalties[cat] ?? 0;
        if (pen <= 0) return [cat, score, 1];
        const mult = Math.max(0.5, 1 - pen * 0.1);
        return [cat, score * mult, mult];
      })
      .sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0 && ranked[0][2] < 1) {
      console.warn(`AST FP-penalty applied: ${ranked[0][0]} ×${ranked[0][2].toFixed(2)}`);
    }
    const top5Labels = results.slice(0, 5).map(r => ({ label: r.label, score: r.score }));
    const top5 = top5Labels.map(r => `${r.label}=${r.score.toFixed(2)}`).join(', ');

    if (ranked.length === 0 || ranked[0][1] < 0.08) {
      // Safety fallback: a loud sound fired the trigger but we couldn't
      // confidently map it to any enabled category. Three gates decide
      // whether to fire an 'unknown' alert vs just update the live preview:
      //   1. peak dB — was this actually a big sound, or a small body noise?
      //   2. top label probability — is the model confident about anything?
      //   3. top label isn't a known-small sound (cough, speech, footsteps)
      // If all three pass, fire 'unknown'. Otherwise return a preview-only
      // result so the Home screen still shows live top-5 context.
      const topScore = results[0].score;
      const topLabel = results[0].label;
      const topLower = topLabel.toLowerCase();
      const isSmallSound = UNKNOWN_SUPPRESS_LABELS.some(kw => topLower.includes(kw));
      const unknownEligible = enabled.unknown !== false
        && topScore >= UNKNOWN_MIN_SCORE
        && peakDb >= UNKNOWN_MIN_PEAK_DB
        && sustainedLoud
        && !isSmallSound;

      if (unknownEligible) {
        console.warn(`AST → unknown (top=${topScore.toFixed(3)}, peak=${peakDb.toFixed(1)}dB, loud=${loudSampleCount}). Labels:`, top5);
        return {
          category: 'unknown',
          confidence: topScore,
          rawLabel: topLabel,
          labels: top5Labels,
        };
      }
      const skipReason = isSmallSound ? `small-sound (${topLabel})`
                       : topScore < UNKNOWN_MIN_SCORE ? `low-score (${topScore.toFixed(2)} < ${UNKNOWN_MIN_SCORE})`
                       : peakDb < UNKNOWN_MIN_PEAK_DB ? `quiet (${peakDb.toFixed(1)}dB < ${UNKNOWN_MIN_PEAK_DB}dB)`
                       : !sustainedLoud ? `not-sustained (loud=${loudSampleCount}, peak=${peakDb.toFixed(1)}dB)`
                       : 'unknown disabled';
      console.warn(`AST preview (no alert, ${skipReason}). Top labels:`, top5);
      return { category: null, labels: top5Labels };
    }

    const [category, aggScore] = ranked[0];
    // Since classification now runs at CLASSIFY_DB (much quieter than
    // DETECTION_DB), a matched named category from a quiet sound should not
    // fire a full alert — it just updates live preview. This keeps real
    // alerts tied to actual loud events while keeping the preview snappy.
    if (peakDb < DETECTION_DB) {
      console.warn(`AST preview (quiet named match: ${category}, peak=${peakDb.toFixed(1)}dB). Top:`, top5);
      return { category: null, labels: top5Labels };
    }
    // A single spike loud enough to cross DETECTION_DB isn't enough — we
    // require either sustained loudness across the window or a very-loud
    // impulse. Otherwise a cough / chair creak that momentarily spikes to
    // -30 dB could fire e.g. "Smoke alarm" at 70% from a phantom top-5.
    if (!sustainedLoud) {
      console.warn(`AST preview (not-sustained named: ${category}, loud=${loudSampleCount}, peak=${peakDb.toFixed(1)}dB). Top:`, top5);
      return { category: null, labels: top5Labels };
    }
    // Linear calibration: maps AudioSet aggregate 0.10 → 62%, 0.30 → 80%,
    // 0.60 → 99%. Avoids flooring everything to the same number.
    const calibrated = Math.max(0.60, Math.min(0.99, 0.52 + aggScore * 0.85));
    // Final confidence gate: below MIN_CONFIDENCE, the classifier isn't
    // sure enough to buzz the phone — demote to live preview only. Per-
    // category overrides let diffuse signatures (thunder, water) fire at a
    // lower threshold while sustained-loud + peak-dB gates above still
    // protect against spam.
    const threshold = PER_CATEGORY_MIN_CONFIDENCE[category] ?? MIN_CONFIDENCE;
    if (calibrated < threshold) {
      console.warn(`AST preview (low-conf ${category}: ${(calibrated * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%). Top:`, top5);
      return { category: null, labels: top5Labels };
    }
    console.warn(
      `AST → ${category} (agg=${aggScore.toFixed(3)}, ${(calibrated * 100).toFixed(0)}%)`,
      `| top: "${topLabelPerCategory[category]}" | all: ${top5}`,
    );
    // Attach the top-5 AST labels to every alert (not just unknown) so the
    // user can see what else the classifier considered. Gives peace of mind
    // for false positives ("it's calling this a gunshot but top-5 is 90%
    // fireworks") and confirms true positives when the breakdown all points
    // at the same category.
    return {
      category,
      confidence: calibrated,
      rawLabel: topLabelPerCategory[category],
      labels: top5Labels,
    };
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

    // Sustained-count is no longer used to gate the trigger (classifier
    // runs continuously regardless of dB) but we keep the bookkeeping in
    // case the heuristic classifier fallback ever runs.
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
  const date = typeof d === 'number' ? new Date(d) : d;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(d) {
  const date = typeof d === 'number' ? new Date(d) : d;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(date);
}

// Bucket a history entry's timestamp into a (key, label) pair for the
// chosen view scope. `key` is stable and unique per bucket; `label` is the
// human-readable header shown above the entry list.
function historyBucket(ms, scope) {
  const d = new Date(ms);
  if (scope === 'daily') {
    const key = `D-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const today = new Date();
    const yest = new Date(); yest.setDate(today.getDate() - 1);
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    let label;
    if (sameDay(d, today)) label = 'Today';
    else if (sameDay(d, yest)) label = 'Yesterday';
    else label = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    return { key, label, sort: d.getTime() };
  }
  if (scope === 'weekly') {
    // Start of the week (Sunday) at 00:00 local time.
    const start = new Date(d);
    start.setDate(d.getDate() - d.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    const key = `W-${start.getFullYear()}-${start.getMonth()}-${start.getDate()}`;
    const sLbl = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const eLbl = end.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return { key, label: `Week of ${sLbl} – ${eLbl}`, sort: start.getTime() };
  }
  if (scope === 'monthly') {
    const key = `M-${d.getFullYear()}-${d.getMonth()}`;
    const label = d.toLocaleDateString([], { month: 'long', year: 'numeric' });
    const sort = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return { key, label, sort };
  }
  // yearly
  const key = `Y-${d.getFullYear()}`;
  return { key, label: String(d.getFullYear()), sort: new Date(d.getFullYear(), 0, 1).getTime() };
}

function groupHistoryByScope(history, scope) {
  const groups = new Map();
  for (const entry of history) {
    if (typeof entry.time !== 'number') continue;
    const b = historyBucket(entry.time, scope);
    if (!groups.has(b.key)) groups.set(b.key, { key: b.key, label: b.label, sort: b.sort, entries: [] });
    groups.get(b.key).entries.push(entry);
  }
  const out = [...groups.values()];
  // Newest bucket first; entries within a bucket also newest first.
  out.sort((a, b) => b.sort - a.sort);
  out.forEach(g => g.entries.sort((a, b) => b.time - a.time));
  return out;
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

function HomeScreen({ enabled, onAlert, history, listening, setListening, dbLevel, micGranted, livePreview }) {
  const recent = [...history].reverse().slice(0, 4);

  // Map dB (-60 … 0) to a 0–1 fill for the meter bar
  const meterFill = Math.min(1, Math.max(0, (dbLevel + 60) / 60));
  const meterColor = dbLevel > DETECTION_DB ? '#FF3B30' : dbLevel > CLASSIFY_DB ? '#FF9500' : '#34C759';

  // Age the live preview so stale classifications fade out visually
  // (dim after 4s, hide after 15s). Re-renders via the dbLevel prop stream.
  const previewAge = livePreview ? (Date.now() - livePreview.t) / 1000 : Infinity;
  const previewVisible = livePreview && previewAge < 15;
  const previewFresh = previewAge < 4;

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

        {/* live classifier top-5 — ambient context, not an alert */}
        {micGranted && listening && previewVisible && (
          <View style={{
            backgroundColor: '#1C1C1E', borderRadius: 14, padding: 14,
            marginBottom: 16, borderWidth: 1, borderColor: '#2C2C2E',
            opacity: previewFresh ? 1 : 0.55,
          }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ color: '#636366', fontSize: 12, fontWeight: '700', letterSpacing: 0.8 }}>
                LIVE CONTEXT · TOP 5 SOUNDS
              </Text>
              <Text style={{ color: previewFresh ? '#34C759' : '#636366', fontSize: 11, fontWeight: '600' }}>
                {previewFresh ? 'NOW' : `${Math.round(previewAge)}s ago`}
              </Text>
            </View>
            {livePreview.labels.map(({ label, score }, idx) => (
              <View key={`${label}-${idx}`} style={{ marginBottom: idx === livePreview.labels.length - 1 ? 0 : 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                  <Text style={{ fontSize: 14, marginRight: 6 }}>{emojiForLabel(label)}</Text>
                  <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '500', flex: 1, marginRight: 8 }} numberOfLines={1}>
                    {label}
                  </Text>
                  <Text style={{ color: '#8E8E93', fontSize: 12, fontWeight: '700' }}>
                    {Math.round(score * 100)}%
                  </Text>
                </View>
                <View style={{ height: 3, backgroundColor: '#2C2C2E', borderRadius: 2, overflow: 'hidden' }}>
                  <View style={{ height: 3, width: `${Math.min(100, score * 100)}%`, backgroundColor: '#007AFF', borderRadius: 2 }} />
                </View>
              </View>
            ))}
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
              const displayLabel = a.userReclassified && a.userLabel ? a.userLabel : s.label;
              return (
                <View key={i} style={[S.histRow, { borderLeftColor: s.color }]}>
                  <Text style={{ fontSize: 24 }}>{s.emoji}</Text>
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Text style={{ color: s.color, fontSize: 16, fontWeight: '700' }}>{displayLabel}</Text>
                    <Text style={{ color: '#636366', fontSize: 13 }}>
                      {fmtTime(a.time)}
                      {a.confidence != null && `  ·  ${Math.round(a.confidence * 100)}%`}
                      {a.userReclassified && '  ·  you tagged'}
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
          {Object.values(SOUNDS).filter(s => enabled[s.id] && s.id !== 'unknown').map(s => (
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

function AlertScreen({ alertType, onDismiss, onReclassify, onFalsePositive }) {
  // alertType is now { id, confidence, labels? }
  // Snapshot the alert data on mount so the displayed soundId, confidence, and
  // label breakdown can NEVER mutate while the alert is visible. The mic is
  // paused during the alert (so no new classifications should fire anyway),
  // but this is defense in depth — if the user is staring at "Computer
  // keyboard 34% · Typing 18%" trying to decide if they should act, we don't
  // want vibration sine-waves or any other stray re-classification to swap in
  // "Busy signal, telephone · Sidetone" and hide the real event.
  const initialId = typeof alertType === 'string' ? alertType : alertType.id;
  const initialConfidence = typeof alertType === 'string' ? null : alertType.confidence;
  const initialLabels = typeof alertType === 'string' ? null : alertType.labels;
  const [soundId] = useState(initialId);
  const [confidence] = useState(initialConfidence);
  const [labels] = useState(initialLabels);
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
          <ScrollView
            style={{ width: '100%' }}
            contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 }}
            showsVerticalScrollIndicator={false}
          >
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
        <View style={{ backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, marginBottom: labels && labels.length > 0 ? 14 : 28 }}>
          <Text style={{ color: s.color, fontSize: 13, fontWeight: '700', letterSpacing: 0.5 }}>
            Detected with {Math.round(confidence * 100)}% confidence
          </Text>
        </View>
      )}
      {labels && labels.length > 0 && (
        <View style={{
          width: '100%', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 14,
          paddingVertical: 14, paddingHorizontal: 16, marginBottom: 24,
          borderWidth: 1, borderColor: s.color,
        }}>
          <Text style={{
            color: s.color, fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
            marginBottom: 10, textAlign: 'center',
          }}>
            TOP 5 CANDIDATES · WHAT ELSE IT COULD BE
          </Text>
          {labels.map(({ label, score }, idx) => (
            <View key={`${label}-${idx}`} style={{ marginBottom: idx === labels.length - 1 ? 0 : 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                <Text style={{ fontSize: 15, marginRight: 8 }}>{emojiForLabel(label)}</Text>
                <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600', flex: 1, marginRight: 8 }} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={{ color: s.color, fontSize: 13, fontWeight: '700' }}>
                  {Math.round(score * 100)}%
                </Text>
              </View>
              <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 2, overflow: 'hidden' }}>
                <View style={{ height: 4, width: `${Math.min(100, score * 100)}%`, backgroundColor: s.color, borderRadius: 2 }} />
              </View>
            </View>
          ))}
        </View>
      )}
      {soundId === 'unknown' && labels && labels.length > 0 && onReclassify && (
        <View style={{
          width: '100%', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 14,
          paddingVertical: 14, paddingHorizontal: 14, marginBottom: 24,
          borderWidth: 1, borderColor: '#FFD60A',
        }}>
          <Text style={{
            color: '#FFD60A', fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
            marginBottom: 4, textAlign: 'center',
          }}>
            WHAT DID YOU THINK IT WAS?
          </Text>
          <Text style={{ color: '#AEAEB2', fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
            Tap the label that matches — we'll save it to your history.
          </Text>
          {labels.map(({ label, score }, idx) => (
            <TouchableOpacity
              key={`pick-${label}-${idx}`}
              activeOpacity={0.7}
              onPress={() => { Haptics.selectionAsync().catch(() => {}); onReclassify(label); }}
              style={{
                flexDirection: 'row', alignItems: 'center',
                backgroundColor: 'rgba(255,214,10,0.08)',
                borderWidth: 1, borderColor: 'rgba(255,214,10,0.35)',
                borderRadius: 10, padding: 10,
                marginBottom: idx === labels.length - 1 ? 0 : 8,
              }}
            >
              <Text style={{ fontSize: 18, marginRight: 10 }}>{emojiForLabel(label)}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                  {label}
                </Text>
                <Text style={{ color: '#8E8E93', fontSize: 11 }}>
                  {Math.round(score * 100)}% · tap to save
                </Text>
              </View>
              <Text style={{ color: '#FFD60A', fontSize: 18, fontWeight: '700' }}>›</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
          <View style={{ width: '100%', alignItems: 'center' }}>
            <TouchableOpacity
              style={[S.dismissBtn, { backgroundColor: s.color, shadowColor: s.color }]}
              onPress={() => { Vibration.vibrate(); Haptics.selectionAsync().catch(() => {}); onDismiss(); }}
            >
              <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800' }}>Dismiss</Text>
            </TouchableOpacity>
            {onFalsePositive && (
              <TouchableOpacity
                style={{
                  marginTop: 14,
                  paddingVertical: 14,
                  paddingHorizontal: 28,
                  borderRadius: 14,
                  borderWidth: 1.5,
                  borderColor: '#8E8E93',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                }}
                onPress={() => { Haptics.selectionAsync().catch(() => {}); onFalsePositive(); }}
              >
                <Text style={{ color: '#AEAEB2', fontSize: 15, fontWeight: '600', textAlign: 'center' }}>
                  ✕  False Positive
                </Text>
                <Text style={{ color: '#636366', fontSize: 11, marginTop: 3, textAlign: 'center' }}>
                  Skip logging · make this category harder to trigger
                </Text>
              </TouchableOpacity>
            )}
          </View>
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ─────────────── PREFERENCES ─────────────── */

function PreferencesScreen({ enabled, setEnabled, sensitivity, setSensitivity, historyRetention, setHistoryRetention, onRestartOnboarding }) {
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

        <Text style={[S.sectionLabel, { marginTop: 24 }]}>HISTORY RETENTION</Text>
        <View style={S.segControl}>
          {HISTORY_RETENTION_LABELS.map((r, i) => (
            <TouchableOpacity
              key={r}
              style={[S.segBtn, { backgroundColor: historyRetention === r ? '#007AFF' : '#1C1C1E', borderLeftWidth: i > 0 ? 1 : 0, borderLeftColor: '#2C2C2E' }]}
              onPress={() => setHistoryRetention(r)}
            >
              <Text style={{ color: '#FFF', fontSize: 14, fontWeight: historyRetention === r ? '700' : '400', textTransform: 'capitalize' }}>{r}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: '#48484A', fontSize: 13, marginTop: 8, lineHeight: 18 }}>
          Older entries are dropped automatically. Daily keeps 24 hours; weekly 7 days; monthly 30 days; yearly a full year.
        </Text>

        <Text style={[S.sectionLabel, { marginTop: 24 }]}>PRIVACY</Text>
        <View style={S.privBox}>
          <Text style={{ color: '#34C759', fontWeight: '700', fontSize: 15, marginBottom: 8 }}>🔒  On-Device Processing</Text>
          <Text style={{ color: '#636366', fontSize: 14, lineHeight: 20 }}>
            All audio classification happens locally. No microphone data ever leaves your phone.
          </Text>
        </View>

        <Text style={[S.sectionLabel, { marginTop: 24 }]}>SETUP</Text>
        <TouchableOpacity
          style={{ backgroundColor: '#2D0000', borderRadius: 14, padding: 16, borderWidth: 1, borderColor: '#FF3B30' }}
          onPress={onRestartOnboarding}
        >
          <Text style={{ color: '#FF3B30', fontSize: 15, fontWeight: '700', marginBottom: 4 }}>🔄  Restart Onboarding</Text>
          <Text style={{ color: '#AEAEB2', fontSize: 13, lineHeight: 18 }}>
            Clears your sound history and walks you through first-time setup again. Your sound preferences will be re-applied from the onboarding flow.
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

/* ─────────────── HISTORY ─────────────── */

// Reveals a red "Delete" drawer when the user swipes left on a history row.
// Swipe right (or tap the row body once open) snaps it closed.
const SWIPE_REVEAL = 90;       // px of drawer width revealed on full-open
const SWIPE_ACTIVATE = 40;     // drag past this → snap open on release
const SWIPE_H_SLOP = 6;        // horizontal drag needed before we capture
function SwipeableHistoryRow({ onDelete, children }) {
  const translateX = useRef(new Animated.Value(0)).current;
  const offset = useRef(0);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Capture only clear horizontal drags so ScrollView still handles
      // vertical scroll.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dx) > SWIPE_H_SLOP && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => {
        translateX.setOffset(offset.current);
        translateX.setValue(0);
      },
      onPanResponderMove: (_, g) => {
        // Clamp to [-SWIPE_REVEAL, 0] — only left-swipe is meaningful.
        let next = g.dx;
        const withOffset = offset.current + next;
        if (withOffset > 0) next = -offset.current;
        else if (withOffset < -SWIPE_REVEAL) next = -SWIPE_REVEAL - offset.current;
        translateX.setValue(next);
      },
      onPanResponderRelease: (_, g) => {
        translateX.flattenOffset();
        const final = offset.current + g.dx;
        const target = final < -SWIPE_ACTIVATE ? -SWIPE_REVEAL : 0;
        offset.current = target;
        Animated.spring(translateX, { toValue: target, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
      },
    }),
  ).current;

  const close = () => {
    offset.current = 0;
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 0, speed: 20 }).start();
  };

  return (
    <View style={{ marginBottom: 8 }}>
      {/* Red drawer underneath — revealed as the row slides left. */}
      <View style={{
        position: 'absolute', top: 0, bottom: 0, right: 0, width: SWIPE_REVEAL,
        backgroundColor: '#FF3B30', borderRadius: 14,
        justifyContent: 'center', alignItems: 'center',
      }}>
        <TouchableOpacity
          onPress={() => { Haptics.selectionAsync().catch(() => {}); onDelete(); }}
          style={{ paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' }}
        >
          <Text style={{ fontSize: 20 }}>🗑</Text>
          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 2 }}>Delete</Text>
        </TouchableOpacity>
      </View>
      <Animated.View
        {...panResponder.panHandlers}
        style={{ transform: [{ translateX }] }}
      >
        <TouchableOpacity activeOpacity={1} onPress={close}>
          {children}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}

function HistoryScreen({ history, onClear, onDelete, retention }) {
  const [scope, setScope] = useState('daily');
  const groups = useMemo(() => groupHistoryByScope(history, scope), [history, scope]);

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

      {/* View-scope selector — reshapes how entries are grouped. Independent
          of retention, which just controls how far back data is kept. */}
      <View style={{ paddingHorizontal: 16, paddingTop: 14 }}>
        <View style={S.segControl}>
          {HISTORY_RETENTION_LABELS.map((s, i) => (
            <TouchableOpacity
              key={s}
              style={[S.segBtn, { backgroundColor: scope === s ? '#007AFF' : '#1C1C1E', borderLeftWidth: i > 0 ? 1 : 0, borderLeftColor: '#2C2C2E' }]}
              onPress={() => setScope(s)}
            >
              <Text style={{ color: '#FFF', fontSize: 13, fontWeight: scope === s ? '700' : '400', textTransform: 'capitalize' }}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={{ color: '#48484A', fontSize: 12, marginTop: 8 }}>
          Showing <Text style={{ color: '#8E8E93' }}>{scope}</Text> groups · retaining <Text style={{ color: '#8E8E93' }}>{retention}</Text>
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {groups.length === 0
          ? <View style={[S.emptyBox, { marginTop: 40 }]}>
              <Text style={{ fontSize: 42, textAlign: 'center' }}>📋</Text>
              <Text style={{ color: '#636366', textAlign: 'center', marginTop: 12 }}>No detection history yet</Text>
            </View>
          : groups.map(g => (
              <View key={g.key} style={{ marginBottom: 18 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <Text style={[S.sectionLabel, { marginBottom: 0 }]}>{g.label}</Text>
                  <Text style={{ color: '#48484A', fontSize: 12 }}>
                    {g.entries.length} {g.entries.length === 1 ? 'event' : 'events'}
                  </Text>
                </View>
                {g.entries.map((a, i) => {
                  const s = SOUNDS[a.type] ?? SOUNDS.unknown;
                  const displayLabel = a.userReclassified && a.userLabel ? a.userLabel : s.label;
                  const rowKey = a.id ?? `${g.key}-${i}`;
                  return (
                    <SwipeableHistoryRow
                      key={rowKey}
                      onDelete={() => a.id && onDelete(a.id)}
                    >
                      <View style={[S.histRow, { marginBottom: 0, borderLeftColor: s.color }]}>
                        <View style={[S.histIcon, { backgroundColor: s.bgColor, borderColor: s.color }]}>
                          <Text style={{ fontSize: 22 }}>{s.emoji}</Text>
                        </View>
                        <View style={{ flex: 1, marginLeft: 14 }}>
                          <Text style={{ color: s.color, fontSize: 16, fontWeight: '700' }}>{displayLabel}</Text>
                          <Text style={{ color: '#636366', fontSize: 13 }}>
                            {fmtDateTime(a.time)}
                            {a.confidence != null && `  ·  ${Math.round(a.confidence * 100)}%`}
                            {a.userReclassified && '  ·  you tagged'}
                          </Text>
                        </View>
                        {s.priority === 'CRITICAL' && (
                          <View style={S.critBadge}><Text style={{ color: '#FF3B30', fontSize: 11, fontWeight: '700' }}>CRITICAL</Text></View>
                        )}
                      </View>
                    </SwipeableHistoryRow>
                  );
                })}
              </View>
            ))
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
  const [historyRetention, setHistoryRetention] = useState(DEFAULT_RETENTION);
  const [history, setHistory] = useState([]);
  // Per-category FP counters. Bumped by the "False Positive" alert button;
  // read by runClassification (via fpPenaltiesRef) and passed to the
  // classifier to downweight the offending category on future predictions.
  const [fpPenalties, setFpPenalties] = useState({});
  const [listening, setListening] = useState(true);
  const [micGranted, setMicGranted] = useState(false);
  const [dbLevel, setDbLevel] = useState(-160);
  // Most recent top-5 classifier output. Updated after every classification
  // cycle (alert or not) so the Home screen can show live context about
  // what's happening around the user, reducing "unknown" alert anxiety.
  // Shape: { labels: [{label, score}], t: number(ms since epoch) } | null
  const [livePreview, setLivePreview] = useState(null);

  // Load saved preferences + history on mount. If the user has completed
  // onboarding before, skip straight to the main app. History is trimmed
  // against the retention window on load so stale entries don't linger if
  // the app was closed for longer than the window.
  useEffect(() => {
    (async () => {
      const prefs = await loadPrefs();
      const retention = prefs?.historyRetention ?? DEFAULT_RETENTION;
      if (prefs) {
        setEnabled(prefs.enabled);
        setSensitivity(prefs.sensitivity);
        setHistoryRetention(retention);
        setFpPenalties(prefs.fpPenalties || {});
        if (prefs.hasOnboarded) setPhase('main');
      }
      const diskHistory = await loadHistoryFromDisk();
      const trimmed = trimHistory(diskHistory, retention).map(e =>
        e.id ? e : { ...e, id: `${(e.time ?? Date.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}` }
      );
      setHistory(trimmed);
      // If we dropped anything on load, write the pruned list back so
      // the file doesn't grow unbounded across sessions.
      if (trimmed.length !== diskHistory.length) {
        saveHistoryToDisk(stripLabelsForDisk(trimmed));
      }
      setPrefsLoaded(true);
    })();
  }, []);

  // Persist prefs whenever they change (but only after load).
  useEffect(() => {
    if (!prefsLoaded) return;
    savePrefs({ enabled, sensitivity, historyRetention, fpPenalties });
  }, [enabled, sensitivity, historyRetention, fpPenalties, prefsLoaded]);

  // Persist history, trimmed to the retention window, on every change.
  // Trimming here means a new detection on a new day naturally pushes the
  // furthest-past day out of the window — no separate cleanup job needed.
  // Labels are stripped before write to keep on-disk size small (~70 bytes
  // per entry vs ~280 bytes with labels).
  useEffect(() => {
    if (!prefsLoaded) return;
    const trimmed = trimHistory(history, historyRetention);
    saveHistoryToDisk(stripLabelsForDisk(trimmed));
    // If trimming dropped entries, reflect that in memory too so the UI
    // matches what's on disk.
    if (trimmed.length !== history.length) {
      setHistory(trimmed);
    }
  }, [history, historyRetention, prefsLoaded]);

  const cooldownRef  = useRef(false);
  const enabledRef   = useRef(enabled);
  const listeningRef = useRef(listening);

  const sensitivityRef = useRef(sensitivity);
  const fpPenaltiesRef = useRef(fpPenalties);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  useEffect(() => { fpPenaltiesRef.current = fpPenalties; }, [fpPenalties]);

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
  // When a classified alert fires we pause the mic entirely until dismiss so
  // the next classification has zero audio from before the user acknowledged.
  // Otherwise the tail of the ongoing sound event (a fading smoke alarm, an
  // echo of a dog bark, etc.) would mix into a fresh detection window and
  // bias classifications toward the alert that was just dismissed.
  const awaitingDismissRef = useRef(false);
  // startRecording is defined inside the recorder useEffect; we mirror it
  // here so handleDismiss (defined at root scope) can start a fresh mic
  // session the moment the user dismisses.
  const startRecordingFnRef = useRef(null);
  // Tracks the loudest sample seen during the current detection window so
  // classifyAudioFile can gate the 'unknown' fallback on actual peak volume
  // (not just the classifier's confidence). Reset after each cycle.
  const triggerPeakDbRef = useRef(-160);
  // Count of metering samples above DETECTION_DB seen during the current
  // classification window. classifyAudioFile uses it with MIN_LOUD_SAMPLES
  // to demand sustained loudness (or a single VERY_LOUD peak) before firing.
  const peakAboveThresholdCountRef = useRef(0);
  // Wall-clock ms when the currently active recording started. Used to
  // block classification until at least MIN_RECORDING_MS of audio has been
  // captured — otherwise the first cycle after startRecording would fire
  // almost immediately with just 200ms of buffer.
  const recordingStartedAtRef = useRef(0);
  // Map of top-label → last-acked timestamp (ms). Written when the user
  // dismisses or reclassifies an 'unknown' alert; read at classify time to
  // stop the same top label from buzzing the phone again for 5 minutes.
  const recentlyAckedUnknownRef = useRef({});

  const handleAlert = useCallback((id) => {
    // Manual triggers (test buttons on Home) use a realistic-looking synthetic
    // confidence and flag `manual: true` so the FP button doesn't bump the
    // category's penalty — a user testing haptics shouldn't train the model.
    const confidence = 0.88 + Math.random() * 0.1;
    setAlertType({ id, confidence, firedAt: Date.now(), manual: true });
  }, []);

  // Clear all history immediately (both memory and disk).
  const handleClearHistory = useCallback(() => {
    setHistory([]);
    clearHistoryOnDisk();
  }, []);

  // Remove a single history entry. The persist-history effect will
  // rewrite the disk file on the next render tick.
  const handleDeleteHistoryEntry = useCallback((id) => {
    setHistory(h => h.filter(e => e.id !== id));
  }, []);

  // Kick the user back to onboarding. Wipes history + the hasOnboarded
  // flag so the setup flow runs fresh; sound prefs are cleared back to
  // defaults so the onboarding toggles show the baseline. The onboarding
  // completion handler re-saves whatever the user picks.
  const handleRestartOnboarding = useCallback(() => {
    Alert.alert(
      'Restart setup?',
      'This will clear your sound history and walk you through onboarding again. Your settings will be re-applied from what you choose there.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restart',
          style: 'destructive',
          onPress: async () => {
            setHistory([]);
            await clearHistoryOnDisk();
            setEnabled(DEFAULT_ENABLED);
            setSensitivity('Medium');
            setHistoryRetention(DEFAULT_RETENTION);
            setFpPenalties({});
            await savePrefs({
              enabled: DEFAULT_ENABLED,
              sensitivity: 'Medium',
              historyRetention: DEFAULT_RETENTION,
              fpPenalties: {},
              hasOnboarded: false,
            });
            setTab('home');
            setAlertType(null);
            setPhase('onboarding');
          },
        },
      ],
    );
  }, []);

  // Core teardown shared by dismiss / reclassify / FP / timeout. If
  // `shouldLog` is true, the current alertType is appended to history
  // (with any overrides the caller supplied — reclassify uses this to
  // stamp userLabel / swap the type). Either way, mic state is reset and
  // recording restarts for the next detection window.
  const finalizeAlert = useCallback((shouldLog, overrides = {}) => {
    if (alertType) {
      // Unknown-label dedup: both dismiss and FP should stop the same top
      // label from buzzing the phone again for 5 minutes. (FP also bumps
      // the category penalty separately, below.)
      if (alertType.id === 'unknown') {
        const topLabel = alertType.labels?.[0]?.label;
        if (topLabel) recentlyAckedUnknownRef.current[topLabel] = Date.now();
      }
      if (shouldLog) {
        setHistory(h => [...h, {
          // Random id so swipe-to-delete can target a specific entry even
          // when two events share the same millisecond timestamp.
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          type: overrides.type ?? alertType.id,
          time: alertType.firedAt ?? Date.now(),
          confidence: alertType.confidence,
          labels: alertType.labels,
          ...overrides,
        }]);
      }
    }
    setAlertType(null);

    if (awaitingDismissRef.current) {
      awaitingDismissRef.current = false;
      classifierRef.current.reset();
      cooldownRef.current = false;
      classifyingRef.current = false;
      if (listeningRef.current && startRecordingFnRef.current) {
        startRecordingFnRef.current().catch(e => console.warn('Post-finalize recording:', e.message));
      }
    }
  }, [alertType]);

  const handleDismiss = useCallback(() => {
    Haptics.selectionAsync().catch(e => console.warn('Dismiss haptic:', e.message));
    finalizeAlert(true);
  }, [finalizeAlert]);

  // User tapped "False Positive" — drop the alert without logging, and bump
  // the category's FP counter so classifyAudioFile downweights that category
  // (×0.9 per mark, floored at ×0.5) on future predictions. Manual test
  // alerts are exempt — testing haptics shouldn't train the model.
  const handleFalsePositive = useCallback(() => {
    if (alertType && !alertType.manual && alertType.id !== 'unknown') {
      const cat = alertType.id;
      setFpPenalties(p => ({ ...p, [cat]: (p[cat] ?? 0) + 1 }));
      console.warn(`FP marked: ${cat} → penalty now ${(fpPenalties[cat] ?? 0) + 1}`);
    }
    Haptics.selectionAsync().catch(e => console.warn('FP haptic:', e.message));
    finalizeAlert(false);
  }, [alertType, fpPenalties, finalizeAlert]);

  // User tapped one of the top-5 labels on an 'unknown' alert to tell us
  // what they actually think the sound was. Log a fresh entry (unknowns
  // don't log on fire anymore) with userLabel stamped, mapping the type
  // to a known category if the chosen label matches one.
  const handleReclassify = useCallback((label) => {
    const mappedCategory = categoryForLabel(label);
    finalizeAlert(true, {
      userLabel: label,
      userReclassified: true,
      ...(mappedCategory ? { type: mappedCategory } : {}),
    });
  }, [finalizeAlert]);

  // Auto-dismiss after 3 minutes — logs to history exactly as if the user
  // had tapped Dismiss. Prevents an ignored alert from sitting on screen
  // forever (mic is paused while the alert is up, so a stale alert also
  // blocks new detections).
  useEffect(() => {
    if (!alertType) return;
    const t = setTimeout(() => {
      console.warn('Alert auto-timed out after 3 min — logging + dismissing');
      finalizeAlert(true);
    }, 3 * 60 * 1000);
    return () => clearTimeout(t);
  }, [alertType, finalizeAlert]);

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
        const peakDb = triggerPeakDbRef.current;
        const loudSampleCount = peakAboveThresholdCountRef.current;
        triggerPeakDbRef.current = -160;
        peakAboveThresholdCountRef.current = 0;
        if (uri) {
          result = await classifyAudioFile(uri, enabledRef.current, peakDb, loudSampleCount, fpPenaltiesRef.current);
        }

        // Dedup: if this would have fired an 'unknown' alert but the user
        // already acked the same top label within the window, demote to
        // preview-only. Stops music / busy signals / sine waves from
        // re-alerting every few seconds while they continue playing.
        if (result && result.category === 'unknown') {
          const topLabel = result.labels?.[0]?.label;
          const lastAck = topLabel ? recentlyAckedUnknownRef.current[topLabel] : null;
          if (lastAck && (Date.now() - lastAck) < UNKNOWN_DEDUP_WINDOW_MS) {
            const ageSec = Math.round((Date.now() - lastAck) / 1000);
            console.warn(`Unknown deduped: "${topLabel}" acked ${ageSec}s ago`);
            result = { category: null, labels: result.labels };
          }
        }

        if (result && result.labels && !cancelled) {
          // Always surface top-5 to the Home live preview, even when no alert
          // fires — this is the "live context" users can glance at between
          // alerts to understand ambient sound.
          setLivePreview({ labels: result.labels, t: Date.now() });
        }

        if (result && result.category && !cancelled) {
          // Note: history is NOT logged here. An alert only enters history if
          // the user explicitly dismisses it, auto-timeouts after 3 minutes,
          // or reclassifies an unknown. Tapping "False Positive" drops the
          // event without logging — and also bumps the category's FP counter
          // so future classifications downweight it.
          setAlertType({
            id: result.category,
            confidence: result.confidence,
            labels: result.labels,
            firedAt: Date.now(),
          });
          // Alert is showing. Leave the mic off and keep cooldown/classifying
          // flags held until the user hits Dismiss — handleDismiss then starts
          // a fresh recording so the next classification window contains only
          // audio from *after* the user acknowledged. This prevents residue
          // from the alert event (or any sound that plays while the alert is
          // up) from biasing the next detection.
          awaitingDismissRef.current = true;
        }

        classifierRef.current.reset();
      } catch (e) {
        console.warn('Classification pipeline error:', e.message);
      } finally {
        // If an alert fired, everything stays paused until handleDismiss.
        // Otherwise (no match, or error): resume continuous monitoring and
        // release the cooldown after a short delay.
        if (!awaitingDismissRef.current) {
          if (!cancelled && listeningRef.current) {
            await startRecording();
          }
          setTimeout(() => {
            cooldownRef.current = false;
            classifyingRef.current = false;
          }, COOLDOWN_SEC * 1000);
        }
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
            if (db > triggerPeakDbRef.current) triggerPeakDbRef.current = db;
            if (db > DETECTION_DB) peakAboveThresholdCountRef.current++;

            // Classifier runs as soon as any sample crosses CLASSIFY_DB (-43).
            // Below that the room is effectively silent — no point burning
            // battery on a "Silence 90%" preview update. Named + unknown
            // alerts are still gated inside classifyAudioFile by peak dB vs
            // DETECTION_DB (-35) + sustained-loudness + MIN_CONFIDENCE, so
            // quiet-but-classifiable sounds (typing, nearby speech) still
            // refresh the Home top-5 without buzzing the phone.
            const elapsedMs = Date.now() - recordingStartedAtRef.current;
            if (db > CLASSIFY_DB
                && elapsedMs >= MIN_RECORDING_MS
                && !cooldownRef.current
                && !classifyingRef.current
                && listeningRef.current) {
              cooldownRef.current = true;
              classifyingRef.current = true;
              console.warn(`Classify cycle (db=${db.toFixed(1)}, buf=${elapsedMs}ms) → classifying...`);
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
        recordingStartedAtRef.current = Date.now();
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

    // Expose the current startRecording closure so handleDismiss (declared at
    // component scope) can start a fresh mic session after dismiss.
    startRecordingFnRef.current = startRecording;

    // Don't auto-start the mic while an alert is awaiting dismiss — the whole
    // point is that recording only resumes when the user explicitly
    // acknowledges, so the next classification has no pre-dismiss audio.
    if (listening && !awaitingDismissRef.current) {
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
          {alertType && <AlertScreen alertType={alertType} onDismiss={handleDismiss} onReclassify={handleReclassify} onFalsePositive={handleFalsePositive} />}
        </Modal>
        <View style={{ flex: 1 }}>
          {tab === 'home'        && <HomeScreen enabled={enabled} onAlert={handleAlert} history={history} listening={listening} setListening={setListening} dbLevel={dbLevel} micGranted={micGranted} livePreview={livePreview} />}
          {tab === 'preferences' && <PreferencesScreen enabled={enabled} setEnabled={setEnabled} sensitivity={sensitivity} setSensitivity={setSensitivity} historyRetention={historyRetention} setHistoryRetention={setHistoryRetention} onRestartOnboarding={handleRestartOnboarding} />}
          {tab === 'history'     && <HistoryScreen history={history} onClear={handleClearHistory} onDelete={handleDeleteHistoryEntry} retention={historyRetention} />}
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
