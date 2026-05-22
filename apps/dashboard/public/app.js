async function api(path) {
  const res = await fetch('/api' + path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function fillTable(tbody, rows, keys) {
  tbody.innerHTML = rows
    .map(function (r) {
      return (
        '<tr>' +
        keys
          .map(function (k) {
            return '<td>' + escapeHtml(String(r[k] ?? '')) + '</td>';
          })
          .join('') +
        '</tr>'
      );
    })
    .join('');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseUtcDate(iso) {
  if (!iso) return null;
  const normalized = /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatTaipeiTime(isoUtc) {
  const d = parseUtcDate(isoUtc);
  if (!d) return String(isoUtc ?? '');
  return (
    new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d) + ' (UTC+8)'
  );
}

function formatHourAxisLabel(statHour) {
  const d = parseUtcDate(statHour);
  if (!d) return String(statHour ?? '');
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
  }).format(d);
}

function renderOverview(data) {
  const items = [
    [data.page_views_today, '今日 PV'],
    [data.clicks_today, '今日點擊'],
    [data.queue_depth, '佇列'],
    [data.dlq_count ?? 0, 'DLQ'],
  ];
  document.getElementById('overview').innerHTML = items
    .map(function (pair) {
      return (
        '<div class="card"><motion class="value">' +
        pair[0] +
        '</div><div class="label">' +
        pair[1] +
        '</div></div>'
      );
    })
    .join('')
    .replace(/<motion class="value">/g, '<div class="value">');
}

function renderVisitorCards(data) {
  const retentionValue =
    typeof data.retention_rate_pct === 'number'
      ? data.retention_rate_pct.toFixed(1) + '%'
      : '0%';
  const items = [
    [data.unique_visitors ?? 0, '不重複訪客（今日）', false],
    [data.new_visitors ?? 0, '新訪客（今日）', false],
    [data.returning_visitors ?? 0, '回訪客（今日）', false],
    [retentionValue, '7天留存率（7天前活躍 → 近7天再訪）', true],
  ];
  const html = items
    .map(function (triple) {
      const extraClass = triple[2] ? ' card-retention' : '';
      return (
        '<div class="card card-visitor' +
        extraClass +
        '"><div class="value">' +
        escapeHtml(String(triple[0])) +
        '</div><div class="label">' +
        escapeHtml(triple[1]) +
        '</div></div>'
      );
    })
    .join('');
  document.getElementById('overview').insertAdjacentHTML('beforeend', html);
}

let hourlyHitRegions = [];

function canvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}

