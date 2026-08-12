'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Qoder Proxy — Web Console App
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'dark';

function initTheme() {
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  currentTheme = prefersDark ? 'dark' : 'light';
  applyTheme();
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

function applyTheme() {
  document.body.classList.remove('dark', 'light');
  document.body.classList.add(currentTheme);
  var icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  }
}

// ─── Sidebar ───────────────────────────────────────────────────────────────────

function initSidebar() {
  var toggleBtn = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  if (!toggleBtn || !sidebar) return;

  function openSidebar() {
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  toggleBtn.addEventListener('click', function () {
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }
}

// ─── Tab Switching ─────────────────────────────────────────────────────────────

function initTabs() {
  var navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      switchTab(item.dataset.tab);
    });
  });
}

function switchTab(tab) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  // Update content
  document.querySelectorAll('.tab-content').forEach(function (c) {
    c.classList.toggle('active', c.id === tab);
  });

  // Close mobile sidebar
  var sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');
  var overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.classList.remove('open');

  // Load data
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'models') loadModels();
  if (tab === 'usage') loadUsage();

  // Live dashboard tiles only need polling while their tab is visible.
  if (tab === 'dashboard') startDashboardRefresh();
  else stopDashboardRefresh();
}

// ─── API helpers ───────────────────────────────────────────────────────────────

// The console is a browser client like any other, so when PROXY_API_KEY is set
// it must present the key too. Kept in localStorage so it survives reloads.
var API_KEY_STORAGE = 'qoder-proxy-api-key';

function getApiKey() {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) || '';
  } catch (_) {
    return '';
  }
}

