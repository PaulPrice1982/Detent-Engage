(async () => {
    const dot = document.getElementById('dot');
    const text = document.getElementById('status-text');
    const detail = document.getElementById('status-detail');
    const started = performance.now();
    try {
      const response = await fetch('/health', { headers: { accept: 'application/json' } });
      const elapsed = Math.round(performance.now() - started);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const body = await response.json().catch(() => ({}));
      dot.className = 'dot up';
      text.textContent = 'Service healthy';
      detail.textContent = (body.version ? 'v' + body.version + ' · ' : '') + elapsed + ' ms';
    } catch (error) {
      dot.className = 'dot down';
      text.textContent = 'Service unreachable';
      detail.textContent = String(error && error.message ? error.message : error);
    }
  })();
