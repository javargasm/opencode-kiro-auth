export function getDashboardHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KIRO_GATEWAY // TELEMETRY</title>
  <style nonce="${nonce}">
    :root {
      --bg-color: #000501;
      --panel-bg: rgba(0, 20, 5, 0.4);
      --primary: #00ff41;
      --secondary: #00ffff;
      --text: #c0c0c0;
      --border: rgba(0, 255, 65, 0.3);
      --font-mono: "Fira Code", "JetBrains Mono", "Space Mono", Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-color);
      color: var(--primary);
      font-family: var(--font-mono);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 2rem;
      background-image: 
        linear-gradient(rgba(0, 255, 65, 0.03) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 255, 65, 0.03) 1px, transparent 1px);
      background-size: 20px 20px;
      overflow-x: hidden;
    }

    /* CRT Scanline Effect */
    body::after {
      content: " ";
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      right: 0;
      background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
      z-index: 2;
      background-size: 100% 2px, 3px 100%;
      pointer-events: none;
    }

    header {
      border-bottom: 2px solid var(--primary);
      padding-bottom: 1rem;
      margin-bottom: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      text-transform: uppercase;
      box-shadow: 0 4px 15px -10px var(--primary);
    }

    h1 {
      font-size: 2rem;
      letter-spacing: 2px;
      text-shadow: 0 0 10px rgba(0, 255, 65, 0.6);
      margin: 0;
    }

    .status-badge {
      font-size: 0.8rem;
      padding: 0.3rem 0.6rem;
      border: 1px solid var(--primary);
      background: rgba(0, 255, 65, 0.1);
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    button.status-badge {
      color: var(--primary);
      transition: all 0.2s ease;
    }

    button.status-badge:hover {
      background: rgba(0, 255, 65, 0.25);
      box-shadow: 0 0 10px rgba(0, 255, 65, 0.4);
    }

    .pulse {
      width: 8px;
      height: 8px;
      background-color: var(--primary);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--primary);
      animation: blink 1.5s infinite alternate;
    }

    .pulse.online {
      background-color: var(--primary);
      box-shadow: 0 0 10px var(--primary);
    }

    .pulse:not(.online) {
      background-color: #ff3b3b;
      box-shadow: 0 0 10px #ff3b3b;
    }

    .subtitle { font-size: 0.8rem; color: var(--text); margin-top: 5px; }
    .header-actions { display: flex; align-items: center; gap: 15px; }
    .status-button { cursor: pointer; font-family: var(--font-mono); outline: none; }
    .time-cell { color: var(--secondary); }
    .id-prefix { opacity: 0.5; }
    .effort-tag {
      border-color: rgba(0, 255, 255, 0.3);
      color: var(--secondary);
      background: rgba(0, 255, 255, 0.05);
    }
    .empty-tag { opacity: 0.3; }

    @keyframes blink {
      0% { opacity: 0.3; }
      100% { opacity: 1; box-shadow: 0 0 15px var(--primary); }
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }

    .metric-card {
      background: var(--panel-bg);
      border: 1px solid var(--border);
      padding: 1.5rem;
      position: relative;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .metric-card:hover {
      border-color: var(--primary);
      box-shadow: inset 0 0 20px rgba(0, 255, 65, 0.1);
    }

    /* Cyberpunk corner cuts */
    .metric-card::before {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      border-width: 0 15px 15px 0;
      border-style: solid;
      border-color: transparent var(--bg-color) transparent transparent;
    }

    .metric-label {
      font-size: 0.8rem;
      color: var(--secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 0.5rem;
    }

    .metric-value {
      font-size: 2.5rem;
      font-weight: bold;
      text-shadow: 0 0 10px rgba(0, 255, 65, 0.4);
    }

    .table-container {
      background: var(--panel-bg);
      border: 1px solid var(--border);
      flex: 1;
      overflow: auto;
      position: relative;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }

    th {
      position: sticky;
      top: 0;
      background: rgba(0, 15, 5, 0.95);
      padding: 1rem;
      font-size: 0.8rem;
      text-transform: uppercase;
      color: var(--secondary);
      border-bottom: 1px solid var(--primary);
      z-index: 1;
    }

    td {
      padding: 0.8rem 1rem;
      border-bottom: 1px solid rgba(0, 255, 65, 0.1);
      font-size: 0.9rem;
      color: var(--text);
    }

    tbody tr {
      transition: background 0.1s;
    }

    tbody tr:hover {
      background: rgba(0, 255, 65, 0.05);
      cursor: crosshair;
    }

    .tag {
      padding: 0.2rem 0.5rem;
      border: 1px solid var(--border);
      font-size: 0.75rem;
      background: rgba(0, 255, 65, 0.05);
      color: var(--primary);
    }

    .model-name { color: var(--secondary); }

    /* Glitch effect on incoming rows */
    @keyframes glitch {
      0% { transform: translate(0) }
      20% { transform: translate(-2px, 1px) }
      40% { transform: translate(-1px, -1px) }
      60% { transform: translate(2px, 1px) }
      80% { transform: translate(1px, -1px) }
      100% { transform: translate(0) }
    }

    .new-row {
      animation: glitch 0.3s cubic-bezier(.25, .46, .45, .94) both;
      background: rgba(0, 255, 65, 0.15);
    }

  </style>
</head>
<body>

  <header>
    <div>
      <h1>KIRO_GATEWAY</h1>
      <div class="subtitle">LOCAL PROXY // TELEMETRY NODE</div>
    </div>
    <div class="header-actions">
      <button id="toggle-currency" type="button" class="status-badge status-button">
        SHOW USD
      </button>
      <button id="auth-status" type="button" class="status-badge status-button">
        <div class="pulse"></div>
        <span id="auth-status-text">AUTH.REQUIRED</span>
      </button>
    </div>
  </header>

  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-label">TOTAL.REQUESTS</div>
      <div class="metric-value" id="val-requests">0</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">TOTAL.TOKENS</div>
      <div class="metric-value" id="val-tokens">0</div>
    </div>
    <div class="metric-card">
      <div class="metric-label" id="label-credits">EST.CREDITS</div>
      <div class="metric-value" id="val-credits">0.0</div>
    </div>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>TIME</th>
          <th>ID</th>
          <th>MODEL</th>
          <th>TYPE</th>
          <th>EFFORT</th>
          <th>IN.TOKENS</th>
          <th>OUT.TOKENS</th>
          <th id="header-credits">CREDITS</th>
        </tr>
      </thead>
      <tbody id="table-body">
        <!-- Rows injected here -->
      </tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    let lastRenderedIds = new Set();
    let gatewayToken = '';
    let fetchInFlight = false;
    let authPromptPending = false;

    function setAuthStatus(text, online = false) {
      document.getElementById('auth-status-text').textContent = text;
      const pulse = document.querySelector('#auth-status .pulse');
      pulse.classList.toggle('online', online);
    }

    function clearGatewayToken() {
      gatewayToken = '';
    }

    function promptForGatewayToken(message) {
      const supplied = window.prompt(message, '');
      if (typeof supplied !== 'string' || !supplied.trim()) {
        setAuthStatus('AUTH.REQUIRED');
        return false;
      }

      gatewayToken = supplied.trim();
      setAuthStatus('AUTH.CHECKING');
      return true;
    }

    function scheduleAuthPrompt(message) {
      if (authPromptPending) return;
      authPromptPending = true;
      // Yield once so an authentication failure is painted before re-prompting.
      setTimeout(() => {
        authPromptPending = false;
        if (promptForGatewayToken(message)) void fetchStats();
      }, 0);
    }

    function formatTime(timestamp) {
      const d = new Date(timestamp);
      if (Number.isNaN(d.getTime())) return 'INVALID';
      return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + d.getMilliseconds().toString().padStart(3, '0');
    }

    function finiteNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    }

    function appendCell(row, value, className) {
      const cell = document.createElement('td');
      if (className) cell.className = className;
      cell.textContent = String(value);
      row.append(cell);
      return cell;
    }

    let showUsd = false;

    function toggleCurrency() {
      showUsd = !showUsd;
      const btn = document.getElementById('toggle-currency');
      btn.textContent = showUsd ? 'SHOW CREDITS' : 'SHOW USD';
      
      const labelCard = document.getElementById('label-credits');
      labelCard.textContent = showUsd ? 'EST.COST (USD)' : 'EST.CREDITS';
      
      const headerTable = document.getElementById('header-credits');
      headerTable.textContent = showUsd ? 'COST (USD)' : 'CREDITS';
      
      fetchStats();
    }

    async function fetchStats() {
      if (fetchInFlight) return;
      if (!gatewayToken) {
        setAuthStatus('AUTH.REQUIRED');
        return;
      }

      fetchInFlight = true;
      try {
        const res = await fetch('/dashboard/api/stats', {
          method: 'GET',
          headers: { 'x-api-key': gatewayToken },
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (res.status === 401) {
          clearGatewayToken();
          setAuthStatus('AUTH.REJECTED');
          scheduleAuthPrompt('Telemetry authentication failed (401). Re-enter the local gateway token:');
          return;
        }
        if (!res.ok) throw new Error('Telemetry request failed: HTTP ' + res.status);
        const data = await res.json();
        setAuthStatus('SYS.ONLINE', true);
        
        document.getElementById('val-requests').textContent = String(finiteNumber(data.totalRequests));
        document.getElementById('val-tokens').textContent = finiteNumber(data.totalTokens).toLocaleString();
        
        if (showUsd) {
          document.getElementById('val-credits').textContent = '$' + finiteNumber(data.totalUsd).toFixed(1);
        } else {
          document.getElementById('val-credits').textContent = finiteNumber(data.totalCredits).toFixed(1);
        }

        const tbody = document.getElementById('table-body');
        const currentIds = new Set();
        const rows = Array.isArray(data.requests) ? data.requests : [];
        const fragment = document.createDocumentFragment();

        rows.forEach(request => {
          const id = typeof request.id === 'string' ? request.id : String(request.id ?? '');
          currentIds.add(id);
          const row = document.createElement('tr');
          if (!lastRenderedIds.has(id) && lastRenderedIds.size > 0) row.classList.add('new-row');

          appendCell(row, formatTime(request.timestamp), 'time-cell');
          const idCell = document.createElement('td');
          const idPrefix = document.createElement('span');
          idPrefix.className = 'id-prefix';
          idPrefix.textContent = 'msg_';
          idCell.append(idPrefix, document.createTextNode((id.split('_').pop() || '').slice(0, 8)));
          row.append(idCell);
          appendCell(row, request.model ?? '', 'model-name');

          const typeCell = document.createElement('td');
          const typeTag = document.createElement('span');
          typeTag.className = 'tag';
          typeTag.textContent = request.stream ? 'STREAM' : 'SYNC';
          typeCell.append(typeTag);
          row.append(typeCell);

          const effortCell = document.createElement('td');
          const effortTag = document.createElement('span');
          effortTag.className = request.effort ? 'tag effort-tag' : 'empty-tag';
          effortTag.textContent = request.effort ? String(request.effort).toUpperCase() : '-';
          effortCell.append(effortTag);
          row.append(effortCell);

          appendCell(row, finiteNumber(request.inputTokens).toLocaleString());
          appendCell(row, finiteNumber(request.outputTokens).toLocaleString());
          appendCell(
            row,
            showUsd
              ? '$' + finiteNumber(request.usd).toFixed(4)
              : finiteNumber(request.credits).toFixed(5),
          );
          fragment.append(row);
        });

        tbody.replaceChildren(fragment);
        lastRenderedIds = currentIds;

        // Remove new-row class after animation
        setTimeout(() => {
          document.querySelectorAll('.new-row').forEach(el => el.classList.remove('new-row'));
        }, 500);

      } catch (err) {
        setAuthStatus('TELEMETRY.ERROR');
        console.error("Telemetry connection lost", err);
      } finally {
        fetchInFlight = false;
      }
    }

    document.getElementById('auth-status').addEventListener('click', () => {
      scheduleAuthPrompt('Enter the local gateway token for protected telemetry:');
    });

    document.getElementById('toggle-currency').addEventListener('click', toggleCurrency);

    if (gatewayToken) {
      fetchStats();
    } else {
      scheduleAuthPrompt('Enter the local gateway token for protected telemetry:');
    }
    // Poll every 1.5s
    setInterval(fetchStats, 1500);
  </script>
</body>
</html>`;
}