function setApiKey(value) {
  try {
    if (value) {
      window.localStorage.setItem(API_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(API_KEY_STORAGE);
    }
  } catch (_) {
    // Private browsing modes can refuse storage; the key just won't persist.
  }
}

function api(path, options) {
  var opts = options || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  var key = getApiKey();
  if (key) {
    headers['Authorization'] = 'Bearer ' + key;
  }

  return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
    if (!res.ok) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          var message = (body.error && body.error.message) || 'Request failed: ' + res.status;
          if (res.status === 401) {
            message = 'Unauthorized. Set the proxy API key in the Config tab.';
          }
          throw new Error(message);
        });
    }
    return res.json();
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function loadDashboard() {
  var container = document.getElementById('dashboard-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  Promise.all([api('/'), api('/health'), api('/v1/models')])
    .then(function (data) {
      var info = data[0];
      var health = data[1];
      var models = data[2];
      var modelCount = models.data ? models.data.length : 0;

      var backendName = info.cli_backend === 'global' ? 'Global (qodercli)' : 'CN (qoderclicn)';
      var slots = health.slots || {};
      var slotMax = slots.max === null || slots.max === undefined ? '∞' : slots.max;
      var slotText = (slots.active || 0) + ' / ' + slotMax + ((slots.queued || 0) > 0 ? ' (+' + slots.queued + ' queued)' : '');

      container.innerHTML =
        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Status</div>' +
            '<div class="stat-value success"><span class="status-dot green"></span>Running</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">CLI Backend</div>' +
            '<div class="stat-value">' + escapeHtml(backendName) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Models</div>' +
            '<div class="stat-value">' + modelCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Uptime</div>' +
            '<div class="stat-value" id="dashboard-uptime">' + escapeHtml(formatUptime(health.uptime)) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">CLI Slots</div>' +
            '<div class="stat-value" id="dashboard-slots">' + escapeHtml(slotText) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Base URL</div>' +
            '<div class="stat-value muted">' + escapeHtml(window.location.host) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="alert info">Local protocol adapter running. Access the Web UI at <code>' + escapeHtml(window.location.origin + '/ui') + '</code></div>';
      container.dataset.loaded = '1';
      // This also runs from the API-key save handler while another tab may be
      // open, so only start polling when the dashboard is actually visible.
      var dashboardSection = document.getElementById('dashboard');
      if (dashboardSection && dashboardSection.classList.contains('active')) {
        startDashboardRefresh();
      }
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load dashboard: ' + escapeHtml(err.message) + '</div>';
    });
}

// Uptime and slot occupancy move while the server runs, so keep those two
// tiles fresh instead of showing a stale snapshot from first load.
var dashboardRefreshTimer = null;

function startDashboardRefresh() {
  if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = setInterval(function () {
    var dashboard = document.getElementById('dashboard');
    if (!dashboard || !dashboard.classList.contains('active')) return;
    api('/health')
      .then(function (health) {
        var uptimeEl = document.getElementById('dashboard-uptime');
        var slotsEl = document.getElementById('dashboard-slots');
        if (uptimeEl) uptimeEl.textContent = formatUptime(health.uptime);
        if (slotsEl && health.slots) {
          var slotMax = health.slots.max === null || health.slots.max === undefined ? '∞' : health.slots.max;
          slotsEl.textContent =
            (health.slots.active || 0) + ' / ' + slotMax +
            ((health.slots.queued || 0) > 0 ? ' (+' + health.slots.queued + ' queued)' : '');
        }
      })
      .catch(function () {});
  }, 15000);
}

function stopDashboardRefresh() {
  if (dashboardRefreshTimer) {
    clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
  }
}

// ─── Models ────────────────────────────────────────────────────────────────────

function loadModels() {
  var container = document.getElementById('models-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  api('/v1/models')
    .then(function (data) {
      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<div class="alert info">No models found.</div>';
        return;
      }

      var rows = data.data.map(function (m) {
        var reasoning = m.capabilities && m.capabilities.reasoning ? '<span style="color:var(--success)">&#9679;</span>' : '';
        var badge = m.effort_alias ? ' <span style="font-size:0.7rem;color:var(--text-secondary)">(effort alias)</span>' : '';
        return (
          '<tr>' +
            '<td><code>' + escapeHtml(m.id) + '</code></td>' +
            '<td>' + escapeHtml(m.name || '') + badge + '</td>' +
            '<td>' + reasoning + '</td>' +
          '</tr>'
        );
      }).join('');

      container.innerHTML =
        '<div class="glass card" style="padding:0;overflow:hidden;">' +
          '<table>' +
            '<thead><tr><th style="padding:0.75rem 1rem">ID</th><th style="padding:0.75rem 1rem">Name</th><th style="padding:0.75rem 1rem">Reasoning</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>';
      container.dataset.loaded = '1';
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load models: ' + escapeHtml(err.message) + '</div>';
    });
}

// ─── Chat Test ─────────────────────────────────────────────────────────────────

var chatMessages = [];
var isChatSending = false;

function addChatMessage(role, text, html) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (chatMessages.length === 0) {
    messagesEl.innerHTML = '';
  }
  var msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg ' + role;
  var avatar = role === 'user' ? '&#128100;' : '&#129302;';
  var content = html || escapeHtml(text);
  msgDiv.innerHTML =
    '<div class="chat-msg-avatar">' + avatar + '</div>' +
    '<div class="chat-msg-body">' + content + '</div>';
  messagesEl.appendChild(msgDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  chatMessages.push({ role: role, text: text });
}

function setChatLoading(loading) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (loading) {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'chat-loading';
    div.innerHTML =
      '<div class="chat-msg-avatar">&#129302;</div>' +
      '<div class="chat-msg-body"><span style="opacity:0.6">Thinking...</span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    var loadingEl = document.getElementById('chat-loading');
    if (loadingEl) loadingEl.remove();
  }
}

function initChat() {
  var sendBtn = document.getElementById('chat-send');
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');

  if (!sendBtn || !textarea) return;

  // Populate model dropdown
  api('/v1/models')
    .then(function (data) {
      if (!data.data || !modelSelect) return;
      data.data.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id + ' (' + (m.name || '') + ')';
        modelSelect.appendChild(opt);
      });
    })
    .catch(function () {});

  // Send on button click
  sendBtn.addEventListener('click', function () {
    doChat();
  });

  // Send on Enter (Shift+Enter for newline)
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doChat();
    }
  });
}

function doChat() {
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');
  var sendBtn = document.getElementById('chat-send');

  if (!textarea || !modelSelect) return;
  var message = textarea.value.trim();
  if (!message) return;
  if (isChatSending) return;

  isChatSending = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="send-icon">&#9670;</span>';

  // Show user message
  addChatMessage('user', message);

  // Clear textarea
  textarea.value = '';

  // Show loading
  setChatLoading(true);

  api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: modelSelect.value,
      messages: [{ role: 'user', content: message }],
    }),
  })
    .then(function (data) {
      setChatLoading(false);
      var content = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : 'No response content';
      addChatMessage('assistant', content);
    })
    .catch(function (err) {
      setChatLoading(false);
      addChatMessage('assistant', 'Error: ' + err.message);
    })
    .finally(function () {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span class="send-icon">&#8594;</span>';
      isChatSending = false;
    });
}

