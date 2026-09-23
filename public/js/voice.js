// Voice commands: an accessible alternative to the hand-tracked button.
// Uses the browser's Web Speech API; if it's missing or the mic is refused,
// the app just carries on with hand tracking and keyboard.
(function () {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  const COMMANDS = [
    { action: 'capture', re: /\b(take (my|a|the) (photo|picture)|cheese|capture|take photo|photo|picture|foto|maak (een )?foto)\b/i },
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
        const result = event.results[i];
        for (let a = 0; a < result.length; a++) {
          const said = result[a].transcript;
          const hit = COMMANDS.find((c) => c.re.test(said));
          // Interim results arrive many times per phrase; fire once per ~2s.
          if (hit && Date.now() - lastFired > 2000) {
            lastFired = Date.now();
            onCommand(hit.action, said);
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

    // Chrome ends continuous sessions after a while; keep listening.
    rec.onend = () => {
      if (running) setTimeout(() => { try { rec.start(); } catch {} }, 300);
    };

    try {
      rec.start();
      onStatus('listening');
    } catch {
      onStatus('unsupported');
    }

    return {
      supported: true,
      stop() { running = false; try { rec.stop(); } catch {} },
    };
  }

  window.MirrorVoice = { start };
})();