function findHourlyHit(x, y) {
  for (let i = hourlyHitRegions.length - 1; i >= 0; i--) {
    const r = hourlyHitRegions[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

function setupHourlyChartHover(canvas) {
  if (canvas._hourlyHoverBound) return;
  canvas._hourlyHoverBound = true;
  const tooltip = document.getElementById('hourlyTooltip');
  const wrap = canvas.closest('.chart-wrap');

  canvas.addEventListener('mousemove', function (e) {
    if (!tooltip || !wrap) return;
    const pt = canvasPoint(canvas, e.clientX, e.clientY);
    const hit = findHourlyHit(pt.x, pt.y);
    if (!hit) {
      tooltip.hidden = true;
      canvas.style.cursor = 'crosshair';
      return;
    }
    canvas.style.cursor = 'pointer';
    tooltip.hidden = false;
    tooltip.innerHTML =
      escapeHtml(hit.time) +
      '<br><span style="color:#4a9eff">PV</span> ' +
      hit.pv +
      ' · <span style="color:#7ee787">點擊</span> ' +
      hit.clicks +
      '<br><strong>' +
      escapeHtml(hit.label) +
      '：' +
      hit.value +
      '</strong>';

    const rect = canvas.getBoundingClientRect();
    const left = ((hit.x + hit.w / 2) / canvas.width) * rect.width;
    const top = (hit.y / canvas.height) * rect.height;
    tooltip.style.left = left + 'px';
    tooltip.style.top = Math.max(4, top - 8) + 'px';
  });

  canvas.addEventListener('mouseleave', function () {
    if (tooltip) tooltip.hidden = true;
    canvas.style.cursor = 'crosshair';
  });
}

function drawHourly(hourly) {
  const canvas = document.getElementById('hourlyChart');
  if (!canvas || !hourly.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const padBottom = 40;
  const padTop = 8;
  const chartH = h - padBottom - padTop;
  const baseY = h - padBottom;

  ctx.fillStyle = '#0f1419';
  ctx.fillRect(0, 0, w, h);

  const max = Math.max(1, ...hourly.map((x) => Math.max(x.page_views, x.clicks)));
  const barW = w / hourly.length;
  hourlyHitRegions = [];

  hourly.forEach(function (row, i) {
    const pvH = (row.page_views / max) * chartH;
    const clH = (row.clicks / max) * chartH;
    const timeLabel = formatHourAxisLabel(row.stat_hour);
    const pvX = i * barW + 2;
    const pvW = barW / 2 - 4;
    const clX = i * barW + barW / 2;
    const clW = barW / 2 - 4;

    ctx.fillStyle = '#4a9eff';
    ctx.fillRect(pvX, baseY - pvH, pvW, pvH);
    ctx.fillStyle = '#7ee787';
    ctx.fillRect(clX, baseY - clH, clW, clH);

    const minHit = 8;
    if (row.page_views > 0) {
      const hitH = Math.max(pvH, minHit);
      hourlyHitRegions.push({
        x: pvX,
        y: baseY - hitH,
        w: pvW,
        h: hitH,
        label: 'PV',
        value: row.page_views,
        pv: row.page_views,
        clicks: row.clicks,
        time: timeLabel,
      });
    }
    if (row.clicks > 0) {
      const hitH = Math.max(clH, minHit);
      hourlyHitRegions.push({
        x: clX,
        y: baseY - hitH,
        w: clW,
        h: hitH,
        label: '點擊',
        value: row.clicks,
        pv: row.page_views,
        clicks: row.clicks,
        time: timeLabel,
      });
    }
  });

  ctx.strokeStyle = '#2a3548';
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  ctx.lineTo(w, baseY);
  ctx.stroke();

  const maxLabels = Math.max(4, Math.floor(w / 72));
  const labelStep = Math.max(1, Math.ceil(hourly.length / maxLabels));
  const labelIndices = [];
  for (let i = 0; i < hourly.length; i += labelStep) labelIndices.push(i);
  if (labelIndices[labelIndices.length - 1] !== hourly.length - 1) {
    labelIndices.push(hourly.length - 1);
  }

  ctx.fillStyle = '#8b9cb3';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  labelIndices.forEach(function (i) {
    const x = i * barW + barW / 2;
    ctx.fillText(formatHourAxisLabel(hourly[i].stat_hour), x, baseY + 6);
  });

  setupHourlyChartHover(canvas);
}

async function refresh() {
  try {
    const overview = await api('/overview?site_id=s_demo');
    renderOverview(overview);

    const visitors = await api('/visitors?site_id=s_demo');
    renderVisitorCards(visitors);

    const pages = await api('/pages?site_id=s_demo&days=7');
    fillTable(document.querySelector('#pages tbody'), pages.pages, ['page_path', 'views']);

    const clicks = await api('/clicks?site_id=s_demo&days=7');
    fillTable(document.querySelector('#clicks tbody'), clicks.clicks, ['track_id', 'clicks']);

    const recentRows = (overview.recent_events || []).map(function (r) {
      return {
        event_time_utc: formatTaipeiTime(r.event_time_utc),
        event_name: r.event_name,
        page_path: r.page_path,
        track_id: r.track_id,
        country_code: r.country_code,
        client_ip: r.client_ip,
      };
    });
    fillTable(document.querySelector('#recent tbody'), recentRows, [
      'event_time_utc',
      'event_name',
      'page_path',
      'track_id',
      'country_code',
      'client_ip',
    ]);

    const hourlyRes = await api('/hourly?site_id=s_demo');
    drawHourly(hourlyRes.hourly || []);
  } catch (e) {
    console.error(e);
  }
}

refresh();
setInterval(refresh, 10000);