// ─── Config ────────────────────────────────────────────────────────────────────

function initApiKey() {
  var input = document.getElementById('api-key-input');
  var saveBtn = document.getElementById('api-key-save');
  var status = document.getElementById('api-key-status');
  if (!input || !saveBtn) return;

  input.value = getApiKey();

  function showStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.className = 'api-key-status ' + (kind || '');
  }

  if (getApiKey()) {
    showStatus('A key is saved in this browser.', 'ok');
  }

  saveBtn.addEventListener('click', function () {
    var value = input.value.trim();
    setApiKey(value);
    showStatus(
      value ? 'Key saved. Reloading console data…' : 'Key cleared.',
      value ? 'ok' : ''
    );
    // Re-fetch every tab with the new credential.
    ['dashboard-content', 'models-content', 'usage-content'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.dataset.loaded = '0';
    });
    loadDashboard();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
}

function initConfig() {
  document.querySelectorAll('.btn.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.dataset.target);
      if (!target) return;
      var text = target.textContent;
      navigator.clipboard.writeText(text).then(function () {
        var original = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = original; }, 1500);
      }).catch(function () {
        btn.textContent = 'Failed';
        setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
      });
    });
  });
}

// ─── Usage / Credits ─────────────────────────────────────────────────────────

var recentFilters = { endpoint: '', model: '', ok: '' };
var currentRecentRequests = [];
// Coalesces bursts of SSE events into one refresh pass.
var usageLiveUpdatePending = false;

