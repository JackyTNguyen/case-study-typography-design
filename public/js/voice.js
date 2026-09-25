// Voice commands: an accessible alternative to the hand-tracked buttons, via
// the browser's Web Speech API. If it's missing or the mic is refused, the
// kiosk carries on with hand tracking and keyboard.
(function () {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const COMMANDS = [
    { action: 'capture', re: /\b(take (my|a|the) (photo|picture)|take photo|cheese|capture|photo|picture|foto|maak (een )?foto)\b/i },
    { action: 'reset', re: /\b(again|try again|restart|reset|start over|retry|opnieuw)\b/i },
  ];

  function start({ lang = 'en-US', onCommand, onStatus = () => {} }) {
    if (!Recognition) {
      onStatus('unsupported');
      return { supported: false, stop() {} };
    }

    const rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    let running = true;
    let lastFired = 0;

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        for (const alt of event.results[i]) {
          const hit = COMMANDS.find((c) => c.re.test(alt.transcript));
          // Interim results repeat the same phrase many times; act once per ~2s.
          if (hit && Date.now() - lastFired > 2000) {
            lastFired = Date.now();
            onCommand(hit.action, alt.transcript);
            return;
          }
        }
      }
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        running = false;
        onStatus('denied');
      }
    };

    // Chrome ends continuous sessions every so often; keep listening.
    rec.onend = () => {
      if (running) setTimeout(() => { try { rec.start(); } catch {} }, 300);
    };

    try {
      rec.start();
      onStatus('listening');
    } catch {
      onStatus('unsupported');
    }

    return { supported: true, stop() { running = false; try { rec.stop(); } catch {} } };
  }

  window.MirrorVoice = { start };
})();
