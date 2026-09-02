/** Renders a deterministic 4-digit CAPTCHA into the <img> as a data URL. */
(function () {
  const params = new URLSearchParams(location.search);
  const code = params.get('code') || '3947';
  const noise = params.get('noise') !== '0';

  function draw(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 90;
    canvas.height = 34;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 24px "DejaVu Sans", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    text.split('').forEach((ch, i) => {
      ctx.save();
      ctx.translate(10 + i * 19, 18);
      ctx.rotate(((i % 2 ? 1 : -1) * 4 * Math.PI) / 180);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
    if (noise) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.moveTo(2, 26);
      ctx.bezierCurveTo(30, 6, 60, 30, 88, 12);
      ctx.stroke();
      for (let i = 0; i < 40; i += 1) {
        ctx.fillStyle = `rgba(0,0,0,${0.15 + Math.random() * 0.2})`;
        ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 1, 1);
      }
    }
    return canvas.toDataURL('image/png');
  }

  const img = document.getElementById('captcha-img');
  img.src = draw(code);
  window.__renderCaptcha = (text) => {
    img.src = draw(text);
  };
})();