function loadUsage() {
  var container = document.getElementById('usage-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">Loading...</div>';

  api('/usage/local')
    .then(function (data) {
      return api('/usage/hourly?hours=24').catch(function () { return { hours: [] }; }).then(function (hourly) {
        return { data: data, hourly: (hourly && hourly.hours) || [] };
      });
    })
    .then(function (result) {
      var data = result.data;
      var modelRows = '';
      if (data.requestsByModel && Object.keys(data.requestsByModel).length > 0) {
        var rows = Object.keys(data.requestsByModel).map(function (model) {
          return (
            '<tr>' +
              '<td><code>' + escapeHtml(model) + '</code></td>' +
              '<td>' + data.requestsByModel[model] + '</td>' +
            '</tr>'
          );
        }).join('');
        modelRows =
          '<div class="glass card" style="padding:0;overflow:hidden;">' +
            '<table>' +
              '<thead><tr><th style="padding:0.75rem 1rem">Model</th><th style="padding:0.75rem 1rem">Requests</th></tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>';
      }

      var lastReq = data.lastRequestAt
        ? new Date(data.lastRequestAt).toLocaleString()
        : 'Never';

      container.innerHTML =
        '<div class="alert warning">These are <strong>local estimates only</strong>. They do not represent official Qoder billing or remaining quota.</div>' +

        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Total Requests</div>' +
            '<div class="stat-value">' + data.totalRequests + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Today</div>' +
            '<div class="stat-value">' + data.requestsToday + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Errors</div>' +
            '<div class="stat-value ' + (data.errorCount > 0 ? 'error' : '') + '">' + data.errorCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Input Tokens</div>' +
            '<div class="stat-value">' + data.estimatedInputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Output Tokens</div>' +
            '<div class="stat-value">' + data.estimatedOutputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Est. Total Tokens</div>' +
            '<div class="stat-value">' + data.estimatedTotalTokens.toLocaleString() + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">Session Info</h3>' +
          '<table>' +
            '<tbody>' +
              '<tr><td>Started</td><td>' + new Date(data.startedAt).toLocaleString() + '</td></tr>' +
              '<tr><td>Last Request</td><td>' + lastReq + '</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">Requests — Last 24 Hours</h3>' +
          '<canvas id="usage-hourly-chart" width="860" height="150" style="width:100%;height:150px;"></canvas>' +
        '</div>' +

        modelRows +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">Active Requests</h3>' +
          '<div id="active-requests-container"><span style="color:var(--text-secondary)">Loading…</span></div>' +
        '</div>' +

        '<div class="glass card" style="padding:0;overflow:hidden;">' +
          '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;padding:0.75rem 1rem;">' +
            '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin:0">Recent Requests</h3>' +
            '<span style="flex:1"></span>' +
            '<select id="filter-endpoint" class="usage-filter">' +
              '<option value="">All endpoints</option>' +
              '<option value="chat">chat</option>' +
              '<option value="anthropic">anthropic</option>' +
            '</select>' +
            '<input id="filter-model" class="usage-filter" placeholder="Model…">' +
            '<select id="filter-ok" class="usage-filter">' +
              '<option value="">All statuses</option>' +
              '<option value="true">OK only</option>' +
              '<option value="false">Errors only</option>' +
            '</select>' +
            '<button class="btn copy" id="recent-refresh-btn">Refresh</button>' +
            '<button class="btn copy" id="recent-export-csv" title="Download filtered rows as CSV">CSV</button>' +
            '<button class="btn copy" id="recent-export-json" title="Download filtered rows as JSON">JSON</button>' +
          '</div>' +
          '<div style="overflow-x:auto;">' +
            '<table>' +
              '<thead><tr>' +
                '<th style="padding:0.75rem 1rem">Time</th>' +
                '<th style="padding:0.75rem 1rem">Endpoint</th>' +
                '<th style="padding:0.75rem 1rem">Model</th>' +
                '<th style="padding:0.75rem 1rem">Status</th>' +
                '<th style="padding:0.75rem 1rem">Latency</th>' +
                '<th style="padding:0.75rem 1rem">Mode</th>' +
                '<th style="padding:0.75rem 1rem">Tools</th>' +
                '<th style="padding:0.75rem 1rem">Tokens (in/out)</th>' +
                '<th style="padding:0.75rem 1rem">Msgs</th>' +
                '<th style="padding:0.75rem 1rem">Effort</th>' +
              '</tr></thead>' +
              '<tbody id="recent-requests-body"></tbody>' +
            '</table>' +
          '</div>' +
        '</div>' +

        '<button class="btn danger" id="reset-usage-btn">Reset Local Stats</button>';
      container.dataset.loaded = '1';

      drawHourlyChart(result.hourly);
      bindUsageControls();
      loadRecentRequests();
      loadActiveRequests();
      document.getElementById('reset-usage-btn').addEventListener('click', resetUsage);
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">Failed to load usage: ' + escapeHtml(err.message) + '</div>';
    });
}

function buildRecentQuery() {
  var params = ['limit=100'];
  if (recentFilters.endpoint) params.push('endpoint=' + encodeURIComponent(recentFilters.endpoint));
  if (recentFilters.model) params.push('model=' + encodeURIComponent(recentFilters.model));
  if (recentFilters.ok) params.push('ok=' + recentFilters.ok);
  return '/usage/recent?' + params.join('&');
}

function loadRecentRequests() {
  var tbody = document.getElementById('recent-requests-body');
  if (!tbody) return;

  api(buildRecentQuery())
    .then(function (recent) {
      currentRecentRequests = (recent && recent.requests) || [];
      renderRecentRows(tbody, currentRecentRequests);
    })
    .catch(function () {
      currentRecentRequests = [];
      renderRecentRows(tbody, []);
    });
}

function renderRecentRows(tbody, recent) {
  if (!recent.length) {
    tbody.innerHTML =
      '<tr><td colspan="10" style="padding:1rem;text-align:center;color:var(--text-secondary)">No requests recorded.</td></tr>';
    return;
  }
  tbody.innerHTML = recent.map(function (r, idx) {
    var statusHtml = r.ok
      ? '<span style="color:var(--success)">OK</span>'
      : '<span style="color:var(--danger,#f66)">' + escapeHtml(r.error || 'error') + '</span>';
    var modeHtml = r.stream
      ? '<span style="color:var(--text-secondary)">stream</span>'
      : '<span style="color:var(--text-secondary)">buffered</span>';
    var tokensHtml = (r.inputTokens || r.outputTokens)
      ? (r.inputTokens || 0) + ' / ' + (r.outputTokens || 0)
      : '-';
    return (
      '<tr data-idx="' + idx + '" style="cursor:pointer">' +
        '<td>' + escapeHtml(new Date(r.ts).toLocaleTimeString()) + '</td>' +
        '<td><code>' + escapeHtml(r.endpoint || '') + '</code></td>' +
        '<td><code>' + escapeHtml(r.model || '') + '</code></td>' +
        '<td>' + statusHtml + '</td>' +
        '<td>' + (r.ms || 0) + ' ms</td>' +
        '<td>' + modeHtml + '</td>' +
        '<td>' + (r.toolCount || 0) + '</td>' +
        '<td>' + tokensHtml + '</td>' +
        '<td>' + (r.messageCount != null ? r.messageCount : '-') + '</td>' +
        '<td>' + (r.reasoningEffort != null ? escapeHtml(String(r.reasoningEffort)) : '-') + '</td>' +
      '</tr>'
    );
  }).join('');
}

function loadActiveRequests() {
  var container = document.getElementById('active-requests-container');
  if (!container) return;

  api('/usage/active')
    .then(function (data) {
      var requests = (data && data.requests) || [];
      if (!requests.length) {
        container.innerHTML = '<span style="color:var(--text-secondary)">No requests in flight.</span>';
        return;
      }
      container.innerHTML =
        '<div style="overflow-x:auto;"><table>' +
          '<thead><tr><th style="padding:0.5rem 1rem">Endpoint</th><th style="padding:0.5rem 1rem">Model</th><th style="padding:0.5rem 1rem">Elapsed</th><th style="padding:0.5rem 1rem"></th></tr></thead>' +
          '<tbody>' +
          requests.map(function (r) {
            return (
              '<tr>' +
                '<td><code>' + escapeHtml(r.endpoint || '') + '</code></td>' +
                '<td><code>' + escapeHtml(r.model || '') + '</code></td>' +
                '<td>' + Math.round((r.elapsedMs || 0) / 1000) + 's</td>' +
                '<td><button class="btn copy cancel-active-btn" data-id="' + escapeHtml(r.id) + '">Cancel</button></td>' +
              '</tr>'
            );
          }).join('') +
          '</tbody></table></div>';

      container.querySelectorAll('.cancel-active-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          btn.disabled = true;
          api('/usage/active/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' })
            .then(function () {
              loadActiveRequests();
              loadRecentRequests();
            })
            .catch(function (err) {
              alert('Failed to cancel: ' + err.message);
              btn.disabled = false;
            });
        });
      });
    })
    .catch(function () {
      container.innerHTML = '<span style="color:var(--text-secondary)">Unavailable.</span>';
    });
}

