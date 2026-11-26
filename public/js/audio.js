/**
 * Real-time Audio Synthesizer & Speech Engine for Restaurant KOT
 * Built using Web Audio API and SpeechSynthesis API
 * Completely standalone - No external MP3 files needed.
 */

let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Ensure audio context resumes upon first user interaction
document.addEventListener('click', () => {
  getAudioContext();
}, { once: true });

// 1. Kitchen New Order Alert (Rich Dual Bell Ding)
function playKitchenBell() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    
    // First high note (Ding)
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now); // A5
    osc1.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
    gain1.gain.setValueAtTime(0.4, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.8);

    // Second resonant note (Dong)
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(659.25, now + 0.18); // E5
    gain2.gain.setValueAtTime(0.5, now + 0.18);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.18);
    osc2.stop(now + 1.2);

  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

// 2. Order Ready Public Chime (Triple ascending harmonic chime)
function playOrderReadyChime() {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
    notes.forEach((freq, idx) => {
      const startTime = ctx.currentTime + (idx * 0.12);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.35, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.7);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.7);
    });
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

// 3. Spoken Announcement (e.g. for TV Display)
function speakOrderReady(tokenNumber, channelOrTable) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel(); // Stop prior speeches

    let text = `Order ${tokenNumber} is ready!`;
    if (channelOrTable) {
      if (channelOrTable.toLowerCase().includes('table')) {
        text = `Order for ${channelOrTable}, token ${tokenNumber} is ready.`;
      } else if (channelOrTable.toLowerCase().includes('swiggy')) {
        text = `Swiggy order, token ${tokenNumber} is ready for pickup.`;
      } else if (channelOrTable.toLowerCase().includes('zomato')) {
        text = `Zomato order, token ${tokenNumber} is ready for pickup.`;
      } else if (channelOrTable.toLowerCase().includes('takeaway')) {
        text = `Takeaway order, token ${tokenNumber} is ready.`;
      }
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.05;
    utterance.volume = 1.0;

    // Pick a natural English voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    window.speechSynthesis.speak(utterance);
  } catch (e) {
    console.warn('Speech error:', e);
  }
}

// Export to window
window.KotAudio = {
  playKitchenBell,
  playOrderReadyChime,
  speakOrderReady
};