function bindUsageControls() {
  var endpointSel = document.getElementById('filter-endpoint');
  var modelInput = document.getElementById('filter-model');
  var okSel = document.getElementById('filter-ok');
  if (endpointSel) {
    endpointSel.value = recentFilters.endpoint;
    endpointSel.addEventListener('change', function () {
      recentFilters.endpoint = endpointSel.value;
      loadRecentRequests();
    });
  }
  if (modelInput) {
    modelInput.value = recentFilters.model;
    modelInput.addEventListener('change', function () {
      recentFilters.model = modelInput.value.trim();
      loadRecentRequests();
    });
  }
  if (okSel) {
    okSel.value = recentFilters.ok;
    okSel.addEventListener('change', function () {
      recentFilters.ok = okSel.value;
      loadRecentRequests();
    });
  }

  var refreshBtn = document.getElementById('recent-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', loadRecentRequests);

  var csvBtn = document.getElementById('recent-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', function () { exportRecent('csv'); });
  var jsonBtn = document.getElementById('recent-export-json');
  if (jsonBtn) jsonBtn.addEventListener('click', function () { exportRecent('json'); });

  // Click a row for the full-field detail drawer.
  var tbody = document.getElementById('recent-requests-body');
  if (tbody) {
    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest ? e.target.closest('tr[data-idx]') : null;
      if (!tr) return;
      var entry = currentRecentRequests[Number(tr.dataset.idx)];
      if (entry) showRequestDetail(entry);
    });
  }
}

var EXPORT_FIELDS = ['id', 'ts', 'endpoint', 'model', 'ok', 'ms', 'error', 'stream',
  'toolCount', 'messageCount', 'inputTokens', 'outputTokens', 'toolCallDepth',
  'reasoningEffort', 'status'];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  var text = String(value);
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function exportRecent(format) {
  var rows = currentRecentRequests;
  var blob;
  var filename;
  if (format === 'csv') {
    var lines = [EXPORT_FIELDS.join(',')].concat(rows.map(function (r) {
      return EXPORT_FIELDS.map(function (f) { return csvEscape(r[f]); }).join(',');
    }));
    blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    filename = 'qoder-proxy-requests.csv';
  } else {
    blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    filename = 'qoder-proxy-requests.json';
  }
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function showRequestDetail(entry) {
  var fieldRows = EXPORT_FIELDS.map(function (field) {
    var value = entry[field];
    if (field === 'ts' && value) value = new Date(value).toLocaleString();
    if (field === 'stream' || field === 'ok') value = value ? 'true' : 'false';
    return (
      '<tr><td style="padding:0.4rem 1rem;color:var(--text-secondary)">' + field + '</td>' +
      '<td style="padding:0.4rem 1rem;word-break:break-all"><code>' +
      escapeHtml(value === null || value === undefined ? '-' : String(value)) +
      '</code></td></tr>'
    );
  }).join('');

  var overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.innerHTML =
    '<div class="detail-drawer glass card">' +
      '<div style="display:flex;align-items:center;margin-bottom:0.75rem">' +
        '<h3 style="font-size:0.875rem;margin:0">Request Details</h3>' +
        '<span style="flex:1"></span>' +
        '<button class="btn copy" id="detail-close-btn">Close</button>' +
      '</div>' +
      '<table><tbody>' + fieldRows + '</tbody></table>' +
    '</div>';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector('#detail-close-btn').addEventListener('click', function () {
    overlay.remove();
  });
  document.body.appendChild(overlay);
}

// Pure-canvas bar chart: one bar per hour, green portion OK, red portion
// errors. Fixed logical resolution, stretched to the card width via CSS.
function drawHourlyChart(hourly) {
  var canvas = document.getElementById('usage-hourly-chart');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');

  var byHour = {};
  (hourly || []).forEach(function (h) { byHour[h.hour] = h; });
  var buckets = [];
  var now = Date.now();
  for (var i = 23; i >= 0; i--) {
    var d = new Date(now - i * 3600000);
    var hour = d.toISOString().slice(0, 13);
    var real = byHour[hour];
    buckets.push({
      label: String(d.getHours()).padStart(2, '0') + ':00',
      requests: real ? real.requests : 0,
      ok: real ? real.ok : 0,
    });
  }
  var max = buckets.reduce(function (acc, b) { return Math.max(acc, b.requests); }, 0) || 1;

  var width = canvas.width;
  var height = canvas.height;
  var padBottom = 20;
  var chartHeight = height - padBottom;
  var barWidth = width / buckets.length;

  ctx.clearRect(0, 0, width, height);
  buckets.forEach(function (b, idx) {
    if (!b.requests) return;
    var totalHeight = (b.requests / max) * (chartHeight - 10);
    var okHeight = (b.ok / b.requests) * totalHeight;
    var x = idx * barWidth + barWidth * 0.2;
    var w = barWidth * 0.6;
    // Errors stack on top of the OK portion.
    ctx.fillStyle = 'rgba(244, 63, 94, 0.85)';
    ctx.fillRect(x, chartHeight - totalHeight, w, totalHeight - okHeight);
    ctx.fillStyle = 'rgba(52, 211, 153, 0.85)';
    ctx.fillRect(x, chartHeight - okHeight, w, okHeight);
  });

  ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  buckets.forEach(function (b, idx) {
    if (idx % 4 === 0) ctx.fillText(b.label, idx * barWidth + barWidth / 2, height - 5);
  });
}

// ─── Live event stream ──────────────────────────────────────────────────────

var eventSource = null;

// The server pushes a request_completed event for every finished request; the
// Usage page refreshes its tables live while it is visible.
function initEventStream() {
  if (eventSource || typeof EventSource === 'undefined') return;
  eventSource = new EventSource('/events');
  eventSource.addEventListener('request_completed', function () {
    var usageSection = document.getElementById('usage');
    var container = document.getElementById('usage-content');
    if (!usageSection || !container) return;
    if (!usageSection.classList.contains('active') || container.dataset.loaded !== '1') return;
    if (usageLiveUpdatePending) return;
    usageLiveUpdatePending = true;
    setTimeout(function () {
      usageLiveUpdatePending = false;
      loadRecentRequests();
      loadActiveRequests();
    }, 500);
  });
}

function resetUsage() {
  if (!confirm('Reset all local usage statistics? This cannot be undone.')) return;

  api('/usage/reset-local', { method: 'POST' })
    .then(function () {
      document.getElementById('usage-content').dataset.loaded = '0';
      loadUsage();
    })
    .catch(function (err) {
      alert('Failed to reset: ' + err.message);
    });
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  if (!seconds && seconds !== 0) return '-';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + 'm ' + s + 's';
  return s + 's';
}

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  initSidebar();
  initTabs();
  initChat();
  initConfig();
  initApiKey();
  initEventStream();

  // Theme toggle
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  // Load initial tab
  loadDashboard();
});
